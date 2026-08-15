// dsh-update-checker — Host half.
// 路由：
//   GET  /dsh-update-checker/status.json — 检查结果（npm 最新版 vs 本地已装版，
//                                          含 suppressUpToDate 持久化标记）
//   POST /dsh-update-checker/suppress    — 持久化"不再提示已是最新版本"标记
//   POST /dsh-update-checker/update      — 完整更新：备份 → 部署目录
//                                          `npm install @deepseek-ai/dsh@latest`
//                                          → 同步 @deepseek-ai 生态包到
//                                            $DSH_HOME/profiles/node_modules
//                                          （body 可带 dry:true 预览不执行）
//   POST /dsh-update-checker/restart     — 重启 dsh web 服务（分离进程执行：
//                                          终止监听端口进程 → 重新拉起 start-dsh.cmd）
// 写操作路由均要求 body 携带 { confirm: true }，防止误触发。
//
// 纯 ESM、无构建步骤；仅依赖 Node 内置模块。
import { readFile, writeFile, mkdir, copyFile, cp, readdir, realpath } from "node:fs/promises";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { exec, spawn } from "node:child_process";
import { promisify } from "node:util";

const execP = promisify(exec);

const NPM_URL = "https://registry.npmjs.org/@deepseek-ai/dsh/latest";
const PACKAGE = "@deepseek-ai/dsh";
// 端口不在模块层硬编码：重启时从运行时的 webServer.port 读取（跨机器自适应）。

// "不再提示已是最新版本"标记的持久化位置（DSH 用户数据目录）
const STATE_FILE = join(homedir(), ".dsh", "dsh-update-checker-state.json");

// 运行中的 Web 应用从 $DSH_HOME/profiles/node_modules 解析（clientModules 用
// createRequire(profile 组合目录) 解析包、伺服 profile 副本，已实测）。本机该目录的
// @deepseek-ai 包全部是 junction（指向部署目录 node_modules，已实测 195/195），
// 因此部署目录的 npm install 会穿透更新 Web 应用所用的一切——更新本身是完整的。
// 备份用于回滚安全；"同步到 profile"仅作为防御性兜底（对 junction 包 realpath 相同
// 会跳过；只覆盖未来可能的非 junction 真实副本场景）。
const PROFILE_NODE_MODULES = join(homedir(), ".dsh", "profiles", "node_modules");
// 更新前备份目录（lockfile + 两套 @deepseek-ai 版本清单，可回滚）
const BACKUP_DIR = join(homedir(), ".dsh", "dsh-update-checker-backups");

// 部署根目录候选：默认取进程 cwd（各机器自己的 start 脚本通常会 cd 到部署目录）；
// 仅当从非部署目录启动 dsh 时才需要把第二个候选改成该机器的实际部署目录。
const DEPLOY_ROOT_CANDIDATES = [process.cwd(), "D:\\应用\\DeepSeek-Harness"];

const UPDATE_COMMAND = `npm install ${PACKAGE}@latest`;

// 构建重启辅助脚本（等 2 秒 → 杀掉 port 监听进程 → 拉起部署根的 start-dsh.cmd）。
// 所有参数运行时推导（port 来自 webServer、部署根来自 findDeployRoot），跨机器自适应；
// 用全路径调用 PowerShell 与 taskkill（PATH 损坏环境仍可靠）。
// 注意：spawn 时**不能**用 detached:true（Windows 上 detached+stdio ignore+windowsHide
// 会让 powershell 启动后立即 exit 0 而命令从不执行，已实测）；taskkill /F 不带 /T 只杀
// 目标 PID，本助手进程在服务死后仍会存活并完成 relaunch。
function buildRestartHelper(deployRoot, port) {
  const launcher = join(deployRoot, "start-dsh.cmd");
  const log = join(homedir(), ".dsh", "dsh-update-checker-restart.log");
  return [
    `'restart-start ' + (Get-Date -Format 'HH:mm:ss') | Out-File -FilePath '${log}' -Append -Encoding utf8`,
    `Start-Sleep -Seconds 2`,
    `$conn = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue`,
    `if ($conn) { $pids = $conn | Select-Object -ExpandProperty OwningProcess -Unique; foreach ($p in $pids) { & 'C:\\Windows\\System32\\taskkill.exe' /PID $p /F 2>&1 | Out-Null } }`,
    `Start-Sleep -Seconds 1`,
    `Start-Process -FilePath '${launcher}' -WorkingDirectory '${deployRoot}' -WindowStyle Hidden`,
    `'restart-done' | Out-File -FilePath '${log}' -Append -Encoding utf8`,
  ].join("; ");
}

