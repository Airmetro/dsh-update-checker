
















import { writeFile, appendFile, rm, mkdir, mkdtemp, readdir, lstat, readFile, cp, realpath } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import http from "node:http";
import https from "node:https";
import { gunzipSync } from "node:zlib";


import { resolveNodeExe, getNpmCli, findDshPackageDir, listDshPackageDirs, looksLikeFileLockError, installWithFileLockRetry, shouldResetStaleLock } from "../lib/index.js";

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
    
  }
}
async function clearProgress() {
  progressCache = null;
  try {
    await rm(PROGRESS_FILE, { force: true });
  } catch {
    
  }
}
async function opsLog(entry) {
  try {
    await mkdir(DSH_HOME, { recursive: true }).catch(() => {});
    const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
    await appendFile(OPS_FILE, line + "\n", "utf8");
  } catch {
    
  }
}


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
      try { child.kill(); } catch {  }
    }, timeoutMs);
    
    
    let deadlocked = false;
    let lastActivity = Date.now();
    const markActivity = () => { lastActivity = Date.now(); };
    const deadlockTimer = setInterval(() => {
      if (!deadlocked && !timedOut && Date.now() - lastActivity > 120000) {
        deadlocked = true;
        try { child.kill(); } catch {  }
      }
    }, 15000);
    child.stdout.on("data", (d) => { stdout += d.toString("utf8"); markActivity(); });
    child.stderr.on("data", (d) => {
      const s = d.toString("utf8");
      stderr += s;
      httpCount += (s.match(/npm http /g) || []).length;
      markActivity();
      if (onProgress) onProgress({ httpCount, stderrTail: stderr.slice(-400) });
    });
    child.on("error", (e) => { clearTimeout(timer); clearInterval(deadlockTimer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      clearInterval(deadlockTimer);
      if (deadlocked) {
        const err = new Error("npm deadlock detected (no output for 120s) — falling back to registry tarballs");
        err.stderr = stderr;
        err.stdout = stdout;
        err.code = "ENPMDEADLOCK";
        return reject(err);
      }
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


function deployType(root) {
  try {
    const pj = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    if (pj && (pj.name || pj.dependencies || pj.devDependencies || pj.optionalDependencies)) return "local";
  } catch {
    
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

async function readLockedDshVersion() {
  for (const p of [join(ROOT, "package-lock.json"), join(ROOT, "node_modules", ".package-lock.json")]) {
    const lock = await readJson(p);
    const locked = lock && lock.packages && lock.packages["node_modules/@deepseek-ai/dsh"];
    const v = locked && typeof locked.version === "string" && locked.version ? locked.version : null;
    if (v) return v;
  }
  return null;
}

export async function resetStaleLockfilesIfNeeded(target) {
  const physVer = await readInstalledVersion();
  const lockedVer = await readLockedDshVersion();
  if (shouldResetStaleLock(physVer, lockedVer, target)) {
    await opsLog({ op: "main-stale-lockfile-reset", physical: physVer, locked: lockedVer, target });
    await rm(join(ROOT, "package-lock.json"), { force: true }).catch(() => {});
    await rm(join(ROOT, "node_modules", ".package-lock.json"), { force: true }).catch(() => {});
    return { reset: true, physical: physVer, locked: lockedVer };
  }
  return { reset: false, physical: physVer, locked: lockedVer };
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
  if (pa.pre.length === 0) return 1; 
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


const PORT = Number(process.env.DSH_UC_UPDATE_PORT) || 3080;

function portPids() {
  const ps = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  const cmd =
    `Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue | ` +
    `Select-Object -ExpandProperty OwningProcess -Unique`;
  return new Promise((resolve) => {
    const c = spawn(ps, ["-NoProfile", "-NonInteractive", "-Command", cmd], { windowsHide: true });
    let o = "";
    c.stdout.on("data", (d) => (o += d.toString()));
    c.on("error", () => resolve([]));
    c.on("close", () =>
      resolve(o.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).map(Number).filter((n) => Number.isInteger(n) && n > 0))
    );
  });
}

async function killPidsOnPort() {
  const pids = await portPids();
  for (const pid of pids) {
    if (pid === process.pid) continue;
    try {
      spawn("C:\\Windows\\System32\\taskkill.exe", ["/PID", String(pid), "/F"], { windowsHide: true, stdio: "ignore" });
    } catch {  }
  }
}

async function portOccupied() {
  return (await portPids()).length > 0;
}

async function ensureServiceStopped(maxMs = 30000) {
  const deadline = Date.now() + maxMs;
  await killPidsOnPort();
  while (Date.now() < deadline) {
    if ((await portPids()).length === 0) return { ok: true };
    await killPidsOnPort();
    await new Promise((r) => setTimeout(r, 500));
  }
  return { ok: false, error: `port ${PORT} still listening after ${maxMs}ms` };
}

async function stopService() {
  const deadline = Date.now() + 20000;
  await killPidsOnPort();
  let still = true;
  while (Date.now() < deadline) {
    still = (await portPids()).length > 0;
    if (!still) break;
    await killPidsOnPort();
    await new Promise((r) => setTimeout(r, 500));
  }
  return { ok: !still, error: still ? `port ${PORT} still listening` : null };
}


async function startService() {
  const port = 3080;
  const bin = join(ROOT, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
  try {
    spawn(resolveNodeExe(), [bin, "web"], {
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




async function verifyTree() {
  const problems = [];
  let packages = [];
  try {
    packages = await listDshPackageDirs(ROOT);
  } catch {
    problems.push(`@deepseek-ai dir missing`);
    return { ok: false, problems };
  }
  if (packages.length === 0) {
    problems.push(`@deepseek-ai dir missing: ${join(ROOT, "node_modules", "@deepseek-ai")}`);
    return { ok: false, problems };
  }
  const skippedPkgs = new Set();
  try {
    const sk = JSON.parse(
      await readFile(join(DSH_HOME, "dsh-update-checker-skipped-pkgs.json"), "utf8")
    );
    if (Array.isArray(sk && sk.skipped)) {
      for (const n of sk.skipped) skippedPkgs.add(n);
    }
  } catch {
    
  }
  for (const p of packages) {
    if (!p.name.startsWith("dsh-")) continue;
    if (skippedPkgs.has(p.name)) continue; 
    const pj = await readJson(join(p.dir, "package.json"));
    if (!pj) { problems.push(`${p.name} package.json missing`); continue; }
    if (pj.version !== TARGET) problems.push(`${p.name} ${pj.version} != ${TARGET}`);
  }
  const fwDir = await findDshPackageDir(ROOT, "dsh-web-frontend");
  if (!fwDir) {
    problems.push("dsh-web-frontend not found (top-level or nested)");
  } else {
    let distBase = join(fwDir, "dist");
    try {
      const indexHtml = await readFile(join(distBase, "index.html"), "utf8");
      const refs = [...indexHtml.matchAll(/["'](\/assets\/[^"']+)["']/g)].map((m) => m[1]);
      const present = new Set();
      const walk = async (dir) => {
        const ents = await readdir(dir, { withFileTypes: true }).catch(() => []);
        for (const e of ents) {
          const full = join(dir, e.name);
          if (e.isDirectory()) await walk(full);
          else {
            let rel = full.slice(distBase.length).replace(/\\/g, "/");
            if (!rel.startsWith("/")) rel = "/" + rel;
            present.add(rel);
          }
        }
      };
      await walk(distBase);
      for (const ref of refs) {
        if (!present.has(ref)) problems.push(`dist missing asset: ${ref}`);
      }
      if (!(await exists(join(fwDir, "package.json")))) {
        problems.push("dsh-web-frontend package.json missing");
      }
    } catch {
      problems.push(`dsh-web-frontend dist/index.html unreadable (tried: ${distBase})`);
    }
  }
  
  
  
  const ENTRY_NAMES = ["client.js", "index.js", "index.cjs", "index.mjs", "bin.js", "main.js", "server.js"];
  for (const p of packages) {
    if (skippedPkgs.has(p.name)) continue; 
    const pkgDir = p.dir;
    if (!(await exists(join(pkgDir, "lib")))) continue;
    let entry = false;
    for (const en of ENTRY_NAMES) {
      if (await exists(join(pkgDir, "lib", en))) { entry = true; break; }
    }
    if (!entry) {
      for (const en of ENTRY_NAMES) {
        if (await exists(join(pkgDir, en))) { entry = true; break; }
      }
    }
    if (!entry) problems.push(`${p.name} empty shell (no lib entry file)`);
  }
  return { ok: problems.length === 0, problems };
}


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
    
  }
}


async function healthCheck() {
  const base = "http://127.0.0.1:3080";
  const problems = [];
  const fetchOnce = (url) =>
    new Promise((resolve) => {
      const mod = String(url).startsWith("https:") ? https : http;
      const req = mod.get(url, { timeout: 8000 }, (res) => {
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


async function rollbackFromBackup() {
  const restoreFromSnapshot = async () => {
    const nmSrc = join(BACKUP, "main-snapshot", "node_modules", "@deepseek-ai");
    if (!(await exists(nmSrc))) return { ok: false, error: "no snapshot" };
    if (await exists(join(ROOT, "node_modules", "@deepseek-ai"))) {
      await rm(join(ROOT, "node_modules", "@deepseek-ai"), { recursive: true, force: true });
    }
    await mkdir(join(ROOT, "node_modules"), { recursive: true });
    await cp(nmSrc, join(ROOT, "node_modules", "@deepseek-ai"), { recursive: true });
    const meta = await readJson(join(BACKUP, "backup-meta.json"));
    const installed = await readInstalledVersion();
    if (installed && meta && compareVersions(installed, meta.installed) !== 0) {
      return { ok: false, error: `snapshot mismatch (${installed} != ${meta.installed})` };
    }
    const pjPath = join(ROOT, "package.json");
    try {
      const pj = JSON.parse(await readFile(pjPath, "utf8"));
      if (pj.dependencies && typeof pj.dependencies[PACKAGE] === "string" && meta && meta.installed) {
        pj.dependencies[PACKAGE] = meta.installed;
        await writeFile(pjPath, JSON.stringify(pj, null, 2), "utf8");
      }
    } catch {  }
    return { ok: true, installed, restored: "snapshot" };
  };
  try {
    const meta = await readJson(join(BACKUP, "backup-meta.json"));
    if (!meta || !meta.installed) return { ok: false, error: "backup missing installed version" };
    const snap = await restoreFromSnapshot();
    if (snap.ok) return snap;
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
      } catch {  }
      return { ok: true, installed };
    }
    return { ok: false, error: `rollback did not reach ${meta.installed}` };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
}










const sleep = (ms) => new Promise((r) => setTimeout(r, ms));


async function downloadTarballToFile(pkgName, version, destFile) {
  const url = `https://registry.npmjs.org/@deepseek-ai%2F${pkgName}/-/${pkgName}-${version}.tgz`;
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
  await writeFile(destFile, buf);
  return buf.length;
}


async function extractTarballFile(tarballFile, pkgName, nmDir, version) {
  const gz = gunzipSync(readFileSync(tarballFile));
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
  const pkgDir = join(nmDir, pkgName);
  const bak = pkgDir + ".bak-tarball";
  try { await rm(bak, { recursive: true, force: true }); } catch {  }
  try { await cp(pkgDir, bak, { recursive: true }); } catch {  }
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
  if (!pj || pj.version !== version) {
    
    await rm(pkgDir, { recursive: true, force: true });
    if (await exists(bak)) await cp(bak, pkgDir, { recursive: true });
    throw new Error(`${pkgName} tarball version mismatch (${pj && pj.version} != ${version})`);
  }
  await rm(bak, { recursive: true, force: true }).catch(() => {});
  return pj.version;
}


async function collectUpdateTodo() {
  const nm = join(ROOT, "node_modules", "@deepseek-ai");
  let names = [];
  try {
    names = (await readdir(nm, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    throw new Error(`@deepseek-ai dir missing: ${nm}`);
  }
  const todo = [];
  for (const n of names) {
    if (n === "dsh") { todo.push(n); continue; } 
    if (!n.startsWith("dsh-")) continue;
    const pj = await readJson(join(nm, n, "package.json"));
    if (pj && pj.version === TARGET) continue;
    todo.push(n);
  }
  return todo;
}


async function downloadTarballsToCache(todo, cacheDir, onProgress) {
  const ok = [];
  const failed = [];
  const skipped = [];
  for (let i = 0; i < todo.length; i++) {
    const n = todo[i];
    if (onProgress) onProgress({ current: i + 1, total: todo.length, name: n });
    const dest = join(cacheDir, `${n}-${TARGET}.tgz`);
    try {
      await downloadTarballToFile(n, TARGET, dest);
      ok.push(n);
    } catch (err) {
      const msg = String((err && err.message) || err);
      if (msg.includes("HTTP 404")) {
        skipped.push(n);
        await opsLog({ op: "main-tarball-pkg-skipped", pkg: n, error: msg });
      } else {
        failed.push({ name: n, error: msg });
        await opsLog({ op: "main-tarball-pkg-failed", pkg: n, error: msg });
      }
    }
  }
  try {
    await writeFile(
      join(DSH_HOME, "dsh-update-checker-skipped-pkgs.json"),
      JSON.stringify({ target: TARGET, skipped }, null, 2),
      "utf8"
    );
  } catch {  }
  return { ok, failed, skipped, total: todo.length };
}


async function extractTreeFromCache(cacheDir, onProgress) {
  const nm = join(ROOT, "node_modules", "@deepseek-ai");
  const files = (await readdir(cacheDir)).filter((f) => f.endsWith(`-${TARGET}.tgz`));
  const updated = [];
  const failed = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const name = f.slice(0, -(TARGET.length + 5)); 
    if (onProgress) onProgress({ current: i + 1, total: files.length, name });
    try {
      await extractTarballFile(join(cacheDir, f), name, nm, TARGET);
      updated.push(name);
    } catch (err) {
      const msg = String((err && err.message) || err);
      failed.push({ name, error: msg });
      await opsLog({ op: "main-tarball-extract-failed", pkg: name, error: msg });
    }
  }
  return { updated, failed, total: files.length };
}




async function syncProfilesToDeploy() {
  const profileNm = process.env.DSH_UC_UPDATE_PROFILE_NM;
  if (!profileNm) return { skipped: true, reason: "no profile node_modules env" };
  const deployNm = join(ROOT, "node_modules", "@deepseek-ai");
  let names = [];
  try {
    names = (await readdir(deployNm, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return { skipped: true, reason: "deploy @deepseek-ai unreadable" };
  }
  const results = [];
  for (const n of names) {
    if (n !== "dsh" && !n.startsWith("dsh-")) continue;
    const src = join(deployNm, n);
    const dst = join(profileNm, "@deepseek-ai", n);
    try {
      if (await exists(dst)) {
        const [rpS, rpD] = await Promise.all([
          realpath(src).catch(() => null),
          realpath(dst).catch(() => null),
        ]);
        if (rpS && rpD && rpS === rpD) {
          results.push({ name: n, ok: true, skipped: "junction" });
          continue;
        }
      }
      await cp(src, dst, { recursive: true, force: true });
      results.push({ name: n, ok: true });
    } catch (err) {
      results.push({ name: n, ok: false, error: String((err && err.message) || err) });
    }
  }
  const failed = results.filter((r) => !r.ok);
  await opsLog({
    op: "main-profile-sync",
    total: results.length,
    junctionSkipped: results.filter((r) => r.skipped).length,
    failed: failed.map((f) => f.name),
  });
  return results;
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
  
  try {
    const rs = await startService();
    await opsLog({ op: "main-update-crash-recovery", startOk: rs.ok, error: rs.error || null });
  } catch {  }
  return { ok: false, error: msg, code };
}


async function main() {
  await opsLog({ op: "main-update-worker-start", target: TARGET, root: ROOT, backup: BACKUP, pid: process.pid });
  const spec = `${PACKAGE}@${TARGET}`;
  const type = deployType(ROOT);
  const baseArgs = ["install"];
  if (type === "global") baseArgs.push("-g");
  baseArgs.push(spec, "--no-audit", "--no-fund", "--loglevel=http");
  let installVia = "npm";
  let cacheDir = null;
  try {
    
    await writeProgress({ phase: "download", label: "正在下载新版本（服务不中断）…", percent: 4 });
    let npmReady = false;
    const dryRunStartedAt = Date.now();
    const dryRunTicker = setInterval(() => {
      const waited = Math.round((Date.now() - dryRunStartedAt) / 1000);
      writeProgress({
        phase: "download",
        label: "正在检查依赖树（npm dry-run）…",
        percent: Math.min(8, 4 + Math.floor(waited / 30)),
        detail: `已等待 ${waited}s`,
      });
    }, 5000);
    try {
      
      await runNpm([...baseArgs, "--dry-run"], { cwd: ROOT, timeoutMs: 150000 });
      npmReady = true;
      await opsLog({ op: "main-npm-dryrun-ok", type });
    } catch (err) {
      await opsLog({
        op: "main-npm-dryrun-fail",
        error: truncate(String((err && err.message) || err), 500),
        code: err && err.code,
      });
    } finally {
      clearInterval(dryRunTicker);
    }
    if (!npmReady) {
      
      installVia = "tarball";
      cacheDir = await mkdtemp(join(tmpdir(), "duc-dl-"));
      const todo = await collectUpdateTodo();
      const dl = await downloadTarballsToCache(todo, cacheDir, (p) => {
        const percent = Math.min(60, 4 + Math.round((p.current / Math.max(1, p.total)) * 56));
        writeProgress({
          phase: "download",
          label: "正在下载新版本（服务不中断）…",
          percent,
          detail: `已下载 ${p.current}/${p.total} 个包（${p.name}）`,
          count: { done: p.current, total: p.total },
        });
      });
      if (dl.ok.length === 0 && dl.failed.length > 0) {
        return await fail(
          `tarball download failed: ${dl.failed.map((f) => `${f.name}: ${f.error}`).join("; ")}`,
          "E_DOWNLOAD",
          { failed: dl.failed }
        );
      }
      await opsLog({
        op: "main-tarball-download-ok",
        downloaded: dl.ok.length,
        total: dl.total,
        skipped: dl.skipped,
        failed: dl.failed.map((f) => f.name),
      });
    }

    
    await writeProgress({ phase: "stop", label: "下载完成，正在停止服务…", percent: 64 });
    const stop = await stopService();
    if (!stop.ok) return await fail(`failed to stop service: ${stop.error}`, "E_STOP");
    await opsLog({ op: "main-update-stop-service", ok: true });

    
    let output = "";
    if (installVia === "npm") {
      await writeProgress({ phase: "install", label: "正在安装新版本…", percent: 70 });
      await resetStaleLockfilesIfNeeded(TARGET);
      const installRes = await installWithFileLockRetry(
        () => runNpm(baseArgs, { cwd: ROOT, timeoutMs: 600000, onProgress: (p) => {
          const total = 587;
          const percent = Math.min(80, 70 + Math.round((p.httpCount / total) * 10));
          writeProgress({
            phase: "install",
            label: "正在安装新版本…",
            percent,
            detail: p.httpCount ? `已解析 ${p.httpCount}/${total} 个包` : "npm 安装中…",
            count: { done: p.httpCount, total },
          });
        } }),
        {
          keepStopped: () => ensureServiceStopped(15000),
          isPortLocked: () => portOccupied().catch(() => false),
          onRetry: async ({ attempt, locked, reoccupied, error }) => {
            await opsLog({ op: "main-npm-install-retry", attempt, locked, reoccupied, error: truncate(error, 300) });
            await writeProgress({
              phase: "install",
              label: "检测到服务被拉起/文件占用，正在清理后重试…",
              percent: 76,
              detail: `第 ${attempt}/${3} 次重试`,
            });
          },
        }
      );
      if (!installRes.ok) {
        const installErr = installRes.error;
        const rollback = await rollbackFromBackup();
        return await fail(
          `install failed (${(installErr && installErr.code) || "unknown"}): ${installErr && installErr.message ? installErr.message : installErr}` +
            (rollback.ok ? " — restored from backup" : " — ROLLBACK ALSO FAILED"),
          (installErr && installErr.code) || "E_INSTALL",
          { stderr: installErr && installErr.stderr ? truncate(installErr.stderr, 2000) : null, rollbackOk: rollback.ok }
        );
      }
      const npmOut = installRes.result || {};
      output = truncate((npmOut.stdout || "") + (npmOut.stderr || ""), 3000);
    } else {
      const guard = await ensureServiceStopped(15000);
      if (!guard.ok) return await fail(`service could not be kept stopped: ${guard.error}`, "E_STOP");
      await writeProgress({ phase: "install", label: "正在应用新版本…", percent: 72 });
      const ex = await extractTreeFromCache(cacheDir, (p) => {
        const percent = Math.min(82, 70 + Math.round((p.current / Math.max(1, p.total)) * 12));
        writeProgress({
          phase: "install",
          label: "正在应用新版本…",
          percent,
          detail: `已应用 ${p.current}/${p.total} 个包（${p.name}）`,
          count: { done: p.current, total: p.total },
        });
      });
      output = `tarball whole-tree: ${ex.updated.length}/${ex.total} packages applied` +
        (ex.failed.length ? ` (failed: ${ex.failed.map((f) => f.name).join(", ")})` : "");
      await opsLog({ op: "main-install-tarball-tree-ok", updated: ex.updated.length, total: ex.total, failed: ex.failed });
    }

    
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

    
    await writeProgress({ phase: "verify", label: "校验安装完整性…", percent: 85 });
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

    
    await writeProgress({ phase: "sync-decl", label: "同步版本声明…", percent: 90 });
    await syncDeclaration();
    await syncProfilesToDeploy();

    
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
  } finally {
    if (cacheDir) await rm(cacheDir, { recursive: true, force: true }).catch(() => {});
    
    try {
      await rm(join(DSH_HOME, "dsh-update-checker-update.lock"), { force: true });
    } catch {  }
  }
}

if (!process.env.DSH_UC_UPDATE_NO_RUN) {
  main()
    .then((r) => {
      console.log("worker result:", JSON.stringify(r));
      process.exit(r && r.ok ? 0 : 1);
    })
    .catch((e) => {
      console.error("worker fatal:", e);
      process.exit(1);
    });
}

export { verifyTree, ensureServiceStopped, killPidsOnPort, portOccupied, portPids, startService };
