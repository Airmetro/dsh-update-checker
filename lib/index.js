







































import { readFile, writeFile, mkdir, copyFile, cp, readdir, realpath, lstat, rm, mkdtemp, rename, appendFile } from "node:fs/promises";
import { resolve, join, basename, dirname, sep, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, tmpdir } from "node:os";
import { gunzipSync } from "node:zlib";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { exec, spawn } from "node:child_process";
import { promisify } from "node:util";
import http from "node:http";
import https from "node:https";

const execP = promisify(exec);

const REGISTRY = "https://registry.npmjs.org";
const PACKAGE = "@deepseek-ai/dsh";
const SELF = "dsh-update-checker";
const CHECK_TTL_MS = 5 * 60 * 1000;
const MAX_BODY_BYTES = 1024 * 1024;          
const MAX_GH_JSON_BYTES = 4 * 1024 * 1024;   
const MAX_TARBALL_BYTES = 200 * 1024 * 1024; 

const GH_INSECURE_HOST_RE = /(^|\.)(github\.com|githubusercontent\.com|githubassets\.com)$/i;



const GH_TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";




const SELF_LIB_DIR = dirname(fileURLToPath(import.meta.url));


function findNodeModulesDir(from) {
  let cur = from;
  for (let i = 0; i < 8; i++) {
    if (basename(cur) === "node_modules") return cur;
    const p = dirname(cur);
    if (p === cur) break;
    cur = p;
  }
  return null;
}




const PROFILE_NODE_MODULES =
  process.env.DSH_UC_PROFILE_NODE_MODULES ||
  findNodeModulesDir(SELF_LIB_DIR) ||
  join(homedir(), ".dsh", "profiles", "node_modules");
const PROFILES_ROOT = dirname(PROFILE_NODE_MODULES);

const DSH_HOME = dirname(PROFILES_ROOT);


const STATE_FILE = join(DSH_HOME, "dsh-update-checker-state.json");


const BACKUP_DIR_DEFAULT = join(DSH_HOME, "dsh-update-checker-backups");

const LEGACY_PLUGIN_BACKUP_ROOT = join(PROFILE_NODE_MODULES, ".dsh-plugin-backups");

const RESTART_LOG = join(DSH_HOME, "dsh-update-checker-restart.log");
const RESTART_RESULT = join(DSH_HOME, "dsh-update-checker-restart-result.json");

const OPS_LOG = join(DSH_HOME, "dsh-update-checker-ops.log");

const UPDATE_PROGRESS_FILE = join(DSH_HOME, "dsh-update-checker-update-progress.json");



async function findCompositionFile() {
  const defaultFile = join(PROFILES_ROOT, "web", "cordis.patch.yml");
  try {
    await readFile(defaultFile, "utf8");
    return defaultFile;
  } catch {
    
  }
  try {
    const dirs = await readdir(PROFILES_ROOT, { withFileTypes: true });
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const f = join(PROFILES_ROOT, d.name, "cordis.patch.yml");
      try {
        const raw = await readFile(f, "utf8");
        if (raw.includes(SELF)) return f;
      } catch {
        
      }
    }
  } catch {
    
  }
  return defaultFile;
}









const DEPLOY_ROOT_CANDIDATES = [process.cwd()];


















let nodeExeCache = null;
let npmCliCache = null;







function buildNodeExeCandidates(execPath, env) {
  const e = env || process.env;
  const exeBase = String(execPath || "").split(/[\\/]/).pop().toLowerCase();
  const looksNode =
    /^node(\.exe)?$/.test(exeBase) ||
    (exeBase.includes("node") && !exeBase.includes("electron") && !exeBase.includes("chrome"));
  const cands = [];
  if (looksNode && execPath) cands.push(execPath);
  if (execPath) {
    const dir = dirname(execPath);
    cands.push(join(dir, "node.exe"));
    cands.push(join(dir, "..", "node.exe"));
  }
  if (e.NODE) cands.push(e.NODE);
  if (e.npm_node_execpath) cands.push(e.npm_node_execpath);
  const pf = e.ProgramFiles || "C:\\Program Files";
  const pf86 = e["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  cands.push(join(pf, "nodejs", "node.exe"));
  cands.push(join(pf86, "nodejs", "node.exe"));
  if (e.LOCALAPPDATA) cands.push(join(e.LOCALAPPDATA, "Programs", "nodejs", "node.exe"));
  cands.push("C:\\nodejs\\node.exe");
  const seen = new Set();
  return cands.filter((c) => (seen.has(c) ? false : (seen.add(c), true)));
}




function resolveNodeExe() {
  if (nodeExeCache) return nodeExeCache;
  const override = process.env.DSH_UC_NODE_EXE;
  if (override && existsSync(override)) {
    nodeExeCache = override;
    return nodeExeCache;
  }
  for (const c of buildNodeExeCandidates(process.execPath, process.env)) {
    try {
      if (existsSync(c)) {
        nodeExeCache = c;
        return c;
      }
    } catch {
      
    }
  }
  
  const isWin = process.platform === "win32";
  const names = isWin ? ["node.exe", "node.cmd"] : ["node"];
  for (const d of String(process.env.PATH || "").split(delimiter).filter(Boolean)) {
    for (const nm of names) {
      const p = join(d, nm);
      try {
        if (existsSync(p)) {
          nodeExeCache = p;
          return p;
        }
      } catch {
        
      }
    }
  }
  nodeExeCache = process.execPath; 
  return nodeExeCache;
}


function getNpmCli() {
  if (npmCliCache) return npmCliCache;
  const exeDir = dirname(resolveNodeExe());
  npmCliCache =
    [
      join(exeDir, "node_modules", "npm", "bin", "npm-cli.js"),
      join(exeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
      join(exeDir, "..", "node_modules", "npm", "bin", "npm-cli.js"),
      join(exeDir, "..", "libexec", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    ].find((p) => existsSync(p)) || join(exeDir, "node_modules", "npm", "bin", "npm-cli.js");
  return npmCliCache;
}

const ALLOW_SCRIPTS = "@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs";

let updateInFlight = false;
let restartScheduled = false;
let restartStartedAt = 0;
let pluginUpdateInFlight = false;

let updateStartedAt = 0;
let pluginUpdateStartedAt = 0;


async function readState() {
  try {
    const data = JSON.parse(await readFile(STATE_FILE, "utf8"));
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

async function writeState(patch) {
  try {
    const cur = await readState();
    await mkdir(DSH_HOME, { recursive: true });
    await writeFile(STATE_FILE, JSON.stringify({ ...cur, ...patch }, null, 2), "utf8");
    return true;
  } catch {
    return false;
  }
}


async function readSettings() {
  const s = await readState();
  const ds = s.downloadSource;
  return {
    floatingEnabled: s.floatingEnabled !== false,
    notifyEnabled: s.notifyEnabled !== false,
    suppressUpToDate: s.suppressUpToDate === true,
    suppressPluginBanner: s.suppressPluginBanner === true,
    allowPrerelease: s.allowPrerelease === true,
    excludedPlugins: normalizeExcludedPlugins(s.excludedPlugins),
    downloadSource: ds === "npm" || ds === "smart" ? ds : "github",
  };
}

function normalizeExcludedPlugins(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  const seen = new Set();
  for (const x of v) {
    if (typeof x !== "string") continue;
    const t = x.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

async function readExcludedPlugins() {
  return new Set(normalizeExcludedPlugins((await readState()).excludedPlugins));
}

async function writeExcludedPlugin(name, excluded) {
  const cur = normalizeExcludedPlugins((await readState()).excludedPlugins);
  const set = new Set(cur);
  if (excluded) set.add(name);
  else set.delete(name);
  return writeState({ excludedPlugins: Array.from(set) });
}

async function readSuppressUpToDate() {
  return (await readState()).suppressUpToDate === true;
}
async function writeSuppressUpToDate(value) {
  return writeState({ suppressUpToDate: !!value });
}

async function readSuppressPluginBanner() {
  return (await readState()).suppressPluginBanner === true;
}
async function writeSuppressPluginBanner(value) {
  return writeState({ suppressPluginBanner: !!value });
}


function parseVersion(v) {
  const m = String(v || "").trim().match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!m) return null;
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split(".") : [] };
}

function isPrerelease(v) {
  const p = parseVersion(v);
  return !!p && p.pre.length > 0;
}



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
    if (nx) return -1; 
    if (ny) return 1;
    return x > y ? 1 : -1;
  }
  return 0;
}






function satisfies(version, range) {
  const ver = String(version || "").trim();
  const v = parseVersion(ver);
  if (!v) return false;
  const r = String(range || "").trim();
  if (!r) return true;
  return String(r)
    .split("||")
    .some((part) => satisfiesAnd(v, ver, part.trim()));
}

function satisfiesAnd(v, ver, r) {
  
  const hy = r.match(/^(\S+)\s+-\s+(\S+)$/);
  if (hy) {
    const loRaw = hy[1].trim();
    const hiRaw = hy[2].trim();
    const allowPre = [loRaw, hiRaw].some((p) => {
      const ps = parseVersion(String(p).replace(/^[<>=^~]+/, ""));
      return !!ps && ps.pre.length > 0 && ps.core[0] === v.core[0] && ps.core[1] === v.core[1] && ps.core[2] === v.core[2];
    });
    const lo = expandPartial(loRaw);
    const loOk = satisfiesSingle(v, ver, ">=" + lo, allowPre);
    let hiOk = false;
    if (/^\d+$/.test(hiRaw)) hiOk = satisfiesSingle(v, ver, "<" + (Number(hiRaw) + 1) + ".0.0", allowPre);
    else if (/^\d+\.\d+$/.test(hiRaw)) {
      const [a, b] = hiRaw.split(".");
      hiOk = satisfiesSingle(v, ver, "<" + a + "." + (Number(b) + 1) + ".0", allowPre);
    } else hiOk = satisfiesSingle(v, ver, "<=" + expandPartial(hiRaw), allowPre);
    return loOk && hiOk;
  }
  const parts = r.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return true;
  
  const allowPre = parts.some((p) => {
    const ps = parseVersion(String(p).replace(/^[<>=^~]+/, ""));
    return !!ps && ps.pre.length > 0 && ps.core[0] === v.core[0] && ps.core[1] === v.core[1] && ps.core[2] === v.core[2];
  });
  return parts.every((p) => satisfiesSingle(v, ver, p, allowPre));
}


function expandPartial(spec) {
  const m = String(spec || "").trim().match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/);
  if (!m) return spec;
  if (m[3] !== undefined) return spec;
  return m[2] === undefined ? `${m[1]}.x` : `${m[1]}.${m[2]}.x`;
}


function preAllowed(v, spec) {
  if (v.pre.length === 0) return true;
  const ps = parseVersion(String(spec || "").replace(/^[<>=^~]+/, ""));
  if (!ps) return false;
  if (ps.pre.length === 0) return false;
  return ps.core[0] === v.core[0] && ps.core[1] === v.core[1] && ps.core[2] === v.core[2];
}

function matchesPartial(v, spec, allowPre) {
  if (!allowPre && !preAllowed(v, spec)) return false;
  if (spec === "*" || spec === "x" || spec === "X" || spec === "") return true;
  const m = String(spec).match(/^(\d+)\.?(\d+)?\.?(\d+)?[xX*]?$/);
  if (!m) return false;
  if (m[1] !== undefined && Number(m[1]) !== v.core[0]) return false;
  if (m[2] !== undefined && Number(m[2]) !== v.core[1]) return false;
  if (m[3] !== undefined && Number(m[3]) !== v.core[2]) return false;
  return true;
}

function satisfiesSingle(v, ver, compRaw, allowPre) {
  const comp = String(compRaw || "").trim().replace(/^v/i, "");
  if (!comp || comp === "*" || comp === "x" || comp === "X") {
    return allowPre ? true : preAllowed(v, comp);
  }
  const m = comp.match(/^(<=|>=|<|>|=|~|\^)?(.*)$/);
  let op = m[1] || "=";
  let spec = m[2].trim();
  if (!spec) {
    if (op === "=" || op === "") return true;
    return false;
  }
  
  if (!/^[<>=^~]/.test(comp)) {
    if (/[xX*]/.test(comp)) return matchesPartial(v, comp, allowPre);
    const mm = comp.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/);
    if (mm) return matchesPartial(v, comp, allowPre);
  }
  
  const mm2 = spec.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/);
  const specHadMinor = !!(mm2 && mm2[2] !== undefined);
  if (mm2 && mm2[3] === undefined) {
    const a = mm2[1];
    const b = mm2[2] === undefined ? "0" : mm2[2];
    if (op === ">" && mm2[2] !== undefined) {
      op = ">=";
      spec = `${a}.${Number(b) + 1}.0`;
    } else if (op === ">" && mm2[2] === undefined) {
      op = ">=";
      spec = `${Number(a) + 1}.0.0`;
    } else {
      spec = `${a}.${b}.0`;
    }
  }
  if (/[xX*]/.test(spec)) return matchesPartial(v, spec, allowPre);
  const target = parseVersion(spec);
  if (!target) return false;
  if (!allowPre && !preAllowed(v, spec)) return false;
  const c = compareVersions(ver, spec);
  switch (op) {
    case "=":
      return c === 0;
    case "<":
      return c < 0;
    case ">":
      return c > 0;
    case "<=":
      return c <= 0;
    case ">=":
      return c >= 0;
    case "~": {
      
      const [mj, mn] = target.core;
      if (!specHadMinor) return c >= 0 && v.core[0] === mj;
      return c >= 0 && v.core[0] === mj && v.core[1] === mn;
    }
    case "^": {
      
      const [mj, mn, pt] = target.core;
      if (mj > 0) return c >= 0 && v.core[0] === mj;
      if (mn > 0) return c >= 0 && v.core[0] === 0 && v.core[1] === mn;
      return c >= 0 && v.core[0] === 0 && v.core[1] === 0 && v.core[2] === pt;
    }
    default:
      return false;
  }
}



function pickNpmLatest(doc) {
  const tags = (doc && doc["dist-tags"]) || {};
  const versions = Object.keys((doc && doc.versions) || {});
  if (!versions.length) return null;
  const stable = versions.filter((v) => !isPrerelease(v)).sort((a, b) => compareVersions(b, a));
  if (stable.length) return stable[0];
  const tagged = tags.latest;
  if (tagged && versions.includes(tagged)) return tagged;
  return versions.slice().sort((a, b) => compareVersions(b, a))[0];
}