let updateInFlight = false;
let restartScheduled = false;

// 读取"不再提示已是最新版本"标记；文件缺失/损坏视为 false。
async function readSuppressUpToDate() {
  try {
    const data = JSON.parse(await readFile(STATE_FILE, "utf8"));
    return data && data.suppressUpToDate === true;
  } catch {
    return false;
  }
}

// 持久化/清除"不再提示已是最新版本"标记。
async function writeSuppressUpToDate(value) {
  try {
    await mkdir(join(homedir(), ".dsh"), { recursive: true });
    await writeFile(STATE_FILE, JSON.stringify({ suppressUpToDate: !!value }, null, 2), "utf8");
    return true;
  } catch {
    return false;
  }
}

function parseVersion(v) {
  const m = String(v || "").trim().match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!m) return null;
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split(".") : [] };
}

// 语义化版本比较：返回 1/0/-1（a > b / 相等 / a < b）。
// 正确处理 rc/beta 等预发布号（如 0.1.0 > 0.1.0-rc.6；rc.10 > rc.9）。
function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa.core[i] !== pb.core[i]) return pa.core[i] > pb.core[i] ? 1 : -1;
  }
  if (pa.pre.length === 0 && pb.pre.length === 0) return 0;
  if (pa.pre.length === 0) return 1;
  if (pb.pre.length === 0) return -1;
  const n = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < n; i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) return Number(x) > Number(y) ? 1 : -1;
    if (nx) return -1; // 数字标识符 < 字母标识符（semver 规则）
    if (ny) return 1;
    return x > y ? 1 : -1;
  }
  return 0;
}

// 找到部署根目录：第一个能读到 dsh 包 package.json 的候选；都失败返回 null。
async function findDeployRoot() {
  for (const root of DEPLOY_ROOT_CANDIDATES) {
    try {
      await readFile(resolve(root, `node_modules/${PACKAGE}/package.json`), "utf8");
      return root;
    } catch {
      // 该候选不可读，尝试下一个
    }
  }
  return null;
}

// 读取本机已装 @deepseek-ai/dsh 的版本号；失败返回 null。
async function readInstalledVersion() {
  const root = await findDeployRoot();
  if (!root) return null;
  try {
    const pkg = JSON.parse(
      await readFile(resolve(root, `node_modules/${PACKAGE}/package.json`), "utf8")
    );
    return typeof pkg.version === "string" && pkg.version ? pkg.version : null;
  } catch {
    return null;
  }
}

// 读取某 node_modules 下 @deepseek-ai 各包的版本 → { [包名]: version }。
// 注意：profile 侧 @deepseek-ai 包是 junction（指向部署目录），Dirent.isDirectory()
// 对 junction 返回 false，不能据此过滤——统一尝试读 package.json，失败即跳过。
async function readEcoVersions(baseDir) {
  const map = {};
  const root = join(baseDir, "@deepseek-ai");
  try {
    const names = await readdir(root, { withFileTypes: true });
    for (const n of names) {
      try {
        const pj = JSON.parse(await readFile(join(root, n.name, "package.json"), "utf8"));
        if (typeof pj.version === "string" && pj.version) map[n.name] = pj.version;
      } catch {
        // 非目录或不可读，跳过
      }
    }
  } catch {
    // @deepseek-ai 目录不存在
  }
  return map;
}

// 更新前备份：部署 lockfile + 两套 @deepseek-ai 版本清单。返回备份目录。
async function backupForUpdate(deployRoot) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = join(BACKUP_DIR, stamp);
  await mkdir(dir, { recursive: true });
  try {
    await copyFile(join(deployRoot, "package-lock.json"), join(dir, "package-lock.json"));
  } catch {
    // lockfile 缺失也继续
  }
  await writeFile(
    join(dir, "versions-deploy.json"),
    JSON.stringify(await readEcoVersions(join(deployRoot, "node_modules")), null, 2),
    "utf8"
  );
  await writeFile(
    join(dir, "versions-profile.json"),
    JSON.stringify(await readEcoVersions(PROFILE_NODE_MODULES), null, 2),
    "utf8"
  );
  return dir;
}

