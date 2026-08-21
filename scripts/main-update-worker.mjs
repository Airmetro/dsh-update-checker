// main-update-worker.mjs — 主程序更新的独立工作进程（v1.4.10，修复 BUG-EVIDENCE-20260820）
//
// 由 /dsh-update-checker/update 路由经两级 spawn 脱钩启动（R25），与 DSH 主进程完全解耦：
// 本进程可以安全地杀掉 3080 服务进程再执行 npm install（杀父进程不会连带终止本进程）。
//
// 参数经环境变量传递（避开 -Command 中文路径编码问题，R23）：
//   DSH_UC_UPDATE_ROOT     — 部署根（D:\应用\DeepSeek-Harness）
//   DSH_UC_UPDATE_TARGET   — 目标版本（如 0.1.0-rc.8）
//   DSH_UC_UPDATE_BACKUP   — 更新前备份目录
//   DSH_UC_UPDATE_PROGRESS — 进度文件路径
//   DSH_UC_UPDATE_OPS      — 操作日志路径
//   DSH_UC_UPDATE_DSH_HOME — DSH 用户数据目录
//   DSH_UC_UPDATE_SELF_DIR — 本插件包目录（lib/ 的父目录）
//
// 流程（安全状态机）：停服务 → install(超时) → 回读校验 → 完整性校验 → 声明同步 → 重启 → 健康检查。
// 任一失败：回滚备份 + 重启服务 + 写错误进度与 ops 日志。

import { writeFile, appendFile, rm, mkdir, readdir, lstat, readFile, cp } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import https from "node:https";
import { gunzipSync } from "node:zlib";
// v1.4.11：node/npm-cli 解析统一走 lib 的 resolveNodeExe/getNpmCli（issue #8：
// Electron 下 process.execPath 是 electron.exe，不能直接当 node 跑 npm）。
import { resolveNodeExe, getNpmCli } from "../lib/index.js";

const ROOT = process.env.DSH_UC_UPDATE_ROOT;
const TARGET = process.env.DSH_UC_UPDATE_TARGET;
const BACKUP = process.env.DSH_UC_UPDATE_BACKUP;
const PROGRESS_FILE = process.env.DSH_UC_UPDATE_PROGRESS;
const OPS_FILE = process.env.DSH_UC_UPDATE_OPS;
const DSH_HOME = process.env.DSH_UC_UPDATE_DSH_HOME || dirname(dirname(dirname(ROOT)));
const SELF_DIR = process.env.DSH_UC_UPDATE_SELF_DIR;
const PACKAGE = "@deepseek-ai/dsh";

if (!ROOT || !TARGET || !BACKUP || !PROGRESS_FILE || !OPS_FILE) {
  console.error("missing required env");
  process.exit(2);
}

const truncate = (s, n) => {
  const str = String(s || "");
  return str.length > n ? str.slice(0, n) + "…(truncated)" : str;
};

let progressCache = null;
async function writeProgress(patch) {
  try {
    progressCache = { at: Date.now(), running: true, ...(progressCache || {}), ...patch };
    await writeFile(PROGRESS_FILE, JSON.stringify(progressCache, null, 2), "utf8");
  } catch {
    /* 进度写失败静默 */
  }
}
async function clearProgress() {
  progressCache = null;
  try {
    await rm(PROGRESS_FILE, { force: true });
  } catch {
    /* 不存在也正常 */
  }
}
async function opsLog(entry) {
  try {
    await mkdir(DSH_HOME, { recursive: true }).catch(() => {});
    const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
    await appendFile(OPS_FILE, line + "\n", "utf8");
  } catch {
    /* 日志写失败静默 */
  }
}

// 定位 npm-cli.js（复用 lib/index.js 的多布局逻辑；Electron 形态解析真实 node）
const NPM_CLI = getNpmCli();

function runNpm(args, { cwd, timeoutMs = 600000, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveNodeExe(), [NPM_CLI, ...args], {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let httpCount = 0;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch { /* 已退出 */ }
    }, timeoutMs);
    child.stdout.on("data", (d) => { stdout += d.toString("utf8"); });
    child.stderr.on("data", (d) => {
      const s = d.toString("utf8");
      stderr += s;
      httpCount += (s.match(/npm http /g) || []).length;
      if (onProgress) onProgress({ httpCount, stderrTail: stderr.slice(-400) });
    });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        const err = new Error(`npm timed out after ${Math.round(timeoutMs / 1000)}s`);
        err.stderr = stderr;
        err.stdout = stdout;
        err.code = "ETIMEOUTNPM";
        return reject(err);
      }
      if (code !== 0) {
        const err = new Error(stderr.trim() || `npm exited with code ${code}`);
        err.stderr = stderr;
        err.stdout = stdout;
        err.code = "NPMEXIT";
        return reject(err);
      }
      resolve({ stdout, stderr });
    });
  });
}