function pickMainLatest(doc, allowPre) {
  const versions = Object.keys((doc && doc.versions) || {});
  if (!versions.length) return null;
  if (allowPre) return versions.slice().sort((a, b) => compareVersions(b, a))[0];
  const stable = versions.filter((v) => !isPrerelease(v)).sort((a, b) => compareVersions(b, a));
  return stable.length ? stable[0] : null;
}



function mainTagToVersion(tag) {
  const s = String(tag || "").trim().replace(/^dsh-?/i, "").replace(/^v/i, "");
  return /^\d+\.\d+\.\d+/.test(s) ? s : null;
}


function deriveRisk(from, to) {
  const p = parseVersion(from);
  const q = parseVersion(to);
  if (!p || !q) return "unknown";
  const c = compareVersions(from, to);
  if (c === 0) return "same";
  if (q.pre.length > 0 && q.core[0] === p.core[0] && q.core[1] === p.core[1] && q.core[2] === p.core[2]) return "pre";
  if (q.core[0] !== p.core[0]) return "major";
  if (q.core[1] !== p.core[1]) return "minor";
  return "patch";
}







function deriveStatus(installed, target, hasSource) {
  if (!hasSource || !target) return "error";
  if (!installed) return "latest";
  const c = compareVersions(installed, target);
  if (c > 0) return "rollback";
  if (c < 0) return "update";
  return "latest";
}


function tagToVersion(tag) {
  const s = String(tag || "").trim().replace(/^v/i, "");
  return /^\d+\.\d+\.\d+/.test(s) ? s : null;
}







let npmGlobalRootCache = null;
let npmGlobalRootProbeAt = 0;
async function probeNpmGlobalRoot() {
  const now = Date.now();
  if (now - npmGlobalRootProbeAt < 60000) return npmGlobalRootCache; 
  npmGlobalRootProbeAt = now;
  if (process.env.DSH_UC_NPM_GLOBAL_ROOT) {
    npmGlobalRootCache = dirname(process.env.DSH_UC_NPM_GLOBAL_ROOT);
    return npmGlobalRootCache;
  }
  try {
    const { stdout } = await runNpm(["root", "-g"], { timeout: 15000, maxBuffer: 1024 * 1024 });
    const line = String(stdout || "").trim().split(/\r?\n/)[0];
    npmGlobalRootCache = line ? dirname(line) : null;
  } catch {
    npmGlobalRootCache = null;
  }
  return npmGlobalRootCache;
}







async function findDeployRoot() {
  try {
    const link = join(PROFILE_NODE_MODULES, "@deepseek-ai", "dsh");
    const st = await lstat(link);
    if (st.isSymbolicLink()) {
      const rp = await realpath(link); 
      const candidate = resolve(rp, "..", "..", "..");
      await readFile(resolve(candidate, `node_modules/${PACKAGE}/package.json`), "utf8");
      return candidate;
    }
  } catch {
    
  }
  const extra = process.env.DSH_DEPLOY_ROOT ? [process.env.DSH_DEPLOY_ROOT] : [];
  const npmGlobalRoot = await probeNpmGlobalRoot();
  for (const root of [...extra, ...DEPLOY_ROOT_CANDIDATES, ...(npmGlobalRoot ? [npmGlobalRoot] : [])]) {
    try {
      await readFile(resolve(root, `node_modules/${PACKAGE}/package.json`), "utf8");
      return root;
    } catch {
      
    }
  }
  return null;
}



function deployType(root) {
  try {
    const pj = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
    if (pj && (pj.name || pj.dependencies || pj.devDependencies || pj.optionalDependencies)) return "local";
  } catch {
    
  }
  return "global";
}


function readNpmMajor() {
  try {
    const pj = JSON.parse(readFileSync(join(dirname(dirname(getNpmCli())), "package.json"), "utf8"));
    const n = Number(String(pj.version || "").split(".")[0]);
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}


function buildNpmInstallArgs(root, spec) {
  const type = deployType(root);
  const args = ["install"];
  if (type === "global") args.push("-g");
  args.push(spec, "--no-audit", "--no-fund");
  const npmMajor = readNpmMajor();
  if (npmMajor !== null && npmMajor >= 12) args.push(`--allow-scripts=${ALLOW_SCRIPTS}`);
  return { args, type, npmMajor };
}


async function runNpm(args, opts = {}) {
  const cmd = `"${resolveNodeExe()}" "${getNpmCli()}" ${args.map((a) => `"${a}"`).join(" ")}`;
  return execP(cmd, {
    cwd: opts.cwd,
    timeout: opts.timeout || 600000,
    maxBuffer: opts.maxBuffer || 8 * 1024 * 1024,
    windowsHide: true,
  });
}







async function dryRunGuard(root, spec) {
  const { args } = buildNpmInstallArgs(root, spec);
  const text = await runNpmWithTimeout([...args, "--dry-run"], root, 45000);
  if (text === null) {
    const warn = "npm dry-run timed out (large dependency tree) — skipped dry-run guard, continuing with backup+verify";
    await opsLog({ op: "main-dryrun-skipped", root, spec, warn });
    return { ok: true, skipped: true, text: warn };
  }
  const m = text.match(/removed\s+(\d+)\s+packages?/i);
  if (m && Number(m[1]) > 0) {
    const err = new Error(
      `npm dry-run plans to REMOVE ${m[1]} packages — aborting to protect the deployment.\n` +
        truncate(text, 800)
    );
    err.code = "EDRYREMOVE";
    throw err;
  }
  return { ok: true, skipped: false, text };
}


async function runNpmWithTimeout(args, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(resolveNodeExe(), [getNpmCli(), ...args], {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let errOut = "";
    child.stdout.on("data", (c) => { out += String(c); });
    child.stderr.on("data", (c) => { errOut += String(c); });
    const timer = setTimeout(() => {
      try { child.kill(); } catch {  }
    }, timeoutMs);
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === null) return resolve(null); 
      resolve(out + errOut);
    });
  });
}






export async function forceReifyMain(root, latestVersion, onProgress) {
  const pkgDir = join(root, "node_modules", ...PACKAGE.split("/"));
  const bak = `${pkgDir}.bak-pre-reify-${Date.now()}`;
  let renamed = false;
  try {
    await rename(pkgDir, bak);
    renamed = true;
  } catch {
    
  }
  try {
    const spec = `${PACKAGE}@${latestVersion}`;
    const args = buildNpmInstallArgs(root, spec).args;
    args.push("--loglevel=http");
    const { stdout, stderr } = await runNpmProgress(args, { cwd: root, timeout: 600000 }, onProgress);
    const installed = await readInstalledVersion();
    const ok = installed && compareVersions(installed, latestVersion) === 0;
    if (renamed && ok) {
      
      await rm(bak, { recursive: true, force: true }).catch(() => {});
    }
    return {
      ok: !!ok,
      installed,
      output: truncate((stdout || "") + (stderr || ""), 2000),
      backupDir: renamed && !ok ? bak : null,
    };
  } catch (err) {
    
    if (renamed) {
      await rm(pkgDir, { recursive: true, force: true }).catch(() => {});
      await rename(bak, pkgDir).catch(() => {});
    }
    throw err;
  }
}


async function findLauncher(root) {
  const candidates = [
    "start-dsh.cmd",
    "启动 dsh.bat",
    "start-dsh.bat",
    "start dsh.cmd",
    "dsh.cmd",
    "dsh.bat",
  ];
  for (const name of candidates) {
    const p = join(root, name);
    try {
      await readFile(p, "utf8");
      return p;
    } catch {
      
    }
  }
  return join(root, "start-dsh.cmd"); 
}



function deriveLauncher() {
  const args = process.argv.slice(1);
  if (!args.length || !process.execPath) return null;
  return { file: process.execPath, args, cwd: process.cwd() };
}


async function readInstalledVersion() {
  const root = await findDeployRoot();
  if (root) {
    try {
      const pkg = JSON.parse(
        await readFile(resolve(root, `node_modules/${PACKAGE}/package.json`), "utf8")
      );
      if (typeof pkg.version === "string" && pkg.version) return pkg.version;
    } catch {
      
    }
  }
  try {
    const pkg = JSON.parse(
      await readFile(join(PROFILE_NODE_MODULES, PACKAGE, "package.json"), "utf8")
    );
    return typeof pkg.version === "string" && pkg.version ? pkg.version : null;
  } catch {
    return null;
  }
}




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
        
      }
    }
  } catch {
    
  }
  return map;
}



async function backupForUpdate(deployRoot) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = join((await backupDirs()).main, stamp);
  await mkdir(dir, { recursive: true });
  for (const f of ["package.json", "package-lock.json"]) {
    try {
      await copyFile(join(deployRoot, f), join(dir, f));
    } catch {
      
    }
  }
  let snapshotOk = false;
  const snapshotRoot = join(dir, "main-snapshot");
  try {
    const fwSrc = join(deployRoot, "node_modules", "@deepseek-ai");
    const fwDst = join(snapshotRoot, "node_modules", "@deepseek-ai");
    await mkdir(join(snapshotRoot, "node_modules"), { recursive: true });
    await cp(fwSrc, fwDst, { recursive: true });
    snapshotOk = true;
  } catch {
    
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
  const installed = await readInstalledVersion();
  await writeFile(
    join(dir, "backup-meta.json"),
    JSON.stringify(
      { installed, type: deployType(deployRoot), createdAt: new Date().toISOString(), snapshot: snapshotOk ? "main-snapshot" : null },
      null,
      2
    ),
    "utf8"
  );
  return dir;
}













async function executeMainUpdate({
  deployRoot,
  targetVersion,
  backupDir,
  dryRunOnly = false,
  installTimeoutMs = 600000,
}) {
  const step = (phase, label, percent, extra = {}) =>
    writeProgress({ phase, label, percent, ...extra });
  const fail = async (msg, code, extra = {}) => {
    await writeProgress({
      phase: "error",
      running: false,
      percent: null,
      label: "更新失败",
      error: truncate(msg, 3000),
      code,
    });
    await opsLog({ op: "main-update-error", error: truncate(msg, 3000), code, ...extra });
    return { ok: false, error: msg, code };
  };
  try {
    if (dryRunOnly) {
      
      await step("dry-run", "dry 预览（不执行安装）…", 5);
      const plan = await planSync(deployRoot);
      const spec = `${PACKAGE}@${targetVersion}`;
      let dryRunOut;
      try {
        const guard = await dryRunGuard(deployRoot, spec);
        dryRunOut = guard.skipped
          ? { skipped: true, note: guard.text }
          : truncate(guard.text, 2000);
      } catch (e) {
        
        dryRunOut = { error: String(e && e.message ? e.message : e), code: e && e.code };
      }
      await clearProgress();
      return { ok: true, dry: true, plan, dryRun: dryRunOut };
    }

    
    await step("stop", "停止 dsh 服务（避免文件占用）…", 8);
    await opsLog({ op: "main-update-stop-service", root: deployRoot });
    const stopResult = await stopDshService(deployRoot);
    if (!stopResult.ok) {
      return await fail(
        `failed to stop dsh service: ${stopResult.error}`,
        "E_STOP",
        { stopResult }
      );
    }

    
    await step("install", "正在安装新版本…", 15);
    const spec = `${PACKAGE}@${targetVersion}`;
    const { args, type } = buildNpmInstallArgs(deployRoot, spec);
    args.push("--loglevel=http");
    const totalPackages = (await countLockfilePackages(deployRoot)) || 1;
    let installedOutput = "";
    try {
      const { stdout, stderr } = await runNpmProgress(
        args,
        { cwd: deployRoot, timeout: installTimeoutMs },
        (p) => {
          const percent = Math.min(70, 15 + Math.round((p.httpCount / totalPackages) * 55));
          step("install", "正在安装新版本…", percent, {
            detail: p.httpCount ? `已解析 ${p.httpCount}/${totalPackages} 个包` : "npm 安装中…",
            count: { done: p.httpCount, total: totalPackages },
          });
        }
      );
      installedOutput = truncate((stdout || "") + (stderr || ""), 3000);
    } catch (err) {
      
      await opsLog({
        op: "main-install-failed",
        error: String(err && err.message ? err.message : err),
        stderr: err && err.stderr ? truncate(err.stderr, 2000) : null,
        code: err && err.code,
        backupDir,
      });
      const rollback = await rollbackMainFrom(backupDir, deployRoot);
      await opsLog({
        op: "main-update-rollback-after-install-fail",
        ok: rollback.ok,
        error: rollback.error || null,
      });
      return await fail(
        `install failed (${err && err.code ? err.code : "unknown"}): ${
          err && err.message ? err.message : err
        }${rollback.ok ? " — restored from backup" : " — ROLLBACK ALSO FAILED"}`,
        (err && err.code) || "E_INSTALL",
        { stderr: err && err.stderr ? truncate(err.stderr, 2000) : null, rollbackOk: rollback.ok }
      );
    }

    
    let installed = await readInstalledVersion();
    let upToDate = installed && compareVersions(installed, targetVersion) === 0;
    let forced = false;
    if (!upToDate) {
      await step("force-install", "检测到 npm 跳过实际替换，正在强制安装…", 72);
      await opsLog({
        op: "main-update-reify-skip",
        from: installed,
        to: targetVersion,
        output: installedOutput,
      });
      const forceInfo = await forceReifyMain(deployRoot, targetVersion, () => {});
      installed = forceInfo.installed;
      upToDate = installed && compareVersions(installed, targetVersion) === 0;
      forced = !!forceInfo;
    }
    if (!upToDate) {
      const rollback = await rollbackMainFrom(backupDir, deployRoot);
      await opsLog({
        op: "main-update-rollback-after-version-mismatch",
        ok: rollback.ok,
        error: rollback.error || null,
        installed,
        target: targetVersion,
      });
      return await fail(
        `update did not reach ${targetVersion} (installed=${installed || "?"})${
          rollback.ok ? " — restored from backup" : " — ROLLBACK ALSO FAILED"
        }`,
        "E_VERSION",
        { rollbackOk: rollback.ok }
      );
    }

    
    await step("verify", "校验安装完整性…", 82);
    const verify = await verifyDeployTree(deployRoot, targetVersion);
    if (!verify.ok) {
      const rollback = await rollbackMainFrom(backupDir, deployRoot);
      await opsLog({
        op: "main-update-rollback-after-verify-fail",
        ok: rollback.ok,
        error: rollback.error || null,
        problems: verify.problems,
      });
      return await fail(
        `integrity check failed: ${verify.problems.join("; ")}` +
          (rollback.ok ? " — restored from backup" : " — ROLLBACK ALSO FAILED"),
        "E_INTEGRITY",
        { problems: verify.problems, rollbackOk: rollback.ok }
      );
    }

    
    await step("sync-decl", "同步 package.json 声明…", 90);
    await syncDeployDeclaration(deployRoot, targetVersion);

    
    await step("restart", "重启 dsh 服务…", 94);
    const restartResult = await startDshService(deployRoot);
    await step("health", "健康检查…", 97);
    const health = await healthCheckDsh();
    if (!restartResult.ok || !health.ok) {
      await opsLog({
        op: "main-update-restart-fail",
        restartOk: restartResult.ok,
        restartError: restartResult.error || null,
        healthOk: health.ok,
        healthProblems: health.problems || null,
      });
      return await fail(
        `update installed ${targetVersion} but service restart/health check failed: ${
          restartResult.error || health.error || "unknown"
        }`,
        "E_RESTART",
        { health: health.problems || null }
      );
    }

    await writeSuppressUpToDate(false);
    await opsLog({
      op: "main-update-ok",
      from: null,
      to: targetVersion,
      type,
      backupDir,
      forced,
      syncFailed: 0,
    });
    await step("done", "更新完成", 100, {
      running: false,
      result: { ok: true, installed, latest: targetVersion },
    });
    return { ok: true, installed, latest: targetVersion, type, backupDir, forced };
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    const code = err && err.code;
    
    try {
      const rs = await startDshService(deployRoot);
      await opsLog({ op: "main-update-crash-recovery", startOk: rs.ok, error: rs.error || null });
    } catch {
      
    }
    return await fail(msg, code || "E_UNKNOWN");
  }
}