// 计算同步计划：部署侧有、而 profile 侧缺失或版本不同的 @deepseek-ai 包。
// 只从部署侧拷贝，绝不删除 profile 独有的包（如 dshcost / dsh-update-checker）。
async function planSync(deployRoot) {
  const deploy = await readEcoVersions(join(deployRoot, "node_modules"));
  const profile = await readEcoVersions(PROFILE_NODE_MODULES);
  const todo = [];
  for (const [name, ver] of Object.entries(deploy)) {
    if (profile[name] !== ver) {
      todo.push({ name, from: profile[name] || null, to: ver });
    }
  }
  return { deploy, profile, todo };
}

// 执行同步：把计划内的包从部署侧拷贝到 profile 侧。返回逐包结果。
// junction 情况下 src 与 dst 是同一物理文件（realpath 相同）——跳过，避免自拷贝。
async function runSync(deployRoot, todo) {
  const results = [];
  for (const item of todo) {
    const src = join(deployRoot, "node_modules", "@deepseek-ai", item.name);
    const dst = join(PROFILE_NODE_MODULES, "@deepseek-ai", item.name);
    try {
      const [rpSrc, rpDst] = await Promise.all([realpath(src), realpath(dst)]);
      if (rpSrc === rpDst) {
        results.push({ name: item.name, from: item.to, to: item.to, ok: true, skipped: "same-file (junction)" });
        continue;
      }
      await cp(src, dst, { recursive: true, force: true });
      results.push({ name: item.name, from: item.from, to: item.to, ok: true });
    } catch (err) {
      results.push({
        name: item.name,
        from: item.from,
        to: item.to,
        ok: false,
        error: String(err && err.message ? err.message : err),
      });
    }
  }
  return results;
}