async function readJson(p) {
  try {
    return JSON.parse(await readFile(p, "utf8"));
  } catch {
    return null;
  }
}
async function exists(p) {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

// 部署形态：local（有 package.json 声明依赖）→ 原位 npm install；global → npm install -g
function deployType(root) {
  try {
    const pj = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    if (pj && (pj.name || pj.dependencies || pj.devDependencies || pj.optionalDependencies)) return "local";
  } catch {
    /* 无 package.json → global */
  }
  return "global";
}

async function readInstalledVersion() {
  try {
    const pj = await readJson(join(ROOT, "node_modules", ...PACKAGE.split("/"), "package.json"));
    return pj && typeof pj.version === "string" && pj.version ? pj.version : null;
  } catch {
    return null;
  }
}

function compareVersions(a, b) {
  const parse = (v) => {
    const m = String(v || "").trim().match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
    if (!m) return null;
    return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split(".") : [] };
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa.core[i] !== pb.core[i]) return pa.core[i] > pb.core[i] ? 1 : -1;
  }
  if (pa.pre.length === 0 && pb.pre.length === 0) return 0;
  if (pa.pre.length === 0) return 1; // 正式版 > 预发布
  if (pb.pre.length === 0) return -1;
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i] || "0";
    const y = pb.pre[i] || "0";
    if (x === y) continue;
    const xn = /^\d+$/.test(x) ? Number(x) : null;
    const yn = /^\d+$/.test(y) ? Number(y) : null;
    if (xn !== null && yn !== null) return xn > yn ? 1 : -1;
    if (xn !== null) return 1;
    if (yn !== null) return -1;
    return x > y ? 1 : -1;
  }
  return 0;
}

// 停服务：taskkill 3080 监听进程 + 等待端口释放（全路径，绕 PATH 损坏）
async function stopService() {
  const port = 3080;
  const ps = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  const cmd =
    `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ` +
    `Select-Object -ExpandProperty OwningProcess -Unique`;
  const probe = () =>
    new Promise((resolve) => {
      const c = spawn(ps, ["-NoProfile", "-NonInteractive", "-Command", cmd], { windowsHide: true });
      let o = "";
      c.stdout.on("data", (d) => (o += d.toString()));
      c.on("error", () => resolve([]));
      c.on("close", () =>
        resolve(o.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).map(Number).filter((n) => Number.isInteger(n) && n > 0))
      );
    });
  const pids = await probe();
  for (const pid of pids) {
    if (pid === process.pid) continue;
    try {
      spawn("C:\\Windows\\System32\\taskkill.exe", ["/PID", String(pid), "/F"], { windowsHide: true, stdio: "ignore" });
    } catch { /* 单个失败继续 */ }
  }
  const deadline = Date.now() + 20000;
  let still = true;
  while (Date.now() < deadline) {
    still = (await probe()).length > 0;
    if (!still) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  return { ok: !still, error: still ? `port ${port} still listening` : null };
}

// 启动服务：绝对路径 cmd 启动 start-dsh.cmd；等端口监听
async function startService() {
  const port = 3080;
  try {
    spawn("C:\\Windows\\System32\\cmd.exe", ["/c", join(ROOT, "start-dsh.cmd")], {
      cwd: ROOT,
      windowsHide: true,
      detached: true,
      stdio: "ignore",
    }).unref();
  } catch (err) {
    return { ok: false, error: `launcher spawn failed: ${err.message}` };
  }
  const ps = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  const cmd = `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique`;
  const probe = () =>
    new Promise((resolve) => {
      const c = spawn(ps, ["-NoProfile", "-NonInteractive", "-Command", cmd], { windowsHide: true });
      let o = "";
      c.stdout.on("data", (d) => (o += d.toString()));
      c.on("error", () => resolve([]));
      c.on("close", () =>
        resolve(o.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).map(Number).filter((n) => Number.isInteger(n) && n > 0))
      );
    });
  const deadline = Date.now() + 30000;
  let pid = null;
  while (Date.now() < deadline) {
    const nums = await probe();
    if (nums.length) { pid = nums[0]; break; }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return { ok: !!pid, pid, error: pid ? null : "service did not listen within 30s" };
}