async function stopDshService(deployRoot) {
  const port = 3080;
  const taskkill = "C:\\Windows\\System32\\taskkill.exe";
  const kills = [];
  
  const ps = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  const cmd =
    `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ` +
    `Select-Object -ExpandProperty OwningProcess -Unique`;
  const probePids = () =>
    new Promise((resolve) => {
      const c = spawn(ps, ["-NoProfile", "-NonInteractive", "-Command", cmd], { windowsHide: true });
      let o = "";
      c.stdout.on("data", (d) => (o += d.toString()));
      c.on("error", () => resolve([]));
      c.on("close", () => {
        resolve(
          o
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean)
            .map(Number)
            .filter((n) => Number.isInteger(n) && n > 0)
        );
      });
    });
  let pids = [];
  try {
    pids = await probePids();
  } catch {
    
  }
  for (const pid of pids) {
    if (pid === process.pid) continue; 
    kills.push(pid);
    try {
      spawn(taskkill, ["/PID", String(pid), "/F"], { windowsHide: true, stdio: "ignore" });
    } catch {
      
    }
  }
  
  const deadline = Date.now() + 20000;
  let still = true;
  while (Date.now() < deadline) {
    try {
      const p = await probePids();
      still = p.length > 0;
    } catch {
      still = true;
    }
    if (!still) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  return { ok: !still, error: still ? `port ${port} still listening after kill` : null, killed: kills };
}


