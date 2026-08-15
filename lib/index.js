// dsh-update-checker — Host half（v1.1.0，已合并 dsh-plugin-checker 的插件更新检测能力）。
// 路由：
//   GET  /dsh-update-checker/status.json — 主程序检查结果（npm 最新版 vs 本地已装版，
//                                          含 suppressUpToDate 持久化标记）
//   POST /dsh-update-checker/suppress    — 持久化"不再提示已是最新版本"标记
//   POST /dsh-update-checker/update      — 完整更新主程序：备份 → 部署目录
//                                          `npm install @deepseek-ai/dsh@latest`
//                                          → 同步 @deepseek-ai 生态包到 profile
//   POST /dsh-update-checker/restart     — 重启 dsh web 服务（两级 spawn 脱钩 +
//                                          看门狗，独立孙进程跑 restart-watchdog.ps1）
//   GET  /dsh-update-checker/plugins.json     — 扫描第三方(非内置)插件 + npm 版本对比
//   POST /dsh-update-checker/plugin-update    — 更新指定插件（临时目录安装 + 拷贝）
// 写操作路由均要求 body 携带 { confirm: true }，防止误触发。
//
// 纯 ESM、无构建步骤；仅依赖 Node 内置模块。
// 布局无关（不假设 junction）：profile 的 @deepseek-ai/* 本机是 junction（省 C 盘），
// 其它机器可能是真实拷贝。插件判定用"组合行 + dsh 字段"双源；更新用临时目录安装 + 拷贝，
// 绝不直接对 profiles 执行 npm（R26：会清空 node_modules）。

import { readFile, writeFile, mkdir, copyFile, cp, readdir, realpath, lstat, rm, mkdtemp } from "node:fs/promises";
import { resolve, join, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, tmpdir } from "node:os";
import { exec, spawn } from "node:child_process";
import { promisify } from "node:util";

const execP = promisify(exec);

const NPM_URL = "https://registry.npmjs.org/@deepseek-ai/dsh/latest";
const REGISTRY = "https://registry.npmjs.org";
const PACKAGE = "@deepseek-ai/dsh";
const SELF = "dsh-update-checker";
const CHECK_TTL_MS = 5 * 60 * 1000;

// "不再提示已是最新版本"标记的持久化位置（DSH 用户数据目录）
const STATE_FILE = join(homedir(), ".dsh", "dsh-update-checker-state.json");

// profile 侧 node_modules（插件实际安装位置）；组合行（激活插件权威清单）
const PROFILE_NODE_MODULES = join(homedir(), ".dsh", "profiles", "node_modules");
const COMPOSITION_FILE = join(homedir(), ".dsh", "profiles", "web", "cordis.patch.yml");
// 更新前备份目录（lockfile + 两套 @deepseek-ai 版本清单，可回滚）
const BACKUP_DIR = join(homedir(), ".dsh", "dsh-update-checker-backups");

// 部署根目录候选：默认取进程 cwd（各机器自己的 start 脚本通常会 cd 到部署目录）；
// 仅当从非部署目录启动 dsh 时才需要把第二个候选改成该机器的实际部署目录。
const DEPLOY_ROOT_CANDIDATES = [process.cwd(), "D:\\应用\\DeepSeek-Harness"];

const UPDATE_COMMAND = `npm install ${PACKAGE}@latest`;

let updateInFlight = false;
let restartScheduled = false;
let pluginUpdateInFlight = false;

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
// 注意：profile 侧 @deepseek-ai 包可能是指向部署目录的 junction，Dirent.isDirectory()
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

// ── npm 最新版本查询（按包名，带 5 分钟 TTL 缓存，fresh 绕过）────────────
let npmLatestCache = new Map();

async function fetchNpmLatest(name, force) {
  const now = Date.now();
  const hit = npmLatestCache.get(name);
  if (!force && hit && now - hit.at < CHECK_TTL_MS) return hit.value;
  const res = await fetch(`${REGISTRY}/${encodeURIComponent(name)}/latest`, {
    headers: { accept: "application/json" },
  });
  if (res.status === 404) {
    throw Object.assign(new Error("package not on npm registry"), { code: "ENOTFOUND" });
  }
  if (!res.ok) throw new Error("npm registry HTTP " + res.status);
  const data = await res.json();
  if (typeof data.version !== "string" || !data.version) {
    throw new Error("npm registry: no version field");
  }
  npmLatestCache.set(name, { value: data.version, at: Date.now() });
  return data.version;
}