// 完整性校验（与 lib/index.js verifyDeployTree 同逻辑的精简版）
async function verifyTree() {
  const problems = [];
  const nm = join(ROOT, "node_modules", "@deepseek-ai");
  let names = [];
  try {
    names = (await readdir(nm, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    problems.push(`@deepseek-ai dir missing`);
    return { ok: false, problems };
  }
  for (const n of names) {
    if (!n.startsWith("dsh-")) continue;
    const pj = await readJson(join(nm, n, "package.json"));
    if (!pj) { problems.push(`${n} package.json missing`); continue; }
    if (pj.version !== TARGET) problems.push(`${n} ${pj.version} != ${TARGET}`);
  }
  const dist = join(nm, "dsh-web-frontend", "dist");
  try {
    const indexHtml = await readFile(join(dist, "index.html"), "utf8");
    const refs = [...indexHtml.matchAll(/["'](\/assets\/[^"']+)["']/g)].map((m) => m[1]);
    const present = new Set();
    const walk = async (dir) => {
      const ents = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const e of ents) {
        const full = join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else present.add("/" + full.split(dist).pop().replace(/\\/g, "/"));
      }
    };
    await walk(dist);
    for (const ref of refs) {
      if (!present.has(ref)) problems.push(`dist missing asset: ${ref}`);
    }
    if (!(await exists(join(nm, "dsh-web-frontend", "package.json")))) {
      problems.push("dsh-web-frontend package.json missing");
    }
  } catch {
    problems.push("dsh-web-frontend dist/index.html unreadable");
  }
  for (const n of names) {
    const pkgDir = join(nm, n);
    if (!(await exists(join(pkgDir, "lib")))) continue;
    const entry =
      (await exists(join(pkgDir, "lib", "client.js"))) ||
      (await exists(join(pkgDir, "lib", "index.js"))) ||
      (await exists(join(pkgDir, "client.js")));
    if (!entry) problems.push(`${n} empty shell (no client.js/index.js)`);
  }
  return { ok: problems.length === 0, problems };
}

// 声明同步：package.json 依赖改为精确版本
async function syncDeclaration() {
  const pjPath = join(ROOT, "package.json");
  try {
    const pj = JSON.parse(readFileSync(pjPath, "utf8"));
    if (pj.dependencies && typeof pj.dependencies[PACKAGE] === "string") {
      pj.dependencies[PACKAGE] = TARGET;
      await writeFile(pjPath, JSON.stringify(pj, null, 2), "utf8");
      await opsLog({ op: "main-decl-synced", version: TARGET });
    }
  } catch {
    /* 无 package.json → 无需同步 */
  }
}

// 健康检查：HTTP 200 + 资源 Content-Type 非 text/html
async function healthCheck() {
  const base = "http://127.0.0.1:3080";
  const problems = [];
  const fetchOnce = (url) =>
    new Promise((resolve) => {
      const req = https.get(url, { timeout: 8000 }, (res) => {
        let ct = res.headers["content-type"] || "";
        let body = "";
        res.on("data", (d) => { body += d; if (body.length > 512 * 1024) res.destroy(); });
        res.on("end", () => resolve({ status: res.statusCode, ct, body }));
      });
      req.on("error", () => resolve(null));
      req.on("timeout", () => { req.destroy(); resolve(null); });
    });
  const home = await fetchOnce(base + "/");
  if (!home || home.status !== 200) {
    problems.push(`GET / -> ${home ? home.status : "no response"}`);
    return { ok: false, problems };
  }
  const refs = [...home.body.matchAll(/["'](\/(?:assets|plugins)\/[^"']+)["']/g)].map((m) => m[1]);
  for (const ref of refs.slice(0, 30)) {
    const r = await fetchOnce(base + ref);
    if (!r) { problems.push(`${ref} no response`); continue; }
    const isHtml = (r.ct || "").includes("text/html");
    if (r.status !== 200 || isHtml) problems.push(`${ref} -> ${r.status} ${isHtml ? "text/html(SPA fallback)" : r.ct}`);
  }
  return { ok: problems.length === 0, problems };
}

// 回滚：从备份重装旧版本
async function rollbackFromBackup() {
  try {
    const meta = await readJson(join(BACKUP, "backup-meta.json"));
    if (!meta || !meta.installed) return { ok: false, error: "backup missing installed version" };
    const spec = `${PACKAGE}@${meta.installed}`;
    const type = deployType(ROOT);
    const args = ["install"];
    if (type === "global") args.push("-g");
    args.push(spec, "--no-audit", "--no-fund");
    await runNpm(args, { cwd: ROOT, timeoutMs: 600000 });
    const installed = await readInstalledVersion();
    if (installed && compareVersions(installed, meta.installed) === 0) {
      const pjPath = join(ROOT, "package.json");
      try {
        const pj = JSON.parse(readFileSync(pjPath, "utf8"));
        if (pj.dependencies && typeof pj.dependencies[PACKAGE] === "string") {
          pj.dependencies[PACKAGE] = meta.installed;
          await writeFile(pjPath, JSON.stringify(pj, null, 2), "utf8");
        }
      } catch { /* noop */ }
      return { ok: true, installed };
    }
    return { ok: false, error: `rollback did not reach ${meta.installed}` };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
}

// ── v1.4.10 tarball 直连回退（D1 增强）：npm install 对本机 dsh 大依赖树可能死锁/超时
// （BUG 证据 7），此时改用 registry tarball 直连下载 dsh 主包解压覆盖 + 同步声明。
// 只覆盖 @deepseek-ai/dsh 本体（lib/package.json 等），其余 @deepseek-ai 包保持原版本
// （一致树无需整树升级；若版本不一致由后续 verify 检出并回滚）。
async function installFromTarball() {
  const url = `https://registry.npmjs.org/${PACKAGE.replace("/", "%2F")}/-/${PACKAGE.split("/")[1]}-${TARGET}.tgz`;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const buf = await new Promise((resolve, reject) => {
    const doFetch = async (triesLeft) => {
      try {
        const r = await fetch(url, { headers: { "User-Agent": "dsh-update-checker" } });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const ab = await r.arrayBuffer();
        resolve(Buffer.from(ab));
      } catch (err) {
        if (triesLeft <= 1) return reject(new Error(`tarball download failed: ${err.message}`));
        setTimeout(() => doFetch(triesLeft - 1), 1500);
      }
    };
    doFetch(3);
  });
  // 解压 tar.gz（纯 node）
  const gz = gunzipSync(buf);
  const entries = [];
  let off = 0;
  while (off + 512 <= gz.length) {
    const nameRaw = gz.subarray(off, off + 100).toString("utf8").replace(/\0.*$/, "");
    if (!nameRaw) break;
    const size = parseInt(gz.subarray(off + 124, off + 136).toString("utf8").replace(/\0.*$/, "").trim(), 8) || 0;
    const type = gz[off + 156] || 48;
    if (type === 48 || type === 0) entries.push({ name: nameRaw, data: gz.subarray(off + 512, off + 512 + size) });
    off += 512 + Math.ceil(size / 512) * 512;
  }
  const pkgDir = join(ROOT, "node_modules", ...PACKAGE.split("/"));
  const bak = pkgDir + ".bak-tarball";
  try { await rm(bak, { recursive: true, force: true }); } catch { /* noop */ }
  try { await cp(pkgDir, bak, { recursive: true }); } catch { /* 备份失败继续 */ }
  await rm(pkgDir, { recursive: true, force: true });
  await mkdir(pkgDir, { recursive: true });
  for (const e of entries) {
    const rel = e.name.split("/").slice(1).join("/");
    if (!rel) continue;
    const target = join(pkgDir, rel);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, e.data);
  }
  const pj = await readJson(join(pkgDir, "package.json"));
  if (!pj || pj.version !== TARGET) {
    // 覆盖失败：还原备份
    await rm(pkgDir, { recursive: true, force: true });
    if (await exists(bak)) await cp(bak, pkgDir, { recursive: true });
    throw new Error(`tarball install version mismatch (${pj && pj.version} != ${TARGET})`);
  }
  await rm(bak, { recursive: true, force: true }).catch(() => {});
  return { ok: true, installed: pj.version };
}

async function fail(msg, code, extra = {}) {
  await writeProgress({
    phase: "error",
    running: false,
    percent: null,
    label: "更新失败",
    error: truncate(msg, 3000),
    code,
  });
  await opsLog({ op: "main-update-error", error: truncate(msg, 3000), code, ...extra });
  // 尽力恢复服务
  try {
    const rs = await startService();
    await opsLog({ op: "main-update-crash-recovery", startOk: rs.ok, error: rs.error || null });
  } catch { /* 恢复失败也上报主错误 */ }
  return { ok: false, error: msg, code };
}

// ── 主流程 ─────────────────────────────────────────────────────────────
async function main() {
  await opsLog({ op: "main-update-worker-start", target: TARGET, root: ROOT, backup: BACKUP, pid: process.pid });
  try {
    // 1) 停服务（D2）
    await writeProgress({ phase: "stop", label: "停止 dsh 服务（避免文件占用）…", percent: 8 });
    const stop = await stopService();
    if (!stop.ok) return await fail(`failed to stop service: ${stop.error}`, "E_STOP");
    await opsLog({ op: "main-update-stop-service", ok: true });

    // 2) install（D1：带超时；npm 对 dsh 大依赖树可能死锁 → 自动 tarball 直连回退）
    const spec = `${PACKAGE}@${TARGET}`;
    const type = deployType(ROOT);
    const args = ["install"];
    if (type === "global") args.push("-g");
    args.push(spec, "--no-audit", "--no-fund", "--loglevel=http");
    await writeProgress({ phase: "install", label: "正在安装新版本…", percent: 15 });
    let output = "";
    let installVia = "npm";
    try {
      const total = 587;
      const { stdout, stderr } = await runNpm(args, { cwd: ROOT, timeoutMs: 600000, onProgress: (p) => {
        const percent = Math.min(70, 15 + Math.round((p.httpCount / total) * 55));
        writeProgress({
          phase: "install",
          label: "正在安装新版本…",
          percent,
          detail: p.httpCount ? `已解析 ${p.httpCount}/${total} 个包` : "npm 安装中…",
          count: { done: p.httpCount, total },
        });
      } });
      output = truncate((stdout || "") + (stderr || ""), 3000);
    } catch (err) {
      // npm 失败/超时 → tarball 直连回退（BUG 证据 7：本机 npm 对该树解析死锁）
      await opsLog({
        op: "main-install-npm-failed-fallback-tarball",
        error: String(err && err.message ? err.message : err),
        code: err && err.code,
      });
      await writeProgress({ phase: "install-tarball", label: "npm 超时，改用 registry 直连安装…", percent: 40 });
      try {
        const tb = await installFromTarball();
        installVia = "tarball";
        output = `tarball direct install: ${PACKAGE}@${TARGET}`;
        await opsLog({ op: "main-install-tarball-ok", installed: tb.installed });
      } catch (tbErr) {
        const rollback = await rollbackFromBackup();
        return await fail(
          `install failed (npm: ${err && err.code ? err.code : "unknown"}, tarball: ${tbErr.message})` +
            (rollback.ok ? " — restored from backup" : " — ROLLBACK ALSO FAILED"),
          (err && err.code) || "E_INSTALL",
          { stderr: err && err.stderr ? truncate(err.stderr, 2000) : null, rollbackOk: rollback.ok }
        );
      }
    }

    // 3) 回读校验
    let installed = await readInstalledVersion();
    if (!installed || compareVersions(installed, TARGET) !== 0) {
      const rollback = await rollbackFromBackup();
      return await fail(
        `update did not reach ${TARGET} (installed=${installed || "?"})` +
          (rollback.ok ? " — restored from backup" : " — ROLLBACK ALSO FAILED"),
        "E_VERSION",
        { rollbackOk: rollback.ok }
      );
    }

    // 4) 完整性校验（D3）
    await writeProgress({ phase: "verify", label: "校验安装完整性…", percent: 82 });
    const verify = await verifyTree();
    if (!verify.ok) {
      const rollback = await rollbackFromBackup();
      return await fail(
        `integrity check failed: ${verify.problems.join("; ")}` +
          (rollback.ok ? " — restored from backup" : " — ROLLBACK ALSO FAILED"),
        "E_INTEGRITY",
        { problems: verify.problems, rollbackOk: rollback.ok }
      );
    }

    // 5) 声明同步（D5）
    await writeProgress({ phase: "sync-decl", label: "同步 package.json 声明…", percent: 90 });
    await syncDeclaration();

    // 6) 重启 + 健康检查（D4）
    await writeProgress({ phase: "restart", label: "重启 dsh 服务…", percent: 94 });
    const rs = await startService();
    await writeProgress({ phase: "health", label: "健康检查…", percent: 97 });
    const health = await healthCheck();
    if (!rs.ok || !health.ok) {
      return await fail(
        `update installed ${TARGET} but restart/health failed: ${rs.error || health.problems.join("; ")}`,
        "E_RESTART",
        { health: health.problems || null }
      );
    }

    await opsLog({ op: "main-update-ok", to: TARGET, type, backup: BACKUP, forced: false, installVia });
    await writeProgress({
      phase: "done",
      running: false,
      percent: 100,
      label: "更新完成",
      result: { ok: true, installed, latest: TARGET },
    });
    return { ok: true, installed, latest: TARGET, type };
  } catch (err) {
    return await fail(String(err && err.message ? err.message : err), err && err.code);
  }
}

main()
  .then((r) => {
    console.log("worker result:", JSON.stringify(r));
    process.exit(r && r.ok ? 0 : 1);
  })
  .catch((e) => {
    console.error("worker fatal:", e);
    process.exit(1);
  });