// 从 npm registry 查询最新版本。
async function fetchLatestVersion() {
  const res = await fetch(NPM_URL, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error("npm registry HTTP " + res.status);
  const data = await res.json();
  if (typeof data.version !== "string" || !data.version) {
    throw new Error("npm registry: no version field");
  }
  return data.version;
}

async function runCheck() {
  const report = {
    checkedAt: Date.now(),
    latest: null,
    installed: null,
    hasUpdate: false,
    latestError: null,
    installedError: null,
  };
  try {
    report.latest = await fetchLatestVersion();
  } catch (err) {
    report.latestError = String(err && err.message ? err.message : err);
  }
  try {
    report.installed = await readInstalledVersion();
  } catch (err) {
    report.installedError = String(err && err.message ? err.message : err);
  }
  if (report.latest && report.installed) {
    report.hasUpdate = compareVersions(report.latest, report.installed) > 0;
  }
  report.suppressUpToDate = await readSuppressUpToDate();
  return report;
}

// 读取请求 JSON body（空 body 视为 {}；超大或非法 body 返回标记）。
function readJsonBody(req) {
  return new Promise((resolveBody) => {
    let chunks = "";
    req.on("data", (c) => {
      if (chunks.length < 1e6) chunks += c;
    });
    req.on("end", () => {
      if (!chunks.trim()) return resolveBody({});
      try {
        resolveBody(JSON.parse(chunks));
      } catch {
        resolveBody({ parseError: true });
      }
    });
    req.on("error", () => resolveBody({}));
  });
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function truncate(s, max) {
  const str = s == null ? "" : String(s);
  return str.length <= max ? str : str.slice(0, max) + "\n…(truncated)";
}

export default {
  name: "dsh-update-checker",
  apply(ctx) {
    // 必须用 ctx.inject 等待 webServer 服务就绪后再注册路由：进程启动时该行可能
    // 先于 webServer 激活，直接 ctx.get("webServer") 会拿到 undefined 而静默跳过。
    // 无 HTTP 服务的组合（如 headless 精简装配）中 inject 永不触发，保持无影响。
    ctx.inject(["webServer"], (webCtx) => {
      const webServer = webCtx.webServer;

      webServer.register({
        kind: "exact",
        path: "/dsh-update-checker/status.json",
        handler: async (req, res) => {
          let status;
          try {
            status = await runCheck();
          } catch (err) {
            status = {
              checkedAt: Date.now(),
              latest: null,
              installed: null,
              hasUpdate: false,
              suppressUpToDate: false,
              error: String(err && err.message ? err.message : err),
            };
          }
          json(res, 200, status);
        },
      });

      // 持久化"不再提示已是最新版本"（仅抑制"已是最新版本"横幅，不抑制更新横幅）
      webServer.register({
        kind: "exact",
        path: "/dsh-update-checker/suppress",
        handler: async (req, res) => {
          const body = await readJsonBody(req);
          if (body && body.parseError) return json(res, 400, { ok: false, error: "invalid JSON body" });
          if (body && body.confirm !== true) return json(res, 400, { ok: false, error: "confirm required" });
          const ok = await writeSuppressUpToDate(true);
          return json(res, ok ? 200 : 500, ok ? { ok: true } : { ok: false, error: "failed to write state" });
        },
      });

      // 完整更新：备份 → 部署目录 npm install → 同步 @deepseek-ai 生态到 profile。
      // body 可带 dry:true 预览（不执行任何写入），供检查与测试。
      webServer.register({
        kind: "exact",
        path: "/dsh-update-checker/update",
        handler: async (req, res) => {
          const body = await readJsonBody(req);
          if (body && body.parseError) return json(res, 400, { ok: false, error: "invalid JSON body" });
          if (body && body.confirm !== true) return json(res, 400, { ok: false, error: "confirm required" });
          if (updateInFlight) return json(res, 409, { ok: false, error: "update already running" });
          const root = await findDeployRoot();
          if (!root) return json(res, 500, { ok: false, error: "deployment root not found" });
          const dry = body && body.dry === true;
          updateInFlight = true;
          try {
            if (dry) {
              const plan = await planSync(root);
              return json(res, 200, {
                ok: true,
                dry: true,
                installed: await readInstalledVersion(),
                syncPlan: plan.todo,
              });
            }
            const backupDir = await backupForUpdate(root);
            const { stdout, stderr } = await execP(UPDATE_COMMAND, {
              cwd: root,
              timeout: 600000, // 10 分钟上限
              maxBuffer: 8 * 1024 * 1024,
              windowsHide: true,
            });
            // 安装完成后重新计算同步计划（覆盖 npm install 实际改动的包），再执行同步
            const plan = await planSync(root);
            const synced = await runSync(root, plan.todo);
            const failed = synced.filter((s) => !s.ok);
            const installed = await readInstalledVersion();
            // 更新成功后清除"不再提示"标记：下次启动重新显示"已是最新版本"横幅
            await writeSuppressUpToDate(false);
            return json(res, 200, {
              ok: true,
              installed,
              backupDir,
              synced: synced.map((s) => (s.ok ? s.name : `${s.name} (FAILED: ${s.error})`)),
              syncFailed: failed.length,
              output: truncate((stdout || "") + (stderr || ""), 2000),
            });
          } catch (err) {
            const detail = String(
              err && err.stderr ? err.stderr : err && err.message ? err.message : err
            );
            return json(res, 500, { ok: false, error: truncate(detail, 2000), code: err && err.code });
          } finally {
            updateInFlight = false;
          }
        },
      });

      // 重启服务：执行辅助脚本（先返回，随后本进程会被终止）。
      // 端口与部署根均运行时推导（webServer.port / findDeployRoot），跨机器自适应。
      webServer.register({
        kind: "exact",
        path: "/dsh-update-checker/restart",
        handler: async (req, res) => {
          const body = await readJsonBody(req);
          if (body && body.parseError) return json(res, 400, { ok: false, error: "invalid JSON body" });
          if (body && body.confirm !== true) return json(res, 400, { ok: false, error: "confirm required" });
          if (restartScheduled) return json(res, 409, { ok: false, error: "restart already scheduled" });
          const root = await findDeployRoot();
          if (!root) return json(res, 500, { ok: false, error: "deployment root not found" });
          const port = typeof webServer.port === "number" ? webServer.port : 3080;
          restartScheduled = true;
          try {
            // 注意：不能带 detached:true（Windows 上会使 powershell 启动即退、命令不执行，
            // 已实测）。taskkill /F 不带 /T，本助手进程在服务死后仍存活完成 relaunch。
            const child = spawn(
              "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
              ["-NoProfile", "-NonInteractive", "-Command", buildRestartHelper(root, port)],
              { stdio: "ignore", windowsHide: true }
            );
            child.unref();
            return json(res, 200, { ok: true, message: "restart scheduled" });
          } catch (err) {
            restartScheduled = false;
            return json(res, 500, { ok: false, error: String(err && err.message ? err.message : err) });
          }
        },
      });
    });
  },
};