async function startDshService(deployRoot) {
  const port = 3080;
  const ps = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  const cmd = `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique`;
  const probe = () =>
    new Promise((resolve) => {
      const c = spawn(ps, ["-NoProfile", "-NonInteractive", "-Command", cmd], { windowsHide: true });
      let o = "";
      c.stdout.on("data", (d) => (o += d.toString()));
      c.on("error", () => resolve([]));
      c.on("close", () =>
        resolve(
          o
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean)
            .map(Number)
            .filter((n) => Number.isInteger(n) && n > 0)
        )
      );
    });
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const nums = await probe();
    if (!nums.length) break;
    for (const pid of nums) {
      if (pid === process.pid) continue;
      try {
        spawn("C:\\Windows\\System32\\taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      } catch {  }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  const launcherInfo = deriveLauncher();
  try {
    if (launcherInfo) {
      spawn(launcherInfo.file, launcherInfo.args, {
        cwd: launcherInfo.cwd || deployRoot,
        windowsHide: true,
        detached: true,
        stdio: "ignore",
      }).unref();
    } else {
      spawn("C:\\Windows\\System32\\cmd.exe", ["/c", join(deployRoot, "start-dsh.cmd")], {
        cwd: deployRoot,
        windowsHide: true,
        detached: true,
        stdio: "ignore",
      }).unref();
    }
  } catch (err) {
    return { ok: false, error: `launcher spawn failed: ${err.message}` };
  }
  const deadline2 = Date.now() + 30000;
  let pid = null;
  while (Date.now() < deadline2) {
    try {
      const nums = await probe();
      if (nums.length) { pid = nums[0]; break; }
    } catch {  }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return { ok: !!pid, pid, error: pid ? null : "service did not listen within 30s" };
}


async function healthCheckDsh() {
  const port = 3080;
  const base = `http://127.0.0.1:${port}`;
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
    return { ok: false, problems, error: problems.join("; ") };
  }
  
  const refs = [...home.body.matchAll(/["'](\/(?:assets|plugins)\/[^"']+)["']/g)].map((m) => m[1]);
  for (const ref of refs.slice(0, 30)) {
    const r = await fetchOnce(base + ref);
    if (!r) { problems.push(`${ref} no response`); continue; }
    const isHtml = (r.ct || "").includes("text/html");
    if (r.status !== 200 || isHtml) {
      problems.push(`${ref} -> ${r.status} ${isHtml ? "(text/html SPA fallback)" : r.ct}`);
    }
  }
  return { ok: problems.length === 0, problems, error: problems.length ? problems.join("; ") : null };
}


async function rollbackMainFrom(backupDir, deployRoot) {
  try {
    const meta = JSON.parse(await readFile(join(backupDir, "backup-meta.json"), "utf8"));
    if (!meta.installed) return { ok: false, error: "backup missing installed version" };
    const spec = `${PACKAGE}@${meta.installed}`;
    const { args, type } = buildNpmInstallArgs(deployRoot, spec);
    args.push("--loglevel=error");
    await runNpmProgress(args, { cwd: deployRoot, timeout: 600000 }, () => {});
    const installed = await readInstalledVersion();
    if (installed && compareVersions(installed, meta.installed) === 0) {
      await syncDeployDeclaration(deployRoot, meta.installed);
      return { ok: true, installed };
    }
    return { ok: false, error: `rollback did not reach ${meta.installed} (installed=${installed})` };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
}


async function syncDeployDeclaration(deployRoot, version) {
  const pjPath = join(deployRoot, "package.json");
  try {
    const pj = JSON.parse(await readFile(pjPath, "utf8"));
    const scope = pj.dependencies || {};
    if (typeof scope[PACKAGE] === "string") {
      scope[PACKAGE] = version; 
      pj.dependencies = scope;
      await writeFile(pjPath, JSON.stringify(pj, null, 2), "utf8");
      await opsLog({ op: "main-decl-synced", version });
    }
  } catch {
    
  }
}




function planSyncFromMaps(deploy, profile) {
  const todo = [];
  for (const [name, ver] of Object.entries(deploy)) {
    if (profile[name] !== ver) {
      todo.push({ name, from: profile[name] || null, to: ver });
    }
  }
  return todo;
}


async function planSync(deployRoot) {
  const deploy = await readEcoVersions(join(deployRoot, "node_modules"));
  const profile = await readEcoVersions(PROFILE_NODE_MODULES);
  return { deploy, profile, todo: planSyncFromMaps(deploy, profile) };
}




async function runSync(deployRoot, todo) {
  const results = [];
  for (const item of todo) {
    const src = join(deployRoot, "node_modules", "@deepseek-ai", item.name);
    const dst = join(PROFILE_NODE_MODULES, "@deepseek-ai", item.name);
    try {
      if (await exists(dst)) {
        const [rpSrc, rpDst] = await Promise.all([
          realpath(src).catch(() => null),
          realpath(dst).catch(() => null),
        ]);
        if (rpSrc && rpDst && rpSrc === rpDst) {
          results.push({ name: item.name, from: item.to, to: item.to, ok: true, skipped: "same-file (junction)" });
          continue;
        }
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


let npmLatestCache = new Map();
let mainPackumentCache = null;

async function fetchPackument(name, full) {
  const res = await fetch(`${REGISTRY}/${encodeURIComponent(name)}`, {
    headers: full
      ? { accept: "application/json" }
      : { accept: "application/vnd.npm.install-v1+json" },
    signal: AbortSignal.timeout(20000),
  });
  if (res.status === 404) {
    throw Object.assign(new Error("package not on npm registry"), { code: "ENOTFOUND" });
  }
  if (!res.ok) throw new Error("npm registry HTTP " + res.status);
  return res.json();
}


async function fetchNpmLatest(name, force) {
  const now = Date.now();
  const hit = npmLatestCache.get(name);
  if (!force && hit && now - hit.at < CHECK_TTL_MS) return hit.value.version;
  const doc = await fetchPackument(name, false);
  const version = pickNpmLatest(doc);
  if (!version) throw new Error("npm registry: no version");
  npmLatestCache.set(name, { value: { version }, at: now });
  return version;
}




async function fetchMainPackument(force) {
  const now = Date.now();
  if (!force && mainPackumentCache && now - mainPackumentCache.at < CHECK_TTL_MS) {
    return mainPackumentCache.value;
  }
  const doc = await fetchPackument(PACKAGE, true);
  const allowPre = (await readSettings()).allowPrerelease === true;
  const version = pickMainLatest(doc, allowPre);
  if (!version) throw new Error("npm registry: no stable @deepseek-ai/dsh version; enable allowPrerelease in settings to follow pre-release channels");
  const value = {
    version,
    publishedAt: (doc.time && doc.time[version]) || null,
    ghRepo: parseGhRepo((doc.versions && doc.versions[version] && doc.versions[version].repository) || null) || null,
  };
  mainPackumentCache = { value, at: now };
  return value;
}



function parseGhRepo(r) {
  if (!r) return null;
  if (typeof r === "object" && r.directory) return null;
  const url = (typeof r === "string" ? r : r.url) || "";
  const m =
    url.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?(?:\/|$)/) ||
    (typeof r === "string" ? r.match(/^([^/]+)\/([^/]+?)(?:\.git)?$/) : null);
  return m ? m[1] + "/" + m[2] : null;
}



function ghRequest(url, opts = {}) {
  const maxBytes = opts.maxBytes || MAX_GH_JSON_BYTES;
  const extraHeaders = opts.headers || {};
  return new Promise((resolve, reject) => {
    const doGet = (u, redirects) => {
      let host = "";
      try {
        host = new URL(u).hostname;
      } catch (err) {
        return reject(err);
      }
      const insecure = GH_INSECURE_HOST_RE.test(host);
      const req = https.get(
        u,
        {
          headers: {
            accept: "application/json",
            "user-agent": "dsh-update-checker",
            
            
            ...(host === "api.github.com" && GH_TOKEN
              ? { authorization: `Bearer ${GH_TOKEN}` }
              : {}),
            ...extraHeaders,
          },
          rejectUnauthorized: insecure ? false : true,
          timeout: 30000,
        },
        (res) => {
          if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
            if (redirects >= 5) {
              res.resume();
              return reject(new Error("too many redirects"));
            }
            const next = new URL(res.headers.location, u).toString();
            res.resume();
            return doGet(next, redirects + 1);
          }
          const chunks = [];
          let size = 0;
          res.on("data", (c) => {
            size += c.length;
            if (size > maxBytes) {
              res.destroy();
              return reject(
                Object.assign(new Error(`download exceeds size cap (${maxBytes} bytes)`), {
                  code: "ETOOBIG",
                })
              );
            }
            chunks.push(c);
          });
          res.on("end", () =>
            resolve({ status: res.statusCode, headers: res.headers, buf: Buffer.concat(chunks) })
          );
        }
      );
      req.on("timeout", () =>
        req.destroy(Object.assign(new Error("github timeout"), { code: "ETIMEDOUT" }))
      );
      req.on("error", reject);
    };
    doGet(url, 0);
  });
}

let ghLatestCache = new Map();
let ghNotesCache = new Map();

let ghPkgNameCache = new Map();



async function fetchGitHubLatest(repo, force) {
  const now = Date.now();
  const hit = ghLatestCache.get(repo);
  if (!force && hit && now - hit.at < CHECK_TTL_MS) {
    if (hit.value && hit.value.error) throw Object.assign(new Error(hit.value.error), { code: "GITHUB" });
    return hit.value;
  }
  try {
    const r = await ghRequest(`https://api.github.com/repos/${repo}/releases/latest`);
    if (r.status === 404) {
      const none = { none: true };
      ghLatestCache.set(repo, { value: none, at: now });
      return none;
    }
    if (r.status === 403)
      throw new Error(
        GH_TOKEN ? "github forbidden (403, check token)" : "github rate limited (403)"
      );
    if (r.status < 200 || r.status >= 300) throw new Error(`HTTP ${r.status}`);
    const data = JSON.parse(r.buf.toString("utf8"));
    if (!data || !data.tag_name) throw new Error("no release");
    const version = tagToVersion(data.tag_name);
    if (!version) throw new Error("no semver tag");
    const result = { tag: data.tag_name, version };
    ghLatestCache.set(repo, { value: result, at: now });
    return result;
  } catch (err) {
    const reason =
      err && (err.name === "TimeoutError" || err.code === "ETIMEDOUT")
        ? "timeout"
        : err && err.message
          ? err.message
          : "github fetch failed";
    ghLatestCache.set(repo, { value: { error: reason }, at: now });
    throw Object.assign(new Error(reason), { code: "GITHUB" });
  }
}


async function fetchGhReleaseNotes(repo, tag) {
  const key = repo + "#" + tag;
  const hit = ghNotesCache.get(key);
  if (hit !== undefined) return hit;
  try {
    const r = await ghRequest(
      `https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`
    );
    if (r.status !== 200) {
      ghNotesCache.set(key, null);
      return null;
    }
    const data = JSON.parse(r.buf.toString("utf8"));
    const body = (data && data.body && String(data.body).trim()) || null;
    const notes = body ? truncate(body, 600) : null;
    ghNotesCache.set(key, notes);
    return notes;
  } catch {
    ghNotesCache.set(key, null);
    return null;
  }
}







let mainGhLatestCache = null;
let mainGhLatestProbedAt = 0;
async function fetchMainGhLatest(repo, force) {
  const now = Date.now();
  if (!force && mainGhLatestCache && now - mainGhLatestProbedAt < CHECK_TTL_MS) {
    if (mainGhLatestCache.error) {
      throw Object.assign(new Error(mainGhLatestCache.error), { code: "GITHUB" });
    }
    return mainGhLatestCache;
  }
  try {
    const r = await ghRequest(`https://api.github.com/repos/${repo}/releases?per_page=30`);
    if (r.status === 404) {
      const none = { none: true };
      mainGhLatestCache = none;
      mainGhLatestProbedAt = now;
      return none;
    }
    if (r.status === 403)
      throw new Error(
        GH_TOKEN ? "github forbidden (403, check token)" : "github rate limited (403)"
      );
    if (r.status < 200 || r.status >= 300) throw new Error(`HTTP ${r.status}`);
    const list = JSON.parse(r.buf.toString("utf8"));
    if (!Array.isArray(list)) throw new Error("no release list");
    let best = null;
    for (const rel of list) {
      if (!rel || rel.draft || !rel.tag_name) continue;
      const version = mainTagToVersion(rel.tag_name);
      if (!version) continue;
      if (!best || compareVersions(version, best.version) > 0) {
        best = { tag: rel.tag_name, version, publishedAt: rel.published_at || null };
      }
    }
    const result = best || { none: true };
    mainGhLatestCache = result;
    mainGhLatestProbedAt = now;
    return result;
  } catch (err) {
    const reason =
      err && (err.name === "TimeoutError" || err.code === "ETIMEDOUT")
        ? "timeout"
        : err && err.message
          ? err.message
          : "github fetch failed";
    mainGhLatestCache = { error: reason };
    mainGhLatestProbedAt = now;
    throw Object.assign(new Error(reason), { code: "GITHUB" });
  }
}





async function fetchGhPkgName(repo, tag) {
  const key = repo + "#" + tag;
  const now = Date.now();
  const hit = ghPkgNameCache.get(key);
  if (hit !== undefined && now - hit.at < CHECK_TTL_MS) return hit.value;
  try {
    const r = await ghRequest(
      `https://api.github.com/repos/${repo}/contents/package.json?ref=${encodeURIComponent(tag)}`,
      { headers: { accept: "application/vnd.github.raw+json" } }
    );
    if (r.status === 404) {
      const value = { name: null, hasRootPkg: false };
      ghPkgNameCache.set(key, { value, at: now });
      return value;
    }
    if (r.status !== 200) {
      const value = { name: null, hasRootPkg: null };
      ghPkgNameCache.set(key, { value, at: now });
      return value;
    }
    let pkg = null;
    try {
      pkg = JSON.parse(r.buf.toString("utf8"));
    } catch {
      
    }
    const name = pkg && typeof pkg.name === "string" && pkg.name ? pkg.name : null;
    const value = { name, hasRootPkg: true };
    ghPkgNameCache.set(key, { value, at: now });
    return value;
  } catch {
    
    const value = { name: null, hasRootPkg: null };
    ghPkgNameCache.set(key, { value, at: now });
    return value;
  }
}





function ghTagBelongsTo(ghName, pluginName) {
  if (ghName === null || ghName === undefined) return true;
  return ghName === pluginName;
}




async function resolveMainTarget(force) {
  const npmInfo = await fetchMainPackument(force);
  let ghInfo = null;
  let ghError = null;
  if (npmInfo.ghRepo) {
    try {
      const gh = await fetchMainGhLatest(npmInfo.ghRepo, force);
      if (gh && !gh.none) ghInfo = gh;
    } catch (err) {
      ghError = String(err && err.message ? err.message : err);
    }
  }
  let version = npmInfo.version;
  let source = "npm";
  let ghTag = null;
  let publishedAt = npmInfo.publishedAt || null;
  if (npmInfo && ghInfo) {
    const setts = await readSettings();
    const allowPre = setts.allowPrerelease === true;
    const prefSource = setts.downloadSource;
    const { target, src } = pickTargetSource(npmInfo.version, ghInfo.version, prefSource);
    if (allowPre || !isPrerelease(target)) {
      version = target;
      source = src;
      ghTag = ghInfo.tag;
      if (src === "github") publishedAt = ghInfo.publishedAt || publishedAt;
    }
  }
  return {
    version,
    npmVersion: npmInfo.version,
    ghVersion: ghInfo ? ghInfo.version : null,
    source,
    ghTag,
    publishedAt,
    ghRepo: npmInfo.ghRepo,
    ghError,
  };
}





async function runCheck(force) {
  const report = {
    checkedAt: Date.now(),
    latest: null,
    installed: null,
    hasUpdate: false,
    latestError: null,
    installedError: null,
    brief: null,
  };
  try {
    const target = await resolveMainTarget(force);
    report.latest = target.version;
    report.latestPublishedAt = target.publishedAt;
    report.source = target.source;
    report.ghTag = target.ghTag;
    report.sourceNote = `npm ${target.npmVersion}${target.ghVersion ? " / gh " + target.ghVersion : ""}`;
    if (target.ghError) report.ghError = target.ghError;
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
    report.brief = {
      from: report.installed,
      to: report.latest,
      risk: deriveRisk(report.installed, report.latest),
      publishedAt: report.latestPublishedAt || null,
      notes: [],
    };
  }
  
  report.status = deriveStatus(report.installed, report.latest, !!report.latest);
  report.suppressUpToDate = await readSuppressUpToDate();
  const settings = await readSettings();
  report.floatingEnabled = settings.floatingEnabled;
  report.notifyEnabled = settings.notifyEnabled;
  return report;
}


async function readCompositionPluginNames() {
  const names = new Set();
  try {
    const raw = await readFile(await findCompositionFile(), "utf8");
    const re = /^\s*name:\s*['"]([^'"]+)['"]\s*$/gm;
    let m;
    while ((m = re.exec(raw))) names.add(m[1].trim());
  } catch {
    
  }
  return names;
}



async function classifyPlugin(dir, dirName, composition) {
  if (!dirName) return null;
  if (dirName.startsWith("@deepseek-ai/")) return null; 
  let pkg = null;
  try {
    pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
  } catch {
    
    if (composition.has(dirName)) return { name: dirName, installed: null, dir, hasDsh: false };
    return null;
  }
  const isComposition = composition.has(dirName);
  const hasDsh = Boolean(pkg && pkg.dsh);
  if (!isComposition && !hasDsh) return null; 
  const name = pkg && typeof pkg.name === "string" && pkg.name ? pkg.name : dirName;
  return {
    name,
    installed: pkg && typeof pkg.version === "string" && pkg.version ? pkg.version : null,
    dir,
    ghRepo: parseGhRepo(pkg && pkg.repository),
    hasDsh,
  };
}


async function findAllPluginRoots() {
  const roots = [PROFILE_NODE_MODULES];
  try {
    const top = await readdir(PROFILES_ROOT, { withFileTypes: true });
    for (const d of top) {
      if (!d.isDirectory() || d.name === "node_modules") continue;
      const cand = join(PROFILES_ROOT, d.name, "node_modules");
      if (await exists(cand)) roots.push(cand);
    }
  } catch {
    
  }
  const seen = new Set();
  const out = [];
  for (const r of roots) {
    let key = r;
    try {
      key = await realpath(r);
    } catch {
      
    }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

function rootPriority(prefRoot, dir) {
  if (!prefRoot || !dir) return 0;
  const d = resolve(dir);
  if (d.startsWith(resolve(prefRoot) + sep)) return 2;
  if (d.startsWith(resolve(PROFILE_NODE_MODULES) + sep)) return 1;
  return 0;
}

async function pushUnique(found, byName, seenReal, prefRoot, pkg, dir) {
  if (!pkg) return;
  let key = dir;
  try {
    key = await realpath(dir);
  } catch {
    
  }
  if (seenReal.has(key)) return;
  seenReal.add(key);
  const name = pkg.name;
  if (!name) {
    found.push(pkg);
    return;
  }
  const existing = byName.get(name);
  if (!existing) {
    byName.set(name, pkg);
    found.push(pkg);
    return;
  }
  if (rootPriority(prefRoot, pkg.dir) > rootPriority(prefRoot, existing.dir)) {
    const idx = found.indexOf(existing);
    const dup = { dir: existing.dir, installed: existing.installed };
    if (idx >= 0) found[idx] = pkg;
    byName.set(name, pkg);
    if (!pkg.copies) pkg.copies = [];
    pkg.copies.push(dup);
  } else {
    if (!existing.copies) existing.copies = [];
    existing.copies.push({ dir: pkg.dir, installed: pkg.installed });
  }
}

async function compositionProfileNodeModules() {
  try {
    const comp = await findCompositionFile();
    return join(dirname(comp), "node_modules");
  } catch {
    return null;
  }
}

async function scanInstalledPlugins() {
  const found = [];
  const byName = new Map();
  const seenReal = new Set();
  const composition = await readCompositionPluginNames();
  const prefRoot = await compositionProfileNodeModules();
  for (const root of await findAllPluginRoots()) {
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name === ".bin" || e.name === ".dsh-plugin-backups") continue;
      if (e.name.startsWith("@")) {
        if (e.name === "@deepseek-ai") continue; 
        let subs;
        try {
          subs = await readdir(join(root, e.name), { withFileTypes: true });
        } catch {
          continue;
        }
        for (const s of subs) {
          if (!s.isDirectory()) continue;
          const dir = join(root, e.name, s.name);
          const pkg = await classifyPlugin(dir, `${e.name}/${s.name}`, composition);
          await pushUnique(found, byName, seenReal, prefRoot, pkg, dir);
        }
      } else {
        const dir = join(root, e.name);
        const pkg = await classifyPlugin(dir, e.name, composition);
        await pushUnique(found, byName, seenReal, prefRoot, pkg, dir);
      }
    }
  }
  return found;
}





function pickTargetSource(npmV, ghV, pref) {
  if (npmV && ghV) {
    const cmp = compareVersions(ghV, npmV);
    if (cmp > 0) return { target: ghV, src: "github", source: "both" };
    if (cmp < 0) return { target: npmV, src: "npm", source: "both" };
    if (pref === "npm") return { target: npmV, src: "npm", source: "both" };
    return { target: ghV, src: "github", source: "both" }; 
  }
  if (ghV) return { target: ghV, src: "github", source: "github" };
  if (npmV) return { target: npmV, src: "npm", source: "npm" };
  return { target: null, src: null, source: null };
}



async function checkPlugin(p, force) {
  const item = {
    name: p.name,
    installed: p.installed,
    dir: p.dir || null,
    copies: Array.isArray(p.copies) ? p.copies : [],
    latest: null,      
    npmLatest: null,
    ghLatest: null,
    ghTag: null,
    hasUpdate: false,
    onNpm: false,
    onGithub: false,
    source: null,      
    targetSource: null, 
    error: null,
    ghError: null,
    ignored: false,
    ignoreReason: null,
    brief: null,
  };
  try {
    item.npmLatest = await fetchNpmLatest(p.name, force);
    item.onNpm = true;
  } catch (err) {
    if (err && err.code === "ENOTFOUND") {
      item.onNpm = false;
      item.error = "not on npm registry";
    } else {
      item.error = String(err && err.message ? err.message : err);
    }
  }
  if (p.ghRepo) {
    try {
      const gh = await fetchGitHubLatest(p.ghRepo, force);
      if (gh && gh.none) {
        item.onGithub = false;
      } else {
        
        
        
        
        
        const ghNameRes = await fetchGhPkgName(p.ghRepo, gh.tag);
        const belongs = ghNameRes.hasRootPkg === false ? false : ghTagBelongsTo(ghNameRes.name, p.name);
        if (belongs) {
          item.onGithub = true;
          item.ghTag = gh.tag;
          item.ghLatest = gh.version;
        } else {
          item.onGithub = false;
          item.ghTag = null;
          item.ghLatest = null;
          item.ghError = `github tag ${gh.tag} is for ${ghName} (monorepo root), not ${p.name}; ignored`;
        }
      }
    } catch (err) {
      
      item.ghError = String(err && err.message ? err.message : err);
    }
  }
  const npmV = item.npmLatest;
  const ghV = item.ghLatest;
  
  
  const prefSource = (await readSettings()).downloadSource;
  const { target, src, source } = pickTargetSource(npmV, ghV, prefSource);
  item.source = source;
  item.latest = target;
  item.targetSource = src;
  item.downloadSource = prefSource; 
  item.tie = !!(npmV && ghV && compareVersions(ghV, npmV) === 0); 
  if (item.installed && target) {
    item.hasUpdate = compareVersions(target, item.installed) > 0;
  }
  
  item.status = deriveStatus(item.installed, target, !!(npmV || ghV));
  
  if (!target) {
    const parts = [];
    if (item.error) parts.push("npm: " + item.error);
    if (item.ghError) parts.push("github: " + item.ghError);
    item.error = parts.length ? parts.join("; ") : "no update source";
    
    if (!p.hasDsh) {
      item.ignored = true;
      item.ignoreReason = "no dsh field and not on npm/GitHub (local tool)";
    }
  }
  
  if (item.installed && target) {
    const brief = {
      from: item.installed,
      to: target,
      risk: deriveRisk(item.installed, target),
      notes: null,
    };
    if (p.ghRepo && item.ghTag) {
      brief.notes = await fetchGhReleaseNotes(p.ghRepo, item.ghTag);
    }
    item.brief = brief;
  }
  return item;
}

async function runPluginCheck(force) {
  const plugins = await scanInstalledPlugins();
  
  const list = await Promise.all(plugins.map((p) => checkPlugin(p, force)));
  const excludedNames = await readExcludedPlugins();
  const active = list.filter((i) => !i.ignored && !excludedNames.has(i.name));
  active.sort((a, b) =>
    a.hasUpdate === b.hasUpdate ? a.name.localeCompare(b.name) : a.hasUpdate ? -1 : 1
  );
  const excluded = list
    .filter((i) => !i.ignored && excludedNames.has(i.name))
    .map((i) => ({ name: i.name, installed: i.installed, dir: i.dir, latest: i.latest }));
  const ignored = list
    .filter((i) => i.ignored)
    .map((i) => ({ name: i.name, reason: i.ignoreReason }));
  const settings = await readSettings();
  return {
    checkedAt: Date.now(),
    plugins: active,
    excluded,
    ignored,
    suppressPluginBanner: settings.suppressPluginBanner,
    floatingEnabled: settings.floatingEnabled,
    notifyEnabled: settings.notifyEnabled,
  };
}


async function exists(p) {
  return lstat(p).then(() => true).catch(() => false);
}


async function opsLog(entry) {
  try {
    await mkdir(DSH_HOME, { recursive: true }).catch(() => {});
    const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
    await appendFile(OPS_LOG, line + "\n", "utf8");
  } catch {
    
  }
}


async function readBackupRoot() {
  const s = await readState();
  const v = s.backupRoot;
  return typeof v === "string" && v.trim() ? v.trim() : BACKUP_DIR_DEFAULT;
}

async function writeBackupRoot(path) {
  const p = String(path || "").trim();
  if (!p) throw Object.assign(new Error("backup folder path required"), { code: "EINVALID" });
  
  if (!/^[a-zA-Z]:[\\/]/.test(p) && !/^\\\\/.test(p)) {
    throw Object.assign(new Error("backup folder must be an absolute path"), { code: "EINVALID" });
  }
  await writeState({ backupRoot: p });
  return p;
}

async function backupDirs() {
  const root = await readBackupRoot();
  return { main: root, plugins: join(root, "plugins") };
}


let legacyMigrated = false;
async function migrateLegacyBackups() {
  if (legacyMigrated) return;
  legacyMigrated = true;
  try {
    const { plugins } = await backupDirs();
    if (!(await exists(plugins)) && (await exists(LEGACY_PLUGIN_BACKUP_ROOT))) {
      await mkdir(dirname(plugins), { recursive: true });
      await rename(LEGACY_PLUGIN_BACKUP_ROOT, plugins);
    }
  } catch {
    
  }
}


async function clearAllBackups() {
  const { main, plugins } = await backupDirs();
  let removed = 0;
  for (const d of [main, plugins]) {
    try {
      const entries = await readdir(d, { withFileTypes: true });
      for (const e of entries) {
        
        if (d === main && e.name === "plugins") continue;
        await rm(join(d, e.name), { recursive: true, force: true }).catch(() => {});
        removed++;
      }
    } catch {
      
    }
  }
  return { removed };
}



function pickFolderWithDialog(initialPath) {
  return new Promise((resolve, reject) => {
    
    
    const ps = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "$owner = New-Object System.Windows.Forms.Form",
      '$owner.Text = "选择备份文件夹"',
      "$owner.TopMost = $true",
      "$owner.ShowInTaskbar = $true",
      "$owner.WindowState = 'Minimized'",
      "$owner.StartPosition = 'CenterScreen'",
      "$owner.Show()",
      "$owner.Activate()",
      "$f = New-Object System.Windows.Forms.FolderBrowserDialog",
      '$f.Description = "选择 dsh-update-checker 备份文件夹"',
      `$f.SelectedPath = '${String(initialPath || "").replace(/'/g, "''")}'`,
      "if ($f.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::WriteLine($f.SelectedPath) }",
      "$owner.Close()",
    ].join("; ");
    const encoded = Buffer.from(ps, "utf16le").toString("base64");
    const child = spawn(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      ["-NoProfile", "-EncodedCommand", encoded],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
    );
    let out = "";
    child.stdout.on("data", (d) => {
      out += d.toString("utf8");
    });
    child.stderr.on("data", () => {
      
    });
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        
      }
      resolve(null);
    }, 5 * 60 * 1000);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", () => {
      clearTimeout(timer);
      const p = out.trim();
      resolve(p && /^[a-zA-Z]:[\\/]/.test(p) ? p : null);
    });
  });
}