// ── 主程序检查 ─────────────────────────────────────────────────────────
async function runCheck(force) {
  const report = {
    checkedAt: Date.now(),
    latest: null,
    installed: null,
    hasUpdate: false,
    latestError: null,
    installedError: null,
  };
  try {
    report.latest = await fetchNpmLatest(PACKAGE, force);
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

// ── 插件扫描（组合行 + dsh 字段双源，布局无关）──────────────────────────
async function readCompositionPluginNames() {
  const names = new Set();
  try {
    const raw = await readFile(COMPOSITION_FILE, "utf8");
    const re = /^\s*name:\s*['"]([^'"]+)['"]\s*$/gm;
    let m;
    while ((m = re.exec(raw))) names.add(m[1].trim());
  } catch {
    // 组合文件缺失/不可读：退化为仅 dsh 字段判定
  }
  return names;
}

// 判定目录是否为"社区插件"：组合行命中（目录名）或有 dsh 字段，且非官方。
// 注意：不排除自己（SELF）——允许插件自我更新（临时目录安装 + 拷贝，安全）。
async function classifyPlugin(dir, dirName, composition) {
  if (!dirName) return null;
  if (dirName.startsWith("@deepseek-ai/")) return null; // 排除官方
  let pkg = null;
  try {
    pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
  } catch {
    // package.json 不可读：仅当组合行命中时收录（无版本信息）
    if (composition.has(dirName)) return { name: dirName, installed: null, dir };
    return null;
  }
  const isComposition = composition.has(dirName);
  const hasDsh = Boolean(pkg && pkg.dsh);
  if (!isComposition && !hasDsh) return null; // 纯依赖
  const name = pkg && typeof pkg.name === "string" && pkg.name ? pkg.name : dirName;
  return {
    name,
    installed: pkg && typeof pkg.version === "string" && pkg.version ? pkg.version : null,
    dir,
  };
}

async function scanInstalledPlugins() {
  const found = [];
  const seen = new Set(); // 按实际目录去重
  const composition = await readCompositionPluginNames();
  let entries;
  try {
    entries = await readdir(PROFILE_NODE_MODULES, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name === ".bin") continue;
    if (e.name.startsWith("@")) {
      if (e.name === "@deepseek-ai") continue; // 官方内置
      let subs;
      try {
        subs = await readdir(join(PROFILE_NODE_MODULES, e.name), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const s of subs) {
        if (!s.isDirectory()) continue;
        const dir = join(PROFILE_NODE_MODULES, e.name, s.name);
        const pkg = await classifyPlugin(dir, `${e.name}/${s.name}`, composition);
        if (pkg && !seen.has(dir)) { seen.add(dir); found.push(pkg); }
      }
    } else {
      const dir = join(PROFILE_NODE_MODULES, e.name);
      const pkg = await classifyPlugin(dir, e.name, composition);
      if (pkg && !seen.has(dir)) { seen.add(dir); found.push(pkg); }
    }
  }
  return found;
}

async function runPluginCheck(force) {
  const plugins = await scanInstalledPlugins();
  const list = [];
  for (const p of plugins) {
    const item = {
      name: p.name,
      installed: p.installed,
      latest: null,
      hasUpdate: false,
      onNpm: false,
      error: null,
    };
    try {
      item.latest = await fetchNpmLatest(p.name, force);
      item.onNpm = true;
      if (item.installed && item.latest) {
        item.hasUpdate = compareVersions(item.latest, item.installed) > 0;
      }
    } catch (err) {
      if (err && err.code === "ENOTFOUND") {
        item.onNpm = false;
        item.error = "not on npm registry";
      } else {
        item.error = String(err && err.message ? err.message : err);
      }
    }
    list.push(item);
  }
  list.sort((a, b) => (a.hasUpdate === b.hasUpdate ? a.name.localeCompare(b.name) : a.hasUpdate ? -1 : 1));
  return { checkedAt: Date.now(), plugins: list };
}

// ── 插件更新：临时目录安装 + 拷贝（布局无关，不破坏 profiles 其它包）─────
async function exists(p) {
  return lstat(p).then(() => true).catch(() => false);
}

async function updatePlugin(name) {
  const installed = await scanInstalledPlugins();
  const target = installed.find((p) => p.name === name);
  if (!target || !target.dir) {
    throw Object.assign(new Error(`plugin not installed or not updatable: ${name}`), { code: "EINVALID" });
  }
  const tmp = await mkdtemp(join(tmpdir(), "dsh-update-checker-"));
  try {
    const cmd = `npm install ${name}@latest --prefix "${tmp}" --no-save --package-lock=false --registry ${REGISTRY}`;
    const { stdout, stderr } = await execP(cmd, {
      timeout: 600000,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    });
    const parts = name.split("/");
    const src = join(tmp, "node_modules", ...parts);
    try {
      await readFile(join(src, "package.json"), "utf8");
    } catch {
      throw new Error("npm install produced no package: " + truncate((stdout || "") + (stderr || ""), 500));
    }

    // 更新到实际安装目录（不按包名推断路径——同名插件可能装在顶层而非 scoped）
    const dst = target.dir;
    // junction 防御：目标若是符号链接（junction），只删链接本身（不递归，避免删掉链接指向的真实目录）
    try {
      const st = await lstat(dst);
      if (st.isSymbolicLink()) {
        await rm(dst, { recursive: false, force: true });
      }
    } catch {
      // dst 不存在
    }
    // 备份旧的真实目录
    let backupDir = null;
    if (await exists(dst)) {
      backupDir = join(PROFILE_NODE_MODULES, ".dsh-plugin-backups", `${basename(dst)}-${Date.now()}`);
      await mkdir(backupDir, { recursive: true });
      await cp(dst, join(backupDir, basename(dst)), { recursive: true, force: true });
      await rm(dst, { recursive: true, force: true });
    }
    // 拷贝新版本（确保父目录存在）
    await mkdir(dirname(dst), { recursive: true }).catch(() => {});
    await cp(src, dst, { recursive: true, force: true });

    // 依赖合并：tmp/node_modules 中新增的依赖（profiles 缺失的）一并拷贝
    let merged = 0;
    try {
      const deps = await readdir(join(tmp, "node_modules"), { withFileTypes: true });
      for (const d of deps) {
        if (!d.isDirectory()) continue;
        if (d.name === parts[0]) continue;
        const dSrc = join(tmp, "node_modules", d.name);
        const dDst = join(PROFILE_NODE_MODULES, d.name);
        if (!(await exists(dDst))) {
          await cp(dSrc, dDst, { recursive: true, force: true });
          merged++;
        }
      }
    } catch {
      // 依赖合并失败不阻断主流程
    }

    const newPkg = JSON.parse(await readFile(join(dst, "package.json"), "utf8"));
    npmLatestCache.delete(name);
    return {
      ok: true,
      name,
      installed: typeof newPkg.version === "string" ? newPkg.version : null,
      backupDir,
      merged,
    };
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

// ── HTTP 辅助 ──────────────────────────────────────────────────────────
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
            let force = false;
            try {
              const u = new URL(req.url || "/", "http://localhost");
              force = u.searchParams.get("fresh") === "1";
            } catch {
              force = false;
            }
            status = await runCheck(force);
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

      // 完整更新主程序：备份 → 部署目录 npm install → 同步 @deepseek-ai 生态到 profile。
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
              timeout: 600000,
              maxBuffer: 8 * 1024 * 1024,
              windowsHide: true,
            });
            const plan = await planSync(root);
            const synced = await runSync(root, plan.todo);
            const failed = synced.filter((s) => !s.ok);
            const installed = await readInstalledVersion();
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

      // 重启服务：两级 spawn 脱钩 + 看门狗（独立孙进程跑 restart-watchdog.ps1）
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
            const scriptPath = fileURLToPath(new URL("../scripts/restart-watchdog.ps1", import.meta.url));
            const launcher = join(root, "start-dsh.cmd");
            const log = join(homedir(), ".dsh", "dsh-update-checker-restart.log");
            const inner = `Start-Process -WindowStyle Hidden -FilePath 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' -ArgumentList '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File','${scriptPath}'`;
            const child = spawn(
              "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
              ["-NoProfile", "-NonInteractive", "-Command", inner],
              {
                stdio: "ignore",
                windowsHide: true,
                env: {
                  ...process.env,
                  DSH_RESTART_PORT: String(port),
                  DSH_RESTART_LAUNCHER: launcher,
                  DSH_RESTART_WORKDIR: root,
                  DSH_RESTART_LOG: log,
                },
              }
            );
            child.unref();
            return json(res, 200, { ok: true, message: "restart scheduled" });
          } catch (err) {
            restartScheduled = false;
            return json(res, 500, { ok: false, error: String(err && err.message ? err.message : err) });
          }
        },
      });

      // 插件更新检测：扫描第三方插件 + npm 版本对比
      webServer.register({
        kind: "exact",
        path: "/dsh-update-checker/plugins.json",
        handler: async (req, res) => {
          try {
            let force = false;
            try {
              const u = new URL(req.url || "/", "http://localhost");
              force = u.searchParams.get("fresh") === "1";
            } catch {
              force = false;
            }
            json(res, 200, await runPluginCheck(force));
          } catch (err) {
            json(res, 500, {
              checkedAt: Date.now(),
              plugins: [],
              error: String(err && err.message ? err.message : err),
            });
          }
        },
      });

      // 更新指定插件（临时目录安装 + 拷贝，布局无关）
      webServer.register({
        kind: "exact",
        path: "/dsh-update-checker/plugin-update",
        handler: async (req, res) => {
          const body = await readJsonBody(req);
          if (body && body.parseError) return json(res, 400, { ok: false, error: "invalid JSON body" });
          if (body && body.confirm !== true) return json(res, 400, { ok: false, error: "confirm required" });
          const name = body && typeof body.name === "string" ? body.name.trim() : "";
          if (!name) return json(res, 400, { ok: false, error: "name required" });
          if (pluginUpdateInFlight) return json(res, 409, { ok: false, error: "plugin update already running" });
          pluginUpdateInFlight = true;
          try {
            const result = await updatePlugin(name);
            return json(res, 200, result);
          } catch (err) {
            return json(res, 500, {
              ok: false,
              name,
              error: truncate(String(err && err.message ? err.message : err), 2000),
              code: err && err.code,
            });
          } finally {
            pluginUpdateInFlight = false;
          }
        },
      });
    });
  },
};