let progressCache = null;

async function writeProgress(patch) {
  try {
    progressCache = { at: Date.now(), running: true, ...(progressCache || {}), ...patch };
    await writeFile(UPDATE_PROGRESS_FILE, JSON.stringify(progressCache, null, 2), "utf8");
  } catch {
    
  }
}

async function clearProgress() {
  progressCache = null;
  try {
    await rm(UPDATE_PROGRESS_FILE, { force: true });
  } catch {
    
  }
}

async function readProgress() {
  try {
    return JSON.parse(await readFile(UPDATE_PROGRESS_FILE, "utf8"));
  } catch {
    return null;
  }
}


async function countLockfilePackages(root) {
  try {
    const lk = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
    return lk && lk.packages ? Object.keys(lk.packages).filter((k) => k.startsWith("node_modules/")).length : 0;
  } catch {
    return 0;
  }
}




function runNpmProgress(args, opts = {}, onProgress) {
  return new Promise((resolve, reject) => {
    const timeoutMs = opts.timeout || 600000;
    const child = spawn(resolveNodeExe(), [getNpmCli(), ...args], {
      cwd: opts.cwd,
      windowsHide: true,
      env: opts.env,
    });
    let stdout = "";
    let stderr = "";
    let httpCount = 0;
    let lastEmit = 0;
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
    const maybeEmit = (done) => {
      const now = Date.now();
      if (onProgress && (done || now - lastEmit > 200)) {
        lastEmit = now;
        onProgress({ httpCount, done: !!done, stderrTail: stderr.slice(-400), stdoutTail: stdout.slice(-400) });
      }
    };
    child.stdout.on("data", (d) => {
      stdout += d.toString("utf8");
      markActivity();
      maybeEmit(false);
    });
    child.stderr.on("data", (d) => {
      const s = d.toString("utf8");
      stderr += s;
      httpCount += (s.match(/npm http /g) || []).length;
      markActivity();
      maybeEmit(false);
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      clearInterval(deadlockTimer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      clearInterval(deadlockTimer);
      maybeEmit(true);
      if (deadlocked) {
        const err = new Error(
          "npm deadlock detected (no output for 120s) — killed to protect the deployment"
        );
        err.stderr = stderr;
        err.stdout = stdout;
        err.code = "ENPMDEADLOCK";
        return reject(err);
      }
      if (timedOut) {
        const err = new Error(
          `npm install timed out after ${Math.round(timeoutMs / 1000)}s — killed to protect the deployment`
        );
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


function extractTarGzToDir(buf, destDir) {
  const gz = gunzipSync(buf);
  let off = 0;
  const entries = [];
  while (off + 512 <= gz.length) {
    const nameRaw = gz.subarray(off, off + 100).toString("utf8").replace(/\0.*$/, "");
    if (!nameRaw) break;
    const size = parseInt(gz.subarray(off + 124, off + 136).toString("utf8").replace(/\0.*$/, "").trim(), 8) || 0;
    const type = gz[off + 156] || 48;
    if (type === 48 || type === 0) entries.push({ name: nameRaw, data: gz.subarray(off + 512, off + 512 + size) });
    off += 512 + Math.ceil(size / 512) * 512;
  }
  const top = entries.map((e) => e.name.split("/")[0]).find(Boolean) || "package";
  const root = join(destDir, top);
  for (const e of entries) {
    const rel = e.name.split("/").slice(1).join("/");
    if (!rel) continue;
    const target = resolve(destDir, e.name); 
    if (!target.startsWith(resolve(destDir))) continue;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, e.data);
  }
  return root;
}









async function verifyDeployTree(deployRoot, targetVersion) {
  const problems = [];
  const nm = join(deployRoot, "node_modules", "@deepseek-ai");
  let names = [];
  try {
    names = (await readdir(nm, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    problems.push(`@deepseek-ai dir missing: ${nm}`);
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
  
  for (const n of names) {
    if (!n.startsWith("dsh-")) continue;
    if (skippedPkgs.has(n)) continue; 
    const pj = join(nm, n, "package.json");
    try {
      const pkg = JSON.parse(await readFile(pj, "utf8"));
      if (pkg.version !== targetVersion) {
        problems.push(`${n} version ${pkg.version || "?"} != target ${targetVersion}`);
      }
    } catch {
      problems.push(`${n} package.json missing/unreadable`);
    }
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
        else {
          let rel = full.slice(dist.length).replace(/\\/g, "/");
          if (!rel.startsWith("/")) rel = "/" + rel;
          present.add(rel);
        }
      }
    };
    await walk(dist);
    for (const ref of refs) {
      if (!present.has(ref)) problems.push(`dist missing asset: ${ref}`);
    }
    
    if (!(await exists(join(nm, "dsh-web-frontend", "package.json")))) {
      problems.push("dsh-web-frontend package.json missing (metadata wiped)");
    }
  } catch {
    problems.push("dsh-web-frontend dist/index.html unreadable");
  }
  
  
  
  const ENTRY_NAMES = ["client.js", "index.js", "index.cjs", "index.mjs", "bin.js", "main.js", "server.js"];
  for (const n of names) {
    if (skippedPkgs.has(n)) continue; 
    const pkgDir = join(nm, n);
    const hasLib = await exists(join(pkgDir, "lib"));
    if (!hasLib) continue; 
    let entry = false;
    for (const en of ENTRY_NAMES) {
      if (await exists(join(pkgDir, "lib", en))) { entry = true; break; }
    }
    if (!entry) {
      for (const en of ENTRY_NAMES) {
        if (await exists(join(pkgDir, en))) { entry = true; break; }
      }
    }
    if (!entry) problems.push(`${n} has lib/ but no entry file (empty shell)`);
  }
  return { ok: problems.length === 0, problems };
}



function resolveEntryFile(pkg) {
  if (pkg && typeof pkg.main === "string" && pkg.main) return pkg.main;
  const ex = pkg && pkg.exports;
  if (ex) {
    if (typeof ex === "string") return ex;
    const dot = ex["."];
    if (typeof dot === "string") return dot;
    if (dot && typeof dot === "object") {
      const req = dot.require || dot.import || dot.default;
      if (typeof req === "string") return req;
    }
  }
  return null;
}




async function backupAndReplace(dst, src, filter, manifestSpec) {
  try {
    const st = await lstat(dst);
    if (st.isSymbolicLink()) await rm(dst, { recursive: false, force: true });
  } catch {
    
  }
  let backupDir = null;
  if (await exists(dst)) {
    await migrateLegacyBackups();
    backupDir = join((await backupDirs()).plugins, `${basename(dst)}-${Date.now()}`);
    await mkdir(backupDir, { recursive: true });
    await cp(dst, join(backupDir, basename(dst)), { recursive: true, force: true });
    let pkgName = null;
    try {
      pkgName = JSON.parse(await readFile(join(dst, "package.json"), "utf8")).name;
    } catch {
      
    }
    await writeFile(
      join(backupDir, "backup-info.json"),
      JSON.stringify(
        {
          name: basename(dst),
          pkgName,
          original: dst,
          at: Date.now(),
          manifestSpec: typeof manifestSpec === "string" ? manifestSpec : null,
        },
        null,
        2
      ),
      "utf8"
    );
    await rm(dst, { recursive: true, force: true });
  }
  await mkdir(dirname(dst), { recursive: true }).catch(() => {});
  await cp(src, dst, { recursive: true, force: true, ...(filter ? { filter } : {}) });
  return backupDir;
}



function planDepMerges(depSpecs, installedMap) {
  const out = [];
  for (const [dep, range] of Object.entries(depSpecs || {})) {
    const installed = Object.prototype.hasOwnProperty.call(installedMap || {}, dep)
      ? installedMap[dep]
      : null;
    if (installed === null || installed === undefined) {
      out.push({ dep, range, installed: null, action: "copy" });
      continue;
    }
    if (typeof installed !== "string") {
      out.push({ dep, range, installed, action: "replace" });
      continue;
    }
    out.push({
      dep,
      range,
      installed,
      action: satisfies(installed, range) ? "keep" : "replace",
    });
  }
  return out;
}










function derivePersistedSpec(oldSpec, newVersion, gh) {
  if (!oldSpec || typeof oldSpec !== "string") return null;
  const s = oldSpec.trim();
  if (!s) return null;
  if (typeof newVersion !== "string" || !/^\d+\.\d+\.\d+([-.][0-9A-Za-z.-]+)?$/.test(newVersion)) {
    return null; 
  }
  const caretTilde = /^(\^|~)/.exec(s);
  if (caretTilde) return `${caretTilde[1]}${newVersion}`;
  if (/^[vV]?\d+\.\d+\.\d+([-.][0-9A-Za-z.-]+)?$/.test(s)) return newVersion; 
  const cmp = /^([<>=]+)/.exec(s);
  if (cmp && !/[\s|]/.test(s)) return `${cmp[1]}${newVersion}`; 
  if (/^[\d\s<>=~^|*-]/.test(s)) return `^${newVersion}`; 
  if (gh && gh.source === "github" && gh.tag) {
    const m = /^(?:git\+)?(?:https?:\/\/github\.com\/|git:\/\/github\.com\/|github:)([^#]+?)(?:\.git)?(?:#.*)?$/.exec(s);
    if (m && m[1]) return `github:${m[1]}#${gh.tag}`;
    if (gh.owner && gh.repo) return `github:${gh.owner}/${gh.repo}#${gh.tag}`;
  }
  return null;
}


async function backupDep(name, dst) {
  const root = join((await backupDirs()).plugins, `dep-${name.replace(/[/\\]/g, "-")}-${Date.now()}`);
  await mkdir(root, { recursive: true });
  await cp(dst, join(root, basename(dst)), { recursive: true, force: true });
  return root;
}



async function mergeDependencies(depRoot, targetDir) {
  let pkg;
  try {
    pkg = JSON.parse(await readFile(join(targetDir, "package.json"), "utf8"));
  } catch {
    return [];
  }
  const specs = { ...(pkg.dependencies || {}), ...(pkg.optionalDependencies || {}) };
  const installedMap = {};
  for (const dep of Object.keys(specs)) {
    const rel = dep.split("/");
    const dDst = join(PROFILE_NODE_MODULES, ...rel);
    try {
      const st = await lstat(dDst);
      if (st.isSymbolicLink()) {
        installedMap[dep] = "·junction·";
        continue;
      }
      installedMap[dep] = JSON.parse(await readFile(join(dDst, "package.json"), "utf8")).version;
    } catch {
      installedMap[dep] = null;
    }
  }
  const plan = planDepMerges(specs, installedMap);
  const results = [];
  for (const item of plan) {
    const rel = item.dep.split("/");
    const dSrc = join(depRoot, ...rel);
    if (!(await exists(dSrc))) {
      results.push({ dep: item.dep, action: "missing-in-tmp", range: item.range });
      continue;
    }
    if (item.installed === "·junction·") {
      results.push({ dep: item.dep, action: "keep-junction", range: item.range });
      continue;
    }
    const dDst = join(PROFILE_NODE_MODULES, ...rel);
    if (item.action === "copy") {
      await mkdir(dirname(dDst), { recursive: true }).catch(() => {});
      await cp(dSrc, dDst, { recursive: true, force: true });
      results.push({ dep: item.dep, action: "copy", range: item.range, from: null });
    } else if (item.action === "replace") {
      const backupDir = await backupDep(item.dep, dDst).catch(() => null);
      await rm(dDst, { recursive: true, force: true }).catch(() => {});
      await cp(dSrc, dDst, { recursive: true, force: true });
      results.push({
        dep: item.dep,
        action: "replace",
        range: item.range,
        from: item.installed,
        backup: backupDir,
      });
    } else {
      results.push({ dep: item.dep, action: "keep", range: item.range, from: item.installed });
    }
  }
  return results;
}


async function collectScriptPackages(nmDir) {
  const out = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name === ".bin") continue;
      const sub = join(dir, e.name);
      if (e.name.startsWith("@")) {
        await walk(sub);
        continue;
      }
      try {
        const pj = JSON.parse(await readFile(join(sub, "package.json"), "utf8"));
        const sc = pj.scripts || {};
        if (sc.install || sc.preinstall || sc.postinstall) out.push(pj.name || e.name);
      } catch {
        
      }
    }
  }
  await walk(nmDir);
  return [...new Set(out)];
}



async function ensureScriptsBuilt(nmRoot, extraArgs) {
  const npmMajor = readNpmMajor();
  if (npmMajor === null || npmMajor < 12) return { npmMajor, pass2: false };
  const names = await collectScriptPackages(join(nmRoot, "node_modules"));
  if (!names.length) return { npmMajor, pass2: false, names: [] };
  const args = [
    "install",
    "--prefix",
    nmRoot,
    "--no-save",
    "--package-lock=false",
    "--registry",
    REGISTRY,
    "--no-audit",
    "--no-fund",
    `--allow-scripts=${names.join(",")}`,
  ];
  await runNpm(args, { cwd: nmRoot, timeout: 600000 });
  return { npmMajor, pass2: true, names };
}


function buildPluginInstallArgs(tmp, spec) {
  return [
    "install",
    spec,
    "--prefix",
    tmp,
    "--no-save",
    "--package-lock=false",
    "--registry",
    REGISTRY,
    "--no-audit",
    "--no-fund",
  ];
}


function buildStageInstallArgs(root) {
  return [
    "install",
    "--prefix",
    root,
    "--no-save",
    "--package-lock=false",
    "--registry",
    REGISTRY,
    "--no-audit",
    "--no-fund",
    "--omit=dev",
  ];
}


async function finalizePluginInstall(target, pkgRoot, depRoot, extra, copyFilter) {
  const newPkg = JSON.parse(await readFile(join(pkgRoot, "package.json"), "utf8"));
  const newVersion =
    typeof newPkg.version === "string" && newPkg.version ? newPkg.version : null;
  if (!newVersion) throw new Error("new plugin package.json has no version");
  const manifestSpec = await readManifestSpecFor(target.name, target.dir);
  const backupDir = await backupAndReplace(target.dir, pkgRoot, copyFilter, manifestSpec);
  const merged = await mergeDependencies(depRoot, target.dir);
  npmLatestCache.delete(target.name);
  if (target.ghRepo) ghLatestCache.delete(target.ghRepo);
  await writeSuppressPluginBanner(false);
  
  
  const persisted = await persistPluginUpdate({
    name: target.name,
    newVersion,
    targetDir: target.dir,
    gh:
      extra && extra.source === "github"
        ? {
            source: "github",
            owner: target.ghRepo ? String(target.ghRepo).split("/")[0] : null,
            repo: target.ghRepo ? String(target.ghRepo).split("/")[1] : null,
            tag: extra.ghTag || null,
          }
        : null,
  }).catch((err) => ({
    manifest: [],
    lockfile: [],
    error: truncate(String((err && err.message) || err), 1000),
  }));
  return {
    ok: true,
    name: target.name,
    installed: newVersion,
    backupDir,
    merged,
    source: extra.source,
    npmOutput: extra.npmOutput || null,
    allowScripts: extra.allowScripts || null,
    persisted,
  };
}










function profileDirOf(targetDir) {
  if (!targetDir || !PROFILES_ROOT) return null;
  const rel = String(targetDir);
  if (!rel.startsWith(PROFILES_ROOT)) return null;
  const rest = rel.slice(PROFILES_ROOT.length).split(/[\\/]/).filter(Boolean);
  if (rest.length >= 2 && rest[1] === "node_modules") return join(PROFILES_ROOT, rest[0]);
  return null;
}



async function findDeclaringProfiles(pluginName, targetDir) {
  const out = new Set();
  const implied = profileDirOf(targetDir);
  if (implied) out.add(implied);
  try {
    const dirs = await readdir(PROFILES_ROOT, { withFileTypes: true });
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const manifest = join(PROFILES_ROOT, d.name, "package.json");
      let pkg;
      try {
        pkg = JSON.parse(await readFile(manifest, "utf8"));
      } catch {
        continue;
      }
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      if (Object.prototype.hasOwnProperty.call(deps, pluginName)) out.add(join(PROFILES_ROOT, d.name));
    }
  } catch {
    
  }
  return [...out];
}


async function readManifestSpecFor(pluginName, targetDir) {
  const profiles = await findDeclaringProfiles(pluginName, targetDir);
  for (const dir of profiles) {
    try {
      const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
      const section = declaredSection(pkg, pluginName);
      const spec = pkg[section] && pkg[section][pluginName];
      if (typeof spec === "string") return spec;
    } catch {
      
    }
  }
  return null;
}













function pnpmCandidates(exeDir, npmCli, platform = process.platform) {
  const isWin = platform === "win32";
  const list = [];
  
  list.push({ cmd: join(exeDir, "node_modules", "pnpm", "bin", "pnpm.cjs"), viaNode: true, corepack: false });
  
  list.push({ cmd: join(exeDir, "..", "lib", "node_modules", "pnpm", "bin", "pnpm.cjs"), viaNode: true, corepack: false });
  if (!isWin) {
    
    list.push({ cmd: join(exeDir, "pnpm"), viaNode: false, corepack: false });
    list.push({ cmd: join(exeDir, "corepack"), viaNode: false, corepack: true });
  } else {
    
    list.push({ cmd: join(exeDir, "corepack.cmd"), viaNode: false, corepack: true });
    list.push({ cmd: join(exeDir, "corepack.exe"), viaNode: false, corepack: true });
  }
  
  
  if (npmCli) {
    const npmGlobalRoot = dirname(dirname(dirname(npmCli)));
    list.push({ cmd: join(npmGlobalRoot, "pnpm", "bin", "pnpm.cjs"), viaNode: true, corepack: false });
    if (isWin) {
      list.push({ cmd: join(npmGlobalRoot, "pnpm", "bin", "pnpm.cmd"), viaNode: false, corepack: false });
    }
  }
  return list;
}



function findPnpmInPath() {
  const isWin = process.platform === "win32";
  const exts = isWin ? [".cmd", ".exe", ".bat"] : [""];
  const dirs = String(process.env.PATH || "").split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const shim = join(dir, "pnpm" + ext);
      if (!existsSync(shim)) continue;
      if (isWin && ext === ".cmd") {
        const real = join(dir, "node_modules", "pnpm", "bin", "pnpm.cjs");
        if (existsSync(real)) return { cmd: real, viaNode: true, corepack: false };
      }
      return { cmd: shim, viaNode: false, corepack: false };
    }
  }
  return null;
}

function findPnpm() {
  if (process.env.DSH_UC_PNPM_BIN) {
    if (process.env.DSH_UC_PNPM_BIN === "__none__") return null;
    return {
      cmd: process.env.DSH_UC_PNPM_BIN,
      viaNode: /\.(?:m|c)?js$/i.test(process.env.DSH_UC_PNPM_BIN),
      corepack: false,
    };
  }
  for (const c of pnpmCandidates(dirname(resolveNodeExe()), getNpmCli())) {
    if (existsSync(c.cmd)) return c;
  }
  return findPnpmInPath();
}

async function runPnpm(args, opts = {}) {
  const found = findPnpm();
  if (!found) throw Object.assign(new Error("pnpm not found"), { code: "ENOPNPM" });
  const argv = found.corepack ? ["pnpm", ...args] : args;
  const full = found.viaNode ? [found.cmd, ...argv] : argv;
  const cmd = `"${found.viaNode ? resolveNodeExe() : found.cmd}" ${full.map((a) => `"${a}"`).join(" ")}`;
  return execP(cmd, {
    cwd: opts.cwd,
    timeout: opts.timeout || 600000,
    maxBuffer: opts.maxBuffer || 8 * 1024 * 1024,
    windowsHide: true,
  });
}



async function syncLockfile(profileDir) {
  if (await exists(join(profileDir, "pnpm-lock.yaml"))) {
    try {
      const { stdout, stderr } = await runPnpm(
        ["install", "--lockfile-only", "--no-frozen-lockfile"],
        { cwd: profileDir }
      );
      return { profile: profileDir, pm: "pnpm", ok: true, output: truncate((stdout || "") + (stderr || ""), 1000) };
    } catch (err) {
      return {
        profile: profileDir,
        pm: "pnpm",
        ok: false,
        code: err && err.code,
        error: truncate(String((err && err.message) || err), 1000),
      };
    }
  }
  if (await exists(join(profileDir, "package-lock.json"))) {
    try {
      const { stdout, stderr } = await runNpm(
        ["install", "--package-lock-only", "--registry", REGISTRY, "--no-audit", "--no-fund"],
        { cwd: profileDir }
      );
      return { profile: profileDir, pm: "npm", ok: true, output: truncate((stdout || "") + (stderr || ""), 1000) };
    } catch (err) {
      return {
        profile: profileDir,
        pm: "npm",
        ok: false,
        code: err && err.code,
        error: truncate(String((err && err.message) || err), 1000),
      };
    }
  }
  return { profile: profileDir, pm: null, ok: true, skipped: true };
}


function declaredSection(pkg, name) {
  if (pkg && pkg.devDependencies && Object.prototype.hasOwnProperty.call(pkg.devDependencies, name)) {
    return "devDependencies";
  }
  return "dependencies";
}


async function persistPluginSpec(name, targetDir, newSpec) {
  const profiles = await findDeclaringProfiles(name, targetDir);
  const manifest = [];
  for (const dir of profiles) {
    try {
      const manifestPath = join(dir, "package.json");
      const pkg = JSON.parse(await readFile(manifestPath, "utf8"));
      const section = declaredSection(pkg, name);
      const deps = pkg[section] || {};
      const oldSpec = deps[name];
      if (oldSpec === newSpec) {
        manifest.push({ profile: dir, changed: false, spec: newSpec });
        continue;
      }
      deps[name] = newSpec;
      pkg[section] = deps;
      await writeFile(manifestPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");
      manifest.push({ profile: dir, changed: true, oldSpec: oldSpec || null, spec: newSpec });
    } catch (err) {
      manifest.push({
        profile: dir,
        changed: false,
        error: truncate(String((err && err.message) || err), 1000),
      });
    }
  }
  const lockfile = [];
  for (const dir of profiles) lockfile.push(await syncLockfile(dir));
  return { manifest, lockfile };
}


async function persistPluginUpdate({ name, newVersion, targetDir, gh }) {
  const profiles = await findDeclaringProfiles(name, targetDir);
  const manifest = [];
  for (const dir of profiles) {
    try {
      const manifestPath = join(dir, "package.json");
      const pkg = JSON.parse(await readFile(manifestPath, "utf8"));
      const section = declaredSection(pkg, name);
      const oldSpec = pkg[section] && pkg[section][name];
      const newSpec = derivePersistedSpec(oldSpec, newVersion, gh);
      if (!newSpec) {
        manifest.push({ profile: dir, changed: false, spec: null, reason: "not-derivable" });
        continue;
      }
      if (newSpec === oldSpec) {
        manifest.push({ profile: dir, changed: false, spec: newSpec });
        continue;
      }
      pkg[section] = pkg[section] || {};
      pkg[section][name] = newSpec;
      await writeFile(manifestPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");
      manifest.push({ profile: dir, changed: true, oldSpec: oldSpec || null, spec: newSpec });
    } catch (err) {
      manifest.push({
        profile: dir,
        changed: false,
        error: truncate(String((err && err.message) || err), 1000),
      });
    }
  }
  const lockfile = [];
  for (const dir of profiles) lockfile.push(await syncLockfile(dir));
  return { manifest, lockfile };
}

function filterNoNodeModules(src) {
  return !String(src).split(/[\\/]/).includes("node_modules");
}



async function updatePluginFromGitHub(target, tag, version) {
  const tmp = await mkdtemp(join(tmpdir(), "dsh-update-checker-gh-"));
  try {
    const url = `https://codeload.github.com/${target.ghRepo}/tar.gz/${encodeURIComponent(tag)}`;
    
    
    
    let r;
    try {
      r = await ghRequest(url, {
        maxBytes: MAX_TARBALL_BYTES,
        headers: { accept: "application/octet-stream" },
      });
    } catch (err) {
      if (err && err.code === "ETOOBIG") throw err;
      throw Object.assign(
        new Error(`GitHub download failed: ${(err && err.message) || err}`),
        { code: "EDOWNLOAD" }
      );
    }
    if (r.status !== 200) {
      throw Object.assign(new Error(`GitHub download HTTP ${r.status}`), { code: "EDOWNLOAD" });
    }
    let pkgRoot;
    try {
      pkgRoot = extractTarGzToDir(r.buf, tmp);
    } catch (err) {
      throw Object.assign(
        new Error(`GitHub tarball corrupt: ${(err && err.message) || err}`),
        { code: "EDOWNLOAD" }
      );
    }
    const pkg = JSON.parse(await readFile(join(pkgRoot, "package.json"), "utf8"));
    const entry = resolveEntryFile(pkg);
    if (entry && !(await exists(join(pkgRoot, entry)))) {
      throw Object.assign(
        new Error(
          `GitHub repo ${target.ghRepo}@${tag} has no built artifact '${entry}' (source-only repo?) — refusing to replace the installed plugin`
        ),
        { code: "ENOBUILD" }
      );
    }
    if (pkg.version && version && compareVersions(pkg.version, version) !== 0) {
      throw Object.assign(
        new Error(
          `GitHub tag ${tag} (semver ${version}) does not match package.json version ${pkg.version}`
        ),
        { code: "ETAGMISMATCH" }
      );
    }
    
    const { stdout, stderr } = await runNpm(buildStageInstallArgs(pkgRoot), {
      cwd: pkgRoot,
      timeout: 600000,
    });
    const allowScripts = await ensureScriptsBuilt(pkgRoot, null);
    const npmOutput = truncate((stdout || "") + (stderr || ""), 2000);
    return await finalizePluginInstall(
      target,
      pkgRoot,
      join(pkgRoot, "node_modules"),
      { source: "github", npmOutput, allowScripts, ghTag: tag },
      filterNoNodeModules
    );
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}


async function updatePluginFromNpm(target, version) {
  const tmp = await mkdtemp(join(tmpdir(), "dsh-update-checker-"));
  try {
    const spec = `${target.name}@${version}`;
    const { stdout, stderr } = await runNpm(buildPluginInstallArgs(tmp, spec), {
      cwd: tmp,
      timeout: 600000,
    });
    const parts = target.name.split("/");
    const src = join(tmp, "node_modules", ...parts);
    try {
      await readFile(join(src, "package.json"), "utf8");
    } catch {
      throw new Error(
        "npm install produced no package: " + truncate((stdout || "") + (stderr || ""), 500)
      );
    }
    const allowScripts = await ensureScriptsBuilt(tmp, null);
    const npmOutput = truncate((stdout || "") + (stderr || ""), 2000);
    return await finalizePluginInstall(target, src, join(tmp, "node_modules"), {
      source: "npm",
      npmOutput,
      allowScripts,
    });
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}




function isGhFallbackable(err) {
  return !!err && ["ENOBUILD", "ETAGMISMATCH", "ETOOBIG", "EDOWNLOAD", "ENOENT", "ENOPKG"].includes(err.code);
}

async function updatePlugin(name) {
  const installed = await scanInstalledPlugins();
  const target = installed.find((p) => p.name === name);
  if (!target || !target.dir) {
    throw Object.assign(new Error(`plugin not installed or not updatable: ${name}`), {
      code: "EINVALID",
    });
  }
  const probe = await checkPlugin(target, true);
  if (!probe.latest) {
    throw Object.assign(new Error(`no update source for ${name}: ${probe.error || "unknown"}`), {
      code: "ENOSOURCE",
    });
  }
  
  if (probe.targetSource === "github" && probe.ghTag) {
    try {
      return await updatePluginFromGitHub(target, probe.ghTag, probe.latest);
    } catch (err) {
      
      
      
      
      
      
      const smartFallback = probe.tie === true && probe.downloadSource === "smart";
      const fallbackable = smartFallback || isGhFallbackable(err);
      if (fallbackable && probe.onNpm && probe.npmLatest) {
        await opsLog({
          op: "plugin-update-fallback",
          name,
          from: probe.installed || null,
          to: probe.npmLatest,
          reason: String((err && err.message) || err),
          code: err && err.code,
          mode: smartFallback ? "smart" : "gh-fallbackable",
        });
        return await updatePluginFromNpm(target, probe.npmLatest);
      }
      throw err;
    }
  }
  return await updatePluginFromNpm(target, probe.latest);
}


async function listMainBackups() {
  try {
    const main = (await backupDirs()).main;
    const dirs = await readdir(main, { withFileTypes: true });
    const out = [];
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      
      if (d.name === "plugins") continue;
      let meta = null;
      try {
        meta = JSON.parse(await readFile(join(main, d.name, "backup-meta.json"), "utf8"));
      } catch {
        
      }
      out.push({
        id: d.name,
        dir: join(main, d.name),
        at: d.name,
        installed: meta && meta.installed ? meta.installed : null,
        type: meta && meta.type ? meta.type : null,
      });
    }
    return out.sort((a, b) => (a.at < b.at ? 1 : -1));
  } catch {
    return [];
  }
}

async function listPluginBackups() {
  await migrateLegacyBackups();
  try {
    const pluginsDir = (await backupDirs()).plugins;
    const dirs = await readdir(pluginsDir, { withFileTypes: true });
    const out = [];
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      let info = null;
      try {
        info = JSON.parse(await readFile(join(pluginsDir, d.name, "backup-info.json"), "utf8"));
      } catch {
        
      }
      out.push({
        id: d.name,
        name: (info && info.name) || d.name,
        pkgName: (info && info.pkgName) || null,
        original: (info && info.original) || null,
        at: (info && info.at) || 0,
        kind: d.name.startsWith("dep-") ? "dep" : "plugin",
      });
    }
    return out.sort((a, b) => b.at - a.at);
  } catch {
    return [];
  }
}


async function rollbackMain() {
  const root = await findDeployRoot();
  if (!root) throw Object.assign(new Error("deployment root not found"), { code: "ENOENT" });
  const backups = await listMainBackups();
  if (!backups.length) {
    throw Object.assign(new Error("no main-program backup found"), { code: "ENOBACKUP" });
  }
  const target = backups[0];
  if (!target.installed) {
    throw Object.assign(
      new Error(`backup ${target.id} is missing the recorded installed version`),
      { code: "ENOBACKUP" }
    );
  }
  const spec = `${PACKAGE}@${target.installed}`;
  await dryRunGuard(root, spec); 
  const safetyBackup = await backupForUpdate(root); 
  const { args, type } = buildNpmInstallArgs(root, spec);
  const { stdout, stderr } = await runNpm(args, { cwd: root, timeout: 600000 });
  const installed = await readInstalledVersion();
  const ok = installed && target.installed && compareVersions(installed, target.installed) === 0;
  const plan = await planSync(root);
  const synced = await runSync(root, plan.todo);
  const failed = synced.filter((s) => !s.ok);
  await writeSuppressUpToDate(false);
  return {
    ok,
    installed,
    expected: target.installed,
    type,
    backup: target.id,
    safetyBackup,
    synced: synced.map((s) => (s.ok ? s.name : `${s.name} (FAILED: ${s.error})`)),
    syncFailed: failed.length,
    output: truncate((stdout || "") + (stderr || ""), 2000),
  };
}


async function rollbackPlugin(id) {
  if (
    !id ||
    typeof id !== "string" ||
    id.includes("..") ||
    id.includes("/") ||
    id.includes("\\")
  ) {
    throw Object.assign(new Error("invalid backup id"), { code: "EINVALID" });
  }
  const dir = join((await backupDirs()).plugins, id);
  if (!(await exists(dir))) {
    throw Object.assign(new Error(`backup not found: ${id}`), { code: "ENOBACKUP" });
  }
  let info = null;
  try {
    info = JSON.parse(await readFile(join(dir, "backup-info.json"), "utf8"));
  } catch {
    
  }
  const name = (info && info.name) || id.replace(/-\d+$/, "");
  const original = (info && info.original) || join(PROFILE_NODE_MODULES, name);
  const resolvedOriginal = resolve(original);
  if (!resolvedOriginal.startsWith(resolve(PROFILE_NODE_MODULES) + sep)) {
    throw Object.assign(new Error("backup target outside profiles/node_modules"), {
      code: "EINVALID",
    });
  }
  const src = join(dir, basename(original));
  if (!(await exists(src))) {
    throw new Error(`backup content missing: ${src}`);
  }
  try {
    const st = await lstat(resolvedOriginal);
    if (st.isSymbolicLink()) await rm(resolvedOriginal, { recursive: false, force: true });
  } catch {
    
  }
  if (await exists(resolvedOriginal)) {
    await rm(resolvedOriginal, { recursive: true, force: true });
  }
  await mkdir(dirname(resolvedOriginal), { recursive: true }).catch(() => {});
  await cp(src, resolvedOriginal, { recursive: true, force: true });
  let ver = null;
  let pkgName = null;
  try {
    const pj = JSON.parse(await readFile(join(resolvedOriginal, "package.json"), "utf8"));
    ver = pj.version;
    pkgName = pj.name;
  } catch {
    
  }
  const manifestName = pkgName || (info && info.pkgName) || name;
  
  const persistedSpec = (info && info.manifestSpec) || null;
  let persisted = null;
  if (persistedSpec) {
    persisted = await persistPluginSpec(manifestName, resolvedOriginal, persistedSpec).catch(
      (err) => ({
        manifest: [],
        lockfile: [],
        error: truncate(String((err && err.message) || err), 1000),
      })
    );
  }
  npmLatestCache.delete(name);
  return { ok: true, name, installed: ver, backup: id, persisted };
}


function readJsonBody(req) {
  return new Promise((resolveBody) => {
    let chunks = "";
    let tooLarge = false;
    req.on("data", (c) => {
      if (tooLarge) return; 
      if (chunks.length + c.length > MAX_BODY_BYTES) {
        tooLarge = true;
        return;
      }
      chunks += c;
    });
    req.on("end", () => {
      if (tooLarge) return resolveBody({ tooLarge: true });
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




function isLoopback(req) {
  const a = req && req.socket && req.socket.remoteAddress;
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
}


async function writeGate(req, res) {
  if (!isLoopback(req)) {
    return { err: json(res, 403, { ok: false, error: "loopback required" }) };
  }
  const body = await readJsonBody(req);
  if (body && body.tooLarge) {
    return { err: json(res, 413, { ok: false, error: "body too large" }) };
  }
  if (body && body.parseError) {
    return { err: json(res, 400, { ok: false, error: "invalid JSON body" }) };
  }
  if (body && body.confirm !== true) {
    return { err: json(res, 400, { ok: false, error: "confirm required" }) };
  }
  return { body };
}

export default {
  name: "dsh-update-checker",
  apply(ctx) {
    
    
    
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

      
      webServer.register({
        kind: "exact",
        path: "/dsh-update-checker/suppress",
        handler: async (req, res) => {
          const g = await writeGate(req, res);
          if (g.err) return;
          const ok = await writeSuppressUpToDate(true);
          return json(res, ok ? 200 : 500, ok ? { ok: true } : { ok: false, error: "failed to write state" });
        },
      });

      
      
      
      
      
      webServer.register({
        kind: "exact",
        path: "/dsh-update-checker/update",
        handler: async (req, res) => {
          const g = await writeGate(req, res);
          if (g.err) return;
          const body = g.body;
          const LOCK_FILE = join(DSH_HOME, "dsh-update-checker-update.lock");
          if (updateInFlight && Date.now() - updateStartedAt < 600000)
            return json(res, 409, { ok: false, error: "update already running" });
          try {
            const st = await lstat(LOCK_FILE);
            if (st.mtimeMs && Date.now() - st.mtimeMs < 600000)
              return json(res, 409, { ok: false, error: "update already running (lock file)" });
          } catch {
            
          }
          const root = await findDeployRoot();
          if (!root) return json(res, 500, { ok: false, error: "deployment root not found" });
          const dry = body && body.dry === true;
          updateInFlight = true;
          updateStartedAt = Date.now();
          try {
            await mkdir(DSH_HOME, { recursive: true }).catch(() => {});
            await writeFile(
              LOCK_FILE,
              JSON.stringify({ at: Date.now(), pid: process.pid }),
              "utf8"
            );
            await clearProgress();
            await writeProgress({ phase: "check", label: "正在查询最新版本…", percent: 2 });
            const latestInfo = await resolveMainTarget(true); 
            const setts = await readSettings();
            if (isPrerelease(latestInfo.version) && !setts.allowPrerelease) {
              const detail = `${latestInfo.version} 是预发布版（alpha/beta/rc），默认禁止自动升级主框架；如需跟踪预发布，请在设置中开启 allowPrerelease`;
              await writeProgress({ phase: "error", running: false, percent: null, label: "更新失败", error: detail, code: "E_PRERELEASE" });
              await opsLog({ op: "main-update-prerelease-blocked", target: latestInfo.version });
              updateInFlight = false;
              await rm(LOCK_FILE, { force: true }).catch(() => {});
              return json(res, 400, { ok: false, error: detail, code: "E_PRERELEASE" });
            }
            if (dry) {
              
              const result = await executeMainUpdate({
                deployRoot: root,
                targetVersion: latestInfo.version,
                backupDir: null,
                dryRunOnly: true,
              });
              return json(res, 200, {
                ok: true,
                dry: true,
                installed: await readInstalledVersion(),
                latest: latestInfo.version,
                syncPlan: (result.plan && result.plan.todo) || [],
                dryRun: result.dryRun,
              });
            }
            
            await writeProgress({ phase: "backup", label: "备份当前版本…", percent: 8 });
            const backupDir = await backupForUpdate(root); 
            await opsLog({ op: "main-update-backup", backupDir, to: latestInfo.version });
            const scriptPath = fileURLToPath(new URL("../scripts/main-update-worker.mjs", import.meta.url));
            const env = {
              ...process.env,
              DSH_UC_UPDATE_ROOT: root,
              DSH_UC_UPDATE_TARGET: latestInfo.version,
              DSH_UC_UPDATE_BACKUP: backupDir,
              DSH_UC_UPDATE_PROGRESS: UPDATE_PROGRESS_FILE,
              DSH_UC_UPDATE_OPS: OPS_LOG,
              DSH_UC_UPDATE_DSH_HOME: DSH_HOME,
              DSH_UC_UPDATE_SELF_DIR: fileURLToPath(new URL("..", import.meta.url)),
              
              DSH_UC_UPDATE_PROFILE_NM: PROFILE_NODE_MODULES,
            };
            
            
            
            
            const inner = `Start-Process -WindowStyle Hidden -FilePath '${resolveNodeExe()}' -ArgumentList '${scriptPath}'`;
            const child = spawn(
              "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
              ["-NoProfile", "-NonInteractive", "-Command", inner],
              { stdio: "ignore", windowsHide: true, env }
            );
            child.unref();
            return json(res, 200, {
              ok: true,
              message: "update started in background (download -> stop service -> install -> verify -> restart)",
              latest: latestInfo.version,
              backupDir,
            });
          } catch (err) {
            updateInFlight = false;
            const detail = String(
              err && err.stderr ? err.stderr : err && err.message ? err.message : err
            );
            await writeProgress({
              phase: "error",
              running: false,
              percent: null,
              label: "更新失败",
              error: truncate(detail, 2000),
              code: err && err.code,
            });
            await opsLog({
              op: "main-update-error",
              error: truncate(detail, 2000),
              code: err && err.code,
              stderr: err && err.stderr ? truncate(err.stderr, 2000) : null,
            });
            return json(res, 500, { ok: false, error: truncate(detail, 2000), code: err && err.code });
          }
        },
      });

      
      webServer.register({
        kind: "exact",
        path: "/dsh-update-checker/update-progress.json",
        handler: async (req, res) => {
          const p = await readProgress();
          if (!p) return json(res, 404, { ok: false, error: "no update in progress or recorded" });
          json(res, 200, p);
        },
      });

      
      webServer.register({
        kind: "exact",
        path: "/dsh-update-checker/rollback",
        handler: async (req, res) => {
          const g = await writeGate(req, res);
          if (g.err) return;
          if (updateInFlight && Date.now() - updateStartedAt < 600000)
            return json(res, 409, { ok: false, error: "update already running" });
          updateInFlight = true;
          updateStartedAt = Date.now();
          try {
            const result = await rollbackMain();
            await opsLog({
              op: "main-rollback",
              ok: !!result.ok,
              to: result.installed || null,
              expected: result.expected || null,
              backup: result.backup || null,
              error: result.ok ? null : truncate(result.output || "", 1000),
            });
            return json(res, result.ok ? 200 : 500, result);
          } catch (err) {
            await opsLog({
              op: "main-rollback-error",
              error: truncate(String(err && err.message ? err.message : err), 1000),
              code: err && err.code,
            });
            return json(res, 500, {
              ok: false,
              error: truncate(String(err && err.message ? err.message : err), 2000),
              code: err && err.code,
            });
          } finally {
            updateInFlight = false;
          }
        },
      });

      
      webServer.register({
        kind: "exact",
        path: "/dsh-update-checker/backups.json",
        handler: async (req, res) => {
          const [main, plugins] = await Promise.all([listMainBackups(), listPluginBackups()]);
          json(res, 200, { main, plugins });
        },
      });

      
      webServer.register({
        kind: "exact",
        path: "/dsh-update-checker/backup-settings.json",
        handler: async (req, res) => {
          const [main, plugins, dirs] = await Promise.all([listMainBackups(), listPluginBackups(), backupDirs()]);
          json(res, 200, {
            backupRoot: dirs.main,
            pluginBackupRoot: dirs.plugins,
            mainCount: main.length,
            pluginCount: plugins.filter((p) => p.kind === "plugin").length,
            depCount: plugins.filter((p) => p.kind === "dep").length,
          });
        },
      });

      
      webServer.register({
        kind: "exact",
        path: "/dsh-update-checker/backup-root",
        handler: async (req, res) => {
          const g = await writeGate(req, res);
          if (g.err) return;
          const body = g.body;
          try {
            const path = await writeBackupRoot(body && body.path);
            await opsLog({ op: "backup-root-set", path });
            return json(res, 200, { ok: true, backupRoot: path });
          } catch (err) {
            return json(res, 400, {
              ok: false,
              error: String(err && err.message ? err.message : err),
              code: err && err.code,
            });
          }
        },
      });

      
      webServer.register({
        kind: "exact",
        path: "/dsh-update-checker/backups-clear",
        handler: async (req, res) => {
          const g = await writeGate(req, res);
          if (g.err) return;
          try {
            const result = await clearAllBackups();
            await opsLog({ op: "backups-clear", removed: result.removed });
            return json(res, 200, { ok: true, ...result });
          } catch (err) {
            return json(res, 500, {
              ok: false,
              error: String(err && err.message ? err.message : err),
              code: err && err.code,
            });
          }
        },
      });

      
      webServer.register({
        kind: "exact",
        path: "/dsh-update-checker/backup-folder-pick",
        handler: async (req, res) => {
          if (!isLoopback(req)) return json(res, 403, { ok: false, error: "loopback required" });
          try {
            const dirs = await backupDirs();
            const picked = await pickFolderWithDialog(dirs.main);
            return json(res, 200, { ok: true, picked: !!picked, path: picked || null });
          } catch (err) {
            return json(res, 500, {
              ok: false,
              error: String(err && err.message ? err.message : err),
              code: err && err.code,
            });
          }
        },
      });

      
      webServer.register({
        kind: "exact",
        path: "/dsh-update-checker/backup-folder-open",
        handler: async (req, res) => {
          if (!isLoopback(req)) return json(res, 403, { ok: false, error: "loopback required" });
          try {
            const dirs = await backupDirs();
            await mkdir(dirs.main, { recursive: true }).catch(() => {});
            const child = spawn("C:\\Windows\\explorer.exe", [dirs.main], {
              detached: true,
              stdio: "ignore",
            });
            child.unref();
            return json(res, 200, { ok: true, path: dirs.main });
          } catch (err) {
            return json(res, 500, {
              ok: false,
              error: String(err && err.message ? err.message : err),
              code: err && err.code,
            });
          }
        },
      });

      
      
      webServer.register({
        kind: "exact",
        path: "/dsh-update-checker/restart",
        handler: async (req, res) => {
          const g = await writeGate(req, res);
          if (g.err) return;
          
          
          const now = Date.now();
          if (restartScheduled && now - restartStartedAt < 180000)
            return json(res, 409, { ok: false, error: "restart already scheduled" });
          restartScheduled = true;
          restartStartedAt = now;
          const root = await findDeployRoot();
          if (!root) return json(res, 500, { ok: false, error: "deployment root not found" });
          const port = typeof webServer.port === "number" ? webServer.port : 3080;
          try {
            const scriptPath = fileURLToPath(new URL("../scripts/restart-watchdog.ps1", import.meta.url));
            const launcherInfo = deriveLauncher();
            const env = {
              ...process.env,
              DSH_RESTART_PORT: String(port),
              DSH_RESTART_WORKDIR: launcherInfo ? launcherInfo.cwd : root,
              DSH_RESTART_LOG: RESTART_LOG,
              DSH_RESTART_RESULT: RESTART_RESULT,
              DSH_RESTART_PID: String(process.pid),
            };
            if (launcherInfo) {
              env.DSH_RESTART_NODE_FILE = launcherInfo.file;
              env.DSH_RESTART_NODE_ARGS = JSON.stringify(launcherInfo.args);
            } else {
              env.DSH_RESTART_LAUNCHER = await findLauncher(root);
            }
            const inner = `Start-Process -WindowStyle Hidden -FilePath 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' -ArgumentList '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File','${scriptPath}'`;
            const child = spawn(
              "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
              ["-NoProfile", "-NonInteractive", "-Command", inner],
              {
                stdio: "ignore",
                windowsHide: true,
                env,
              }
            );
            child.unref();
            await opsLog({
              op: "restart-scheduled",
              port,
              pid: process.pid,
              launcher: launcherInfo ? launcherInfo.args : env.DSH_RESTART_LAUNCHER,
            });
            return json(res, 200, {
              ok: true,
              message: "restart scheduled",
              port,
              pid: process.pid,
              launcher: launcherInfo ? launcherInfo.args : env.DSH_RESTART_LAUNCHER,
            });
          } catch (err) {
            restartScheduled = false;
            return json(res, 500, { ok: false, error: String(err && err.message ? err.message : err) });
          }
        },
      });

      
      webServer.register({
        kind: "exact",
        path: "/dsh-update-checker/restart-status.json",
        handler: async (req, res) => {
          try {
            const raw = await readFile(RESTART_RESULT, "utf8");
            return json(res, 200, JSON.parse(raw));
          } catch {
            return json(res, 404, { ok: false, error: "no restart recorded yet" });
          }
        },
      });

      
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

      
      webServer.register({
        kind: "exact",
        path: "/dsh-update-checker/plugin-update",
        handler: async (req, res) => {
          const g = await writeGate(req, res);
          if (g.err) return;
          const body = g.body;
          const name = body && typeof body.name === "string" ? body.name.trim() : "";
          if (!name) return json(res, 400, { ok: false, error: "name required" });
          if (pluginUpdateInFlight && Date.now() - pluginUpdateStartedAt < 600000)
            return json(res, 409, { ok: false, error: "plugin update already running" });
          pluginUpdateInFlight = true;
          pluginUpdateStartedAt = Date.now();
          try {
            const result = await updatePlugin(name);
            await opsLog({
              op: "plugin-update-ok",
              name,
              to: result.installed || null,
              source: result.source || null,
              merged: Array.isArray(result.merged) ? result.merged.length : null,
              persistedManifest:
                result.persisted && Array.isArray(result.persisted.manifest)
                  ? result.persisted.manifest.filter((m) => m.changed).length
                  : null,
              persistedLock:
                result.persisted && Array.isArray(result.persisted.lockfile)
                  ? result.persisted.lockfile.every((l) => l.ok)
                  : null,
            });
            return json(res, 200, result);
          } catch (err) {
            await opsLog({
              op: "plugin-update-error",
              name,
              error: truncate(String(err && err.message ? err.message : err), 2000),
              code: err && err.code,
            });
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

      
      webServer.register({
        kind: "exact",
        path: "/dsh-update-checker/plugin-rollback",
        handler: async (req, res) => {
          const g = await writeGate(req, res);
          if (g.err) return;
          const body = g.body;
          const id = body && typeof body.id === "string" ? body.id.trim() : "";
          if (!id) return json(res, 400, { ok: false, error: "id required" });
          if (pluginUpdateInFlight && Date.now() - pluginUpdateStartedAt < 600000)
            return json(res, 409, { ok: false, error: "plugin update already running" });
          pluginUpdateInFlight = true;
          pluginUpdateStartedAt = Date.now();
          try {
            const result = await rollbackPlugin(id);
            await opsLog({
              op: "plugin-rollback",
              name: result.name || null,
              to: result.installed || null,
              backup: id,
              persisted:
                result.persisted && Array.isArray(result.persisted.manifest)
                  ? result.persisted.manifest.filter((m) => m.changed).length
                  : null,
            });
            return json(res, result.ok ? 200 : 500, result);
          } catch (err) {
            await opsLog({
              op: "plugin-rollback-error",
              id,
              error: truncate(String(err && err.message ? err.message : err), 1000),
              code: err && err.code,
            });
            return json(res, 500, {
              ok: false,
              error: truncate(String(err && err.message ? err.message : err), 2000),
              code: err && err.code,
            });
          } finally {
            pluginUpdateInFlight = false;
          }
        },
      });

      
      webServer.register({
        kind: "exact",
        path: "/dsh-update-checker/plugin-suppress",
        handler: async (req, res) => {
          const g = await writeGate(req, res);
          if (g.err) return;
          const ok = await writeSuppressPluginBanner(true);
          return json(res, ok ? 200 : 500, ok ? { ok: true } : { ok: false, error: "failed to write state" });
        },
      });

      
      webServer.register({
        kind: "exact",
        path: "/dsh-update-checker/settings.json",
        handler: async (req, res) => {
          json(res, 200, await readSettings());
        },
      });

      
      
      webServer.register({
        kind: "exact",
        path: "/dsh-update-checker/settings",
        handler: async (req, res) => {
          const g = await writeGate(req, res);
          if (g.err) return;
          const body = g.body;
          const patch = {};
          for (const k of ["floatingEnabled", "notifyEnabled", "suppressUpToDate", "suppressPluginBanner", "allowPrerelease"]) {
            if (typeof body[k] === "boolean") patch[k] = body[k];
          }
          if (["github", "npm", "smart"].includes(body.downloadSource)) patch.downloadSource = body.downloadSource;
          await writeState(patch);
          return json(res, 200, { ok: true, settings: await readSettings() });
        },
      });

      webServer.register({
        kind: "exact",
        path: "/dsh-update-checker/plugin-exclude",
        handler: async (req, res) => {
          const g = await writeGate(req, res);
          if (g.err) return;
          const body = g.body;
          const name = body && typeof body.name === "string" ? body.name.trim() : "";
          if (!name) return json(res, 400, { ok: false, error: "name required" });
          const ok = await writeExcludedPlugin(name, !!(body && body.excluded));
          const list = normalizeExcludedPlugins((await readState()).excludedPlugins);
          return json(res, ok ? 200 : 500, { ok, excludedPlugins: list });
        },
      });
    });
  },
};


export {
  parseVersion,
  isPrerelease,
  compareVersions,
  tagToVersion,
  satisfies,
  pickNpmLatest,
  deriveRisk,
  deriveStatus,
  parseGhRepo,
  truncate,
  extractTarGzToDir,
  resolveEntryFile,
  planDepMerges,
  planSyncFromMaps,
  derivePersistedSpec,
  pnpmCandidates,
  pickTargetSource,
  pickMainLatest,
  mainTagToVersion,
  isGhFallbackable,
  isLoopback,
  ghRequest,
  fetchGitHubLatest,
  fetchGhReleaseNotes,
  ghTagBelongsTo,
  resolveNodeExe,
  getNpmCli,
  buildNodeExeCandidates,
  normalizeExcludedPlugins,
  readExcludedPlugins,
  writeExcludedPlugin,
};


export {
  readEcoVersions,
  runSync,
  backupForUpdate,
  planSync,
  findDeployRoot,
  probeNpmGlobalRoot,
  readInstalledVersion,
  listMainBackups,
  listPluginBackups,
  rollbackMain,
  rollbackPlugin,
  mergeDependencies,
  persistPluginUpdate,
  persistPluginSpec,
  deployType,
  readNpmMajor,
  buildNpmInstallArgs,
  dryRunGuard,
  deriveLauncher,
  scanInstalledPlugins,
  readBackupRoot,
  writeBackupRoot,
  backupDirs,
  migrateLegacyBackups,
  clearAllBackups,
};
