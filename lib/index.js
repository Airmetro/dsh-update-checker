// dsh-update-checker — Host half（v1.4.11，已合并 dsh-plugin-checker 的插件更新检测能力）。
// 路由：
//   GET  /dsh-update-checker/status.json       — 主程序检查结果（npm 最新稳定版 vs 本地已装版，
//                                                含 suppressUpToDate 标记与 brief 变更说明）
//   POST /dsh-update-checker/suppress          — 持久化"不再提示已是最新版本"标记
//   POST /dsh-update-checker/update            — 完整更新主程序：dry-run 守卫（计划内不得出现 remove）
//                                                → 备份 → 布局自适应 npm install（本地项目 / 全局 -g）
//                                                → 安装后回读校验 installed==latest → 同步 @deepseek-ai 生态
//   POST /dsh-update-checker/rollback          — 回滚主程序：按最新备份里记录的旧版本重装 + 生态同步
//   GET  /dsh-update-checker/backups.json      — 列出主程序与插件的历史备份（回滚入口数据）
//   POST /dsh-update-checker/restart           — 重启 dsh web 服务（两级 spawn 脱钩 + 看门狗：
//                                                按当前进程 argv 派生启动器，不再猜文件名；
//                                                杀 PID + 端口双保险；HTTP 恢复确认写结果 JSON）
//   GET  /dsh-update-checker/restart-status.json — 最近一次重启看门狗的结果（恢复确认）
//   GET  /dsh-update-checker/plugins.json      — 扫描第三方插件（多位置：profiles/node_modules +
//                                                profiles/*/node_modules 支持 pnpm hoisted 布局）
//                                                + npm/GitHub 双源 semver 对比；不可更新的本地工具
//                                                归入 ignored（不再刷"not on npm registry"噪音）
//   POST /dsh-update-checker/plugin-update     — 更新指定插件（临时目录安装 + 拷贝；依赖版本核对：
//                                                新 package.json 的 dependencies 范围不满足时替换并备份；
//                                                npm≥12 自动补 --allow-scripts 构建原生依赖；
//                                                v1.4.6 起更新/回滚后回写 profile 的 package.json
//                                                依赖声明并同步 pnpm/npm 锁文件，杜绝"同一插件
//                                                反复提醒更新"的死循环）
//   POST /dsh-update-checker/plugin-rollback   — 从 .dsh-plugin-backups/<id> 恢复插件
//   POST /dsh-update-checker/plugin-suppress   — 持久化"不再提示插件更新"标记
//   GET  /dsh-update-checker/settings.json     — 设置数据
//   POST /dsh-update-checker/settings          — 更新设置
// 写操作路由均要求 body { confirm: true } + 同源/回环来源（防局域网非浏览器客户端远程触发）。
//
// 纯 ESM、无构建步骤；仅依赖 Node 内置模块。
// 布局无关（不假设 junction）：profile 的 @deepseek-ai/* 本机是 junction（省 C 盘），
// 其它机器可能是真实拷贝。插件判定用"组合行 + dsh 字段"双源；更新用临时目录安装 + 拷贝，
// 绝不直接对 profiles 执行 npm（R26：会清空 node_modules）。
//
// GitHub 通道说明（R31）：本机 hosts 把 github 域名劫持到本地 S302 代理，代理证书与真实
// GitHub 不符，默认 TLS 校验必失败（UNABLE_TO_VERIFY_LEAF_SIGNATURE）。因此对 GitHub 域
// （github.com / *.githubusercontent.com 等）的请求使用 rejectUnauthorized:false 的专用
// HTTPS 客户端（仅限 GitHub 域；npm registry 仍走严格校验），并带下载大小上限与重定向跟随。

import { readFile, writeFile, mkdir, copyFile, cp, readdir, realpath, lstat, rm, mkdtemp, rename, appendFile } from "node:fs/promises";
import { resolve, join, basename, dirname, sep, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, tmpdir } from "node:os";
import { gunzipSync } from "node:zlib";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { exec, spawn } from "node:child_process";
import { promisify } from "node:util";
import https from "node:https";

const execP = promisify(exec);

const REGISTRY = "https://registry.npmjs.org";
const PACKAGE = "@deepseek-ai/dsh";
const SELF = "dsh-update-checker";
const CHECK_TTL_MS = 5 * 60 * 1000;
const MAX_BODY_BYTES = 1024 * 1024;          // 写路由 body 上限（超限 413，不静默截断）
const MAX_GH_JSON_BYTES = 4 * 1024 * 1024;   // GitHub API JSON 响应上限
const MAX_TARBALL_BYTES = 200 * 1024 * 1024; // codeload tarball 大小上限（防撑爆内存）
// 仅对 GitHub 域放行自签名/本地代理证书；其余域名一律严格校验。
const GH_INSECURE_HOST_RE = /(^|\.)(github\.com|githubusercontent\.com|githubassets\.com)$/i;
// GitHub API 可选认证 token：匿名限额 60/h → 认证 5000/h。来源 GH_TOKEN / GITHUB_TOKEN
// 环境变量（每台机器的部署者各自设置，插件不内置任何 token）；为空则保持匿名。
// 仅对 api.github.com 生效；codeload 下载保持匿名（不受 API 限额管）。
const GH_TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";

// ── 路径自检测（布局无关：不硬编码任何机器路径）──────────────────────────
// 锚点：本插件自身安装位置 —— 它一定位于 $DSH_HOME/profiles/node_modules/<pkg>/lib/ 下，
// 从自身向上反推出 profiles/node_modules → profiles → DSH_HOME，任何机器都成立。
const SELF_LIB_DIR = dirname(fileURLToPath(import.meta.url));

// 从给定目录向上找第一个名为 node_modules 的目录（即插件实际所在的 profiles/node_modules）。
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

// profile 侧 node_modules（插件实际安装位置）；由自身位置推导，无硬编码。
// 测试/可移植性钩子：可用环境变量 DSH_UC_PROFILE_NODE_MODULES 显式指定锚点（集成测试用），
// 否则回退到「向上找 node_modules → ~/.dsh/profiles/node_modules」。
const PROFILE_NODE_MODULES =
  process.env.DSH_UC_PROFILE_NODE_MODULES ||
  findNodeModulesDir(SELF_LIB_DIR) ||
  join(homedir(), ".dsh", "profiles", "node_modules");
const PROFILES_ROOT = dirname(PROFILE_NODE_MODULES);
// DSH 用户数据目录（状态/备份/日志都放这里，跟随实际 DSH_HOME 而非写死 ~/.dsh）
const DSH_HOME = dirname(PROFILES_ROOT);

// "不再提示已是最新版本"标记的持久化位置（DSH 用户数据目录）
const STATE_FILE = join(DSH_HOME, "dsh-update-checker-state.json");
// 主程序更新前备份目录（lockfile + 版本清单 + backup-meta.json）。默认值可被用户配置
// （state.backupRoot）覆盖；插件备份统一存到 <backupRoot>/plugins。
const BACKUP_DIR_DEFAULT = join(DSH_HOME, "dsh-update-checker-backups");
// 旧版插件备份位置（v1.4.1 之前）：首次使用时自动迁移到 <backupRoot>/plugins
const LEGACY_PLUGIN_BACKUP_ROOT = join(PROFILE_NODE_MODULES, ".dsh-plugin-backups");
// 重启看门狗日志 + 结果（结果 JSON 供 /restart-status.json 读取）
const RESTART_LOG = join(DSH_HOME, "dsh-update-checker-restart.log");
const RESTART_RESULT = join(DSH_HOME, "dsh-update-checker-restart-result.json");
// 操作日志：每次更新/回滚/重启的关键节点与 npm 输出摘要都落盘（回应"插件日志看不到"的问题）
const OPS_LOG = join(DSH_HOME, "dsh-update-checker-ops.log");
// 主程序更新进度状态文件（客户端轮询显示进度条；/update 同步执行期间实时写入）
const UPDATE_PROGRESS_FILE = join(DSH_HOME, "dsh-update-checker-update-progress.json");

// 组合文件（激活插件权威清单）：默认 profiles/web/cordis.patch.yml；
// 找不到时扫描 profiles 下所有 cordis.patch.yml，优先含本插件 id 的（布局无关）。
async function findCompositionFile() {
  const defaultFile = join(PROFILES_ROOT, "web", "cordis.patch.yml");
  try {
    await readFile(defaultFile, "utf8");
    return defaultFile;
  } catch {
    // 默认位置不可读，扫描其它 profile 层
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
        // 不可读，尝试下一个
      }
    }
  } catch {
    // profiles 不可读，回退默认
  }
  return defaultFile;
}

// 部署根候选（回退用）：默认取进程 cwd（各机器自己的 start 脚本通常会 cd 到部署目录）。
// 主要检测走 junction realpath 反推（见 findDeployRoot），此处仅兜底；
// 如需显式指定部署根，设置环境变量 DSH_DEPLOY_ROOT 或在此追加候选。
// v1.4.9：npm -g 全局安装形态（Linux systemd 托管 web 服务常见）的两条既有路径都会 miss ——
//   cwd 是用户家目录（其下无 node_modules/@deepseek-ai/dsh），profile 侧在 pnpm hoisted 布局下
//   是独立目录而非 junction。此时部署根是 npm 全局前缀，由 findDeployRoot 内异步探测
//   `npm root -g` 得到（见 probeNpmGlobalNodeModules），不放进此静态列表（避免模块加载时
//   同步执行子进程阻塞启动）。
const DEPLOY_ROOT_CANDIDATES = [process.cwd()];

// 主程序更新命令（布局自适应）：
//   local  — 部署根有 package.json（如 D:\应用\DeepSeek-Harness 这类只声明 @deepseek-ai/dsh
//            依赖的 wrapper 项目）：`npm install <pkg>@<ver>` 在部署根原位更新（-g 会装进全局
//            前缀、对部署目录毫无效果 —— 本机实测过的假成功根源）；
//   global — 部署根无 package.json（npm -g 全局安装形态，R30）：`npm install -g ...`。
// npm 11 默认执行依赖 install 脚本（实测）；npm ≥12 起依赖脚本默认被拦，需 --allow-scripts
// 白名单放行原生依赖（koffi/node-pty/sharp 等）——按 npm 大版本自适应，避免在 11 上刷未知参数警告。
// 用真实 node 定位 npm-cli.js，不依赖 PATH（本机 PATH 有损坏条目）。
// npm-cli.js 定位：兼容多种 node 前缀布局（候选按常见度排序，find 取第一个真实存在的）：
//   1) <bin>/node_modules/npm            —— Windows 常见（node 旁 node_modules 相邻）
//   2) <prefix>/lib/node_modules/npm     —— Linux 标准前缀（/usr/local/bin → /usr/local/lib/node_modules）
//   3) <prefix>/node_modules/npm         —— Linux 全局布局变体
// 全都不存在时回退候选 1（保留原路径，报错信息仍可读）。
// 关键（issue #8）：DSH Desktop（Electron）形态下 process.execPath 是 electron.exe——
// 直接拿它当 node 跑 npm-cli.js 只会启动 Chromium 网络栈（报 WSALookupServiceBegin…10108、
// "npm install produced no package"），npm 根本没运行。因此所有子进程调用必须先经
// resolveNodeExe() 拿到真实 node，再从它的目录推导 npm-cli.js（getNpmCli()），两条都带缓存。
let nodeExeCache = null;
let npmCliCache = null;

// 真实 node 候选列表（纯函数，可单测）：给定当前进程 execPath 与环境对象，
// 按优先级返回有序候选（不含探测/存在性判断，由 resolveNodeExe 逐一遍历）。
//   1) execPath 自身（若文件名确实像 node）
//   2) execPath 目录下的 node.exe / 上一级 node.exe（Electron 打包常把 node 放旁边）
//   3) NODE / npm_node_execpath 环境变量
//   4) 常见安装位置（Program Files / LOCALAPPDATA / C:\nodejs）
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

// 真实 node 可执行文件探测链（返回存在的路径；全失败回退 process.execPath 保持旧行为）：
//   1) 环境变量 DSH_UC_NODE_EXE（用户/部署者显式指定；Desktop 打包场景的逃生口）
//   2) buildNodeExeCandidates 的候选列表（先 existsSync 探测，再 PATH 扫描兜底）
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
      // 不可探测，继续下一个
    }
  }
  // PATH 兜底
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
        // 继续
      }
    }
  }
  nodeExeCache = process.execPath; // 全失败：保持旧行为（web 形态下本来就地）
  return nodeExeCache;
}

// npm-cli.js（从真实 node 目录推导，多布局，带缓存）
function getNpmCli() {
  if (npmCliCache) return npmCliCache;
  const exeDir = dirname(resolveNodeExe());
  npmCliCache =
    [
      join(exeDir, "node_modules", "npm", "bin", "npm-cli.js"),
      join(exeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
      join(exeDir, "..", "node_modules", "npm", "bin", "npm-cli.js"),
    ].find((p) => existsSync(p)) || join(exeDir, "node_modules", "npm", "bin", "npm-cli.js");
  return npmCliCache;
}

const ALLOW_SCRIPTS = "@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs";

let updateInFlight = false;
let restartScheduled = false;
let pluginUpdateInFlight = false;
// 锁开始时间：npm install 卡住时锁会被长期占用，超过超时阈值自动接管（防永久 409）
let updateStartedAt = 0;
let pluginUpdateStartedAt = 0;

// 状态文件读写：{ suppressUpToDate, suppressPluginBanner }（合并写，不互相覆盖）
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

// 设置项：悬浮窗总开关 / 提示开关 / 两个"不再提示"标记 / 默认下载源（缺失时按默认值处理）
async function readSettings() {
  const s = await readState();
  const ds = s.downloadSource;
  return {
    floatingEnabled: s.floatingEnabled !== false,
    notifyEnabled: s.notifyEnabled !== false,
    suppressUpToDate: s.suppressUpToDate === true,
    suppressPluginBanner: s.suppressPluginBanner === true,
    // v1.4.9：npm 与 GitHub 版本一致（平局）时的首选下载源；'github'(默认) | 'npm' | 'smart'
    downloadSource: ds === "npm" || ds === "smart" ? ds : "github",
  };
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

// ── 版本工具 ───────────────────────────────────────────────────────────
function parseVersion(v) {
  const m = String(v || "").trim().match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!m) return null;
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split(".") : [] };
}

function isPrerelease(v) {
  const p = parseVersion(v);
  return !!p && p.pre.length > 0;
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

// 判断已安装版本是否满足 package.json 的依赖范围（npm 常用子集：^ ~ >= > <= < = 精确、
// x/通配、连字符区间、|| 或、空格与、预发布规则）。纯函数，可单测。
// 预发布规则：预发布版本只有在其 [M.m.p] 与范围中显式出现的预发布版本一致时才匹配
// （与 npm semver 一致：^0.1.0-rc.1 能匹配 0.1.0-rc.2，也能匹配 0.1.0——范围下限含预发布时
// 稳定版仍在区间内；而 ^1.0.0 不能匹配 1.0.0-beta.1）。
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
  // 连字符区间：1.2.3 - 2.3.4 / 1.2.3 - 2 / 1.2 - 2.3（上界部分版本按 npm 展开为下一边界）
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
  // npm 预发布规则：组内任一比较符含与 v 相同 [M.m.p] 的预发布 → 整组按数值比较（否则预发布一律不匹配）
  const allowPre = parts.some((p) => {
    const ps = parseVersion(String(p).replace(/^[<>=^~]+/, ""));
    return !!ps && ps.pre.length > 0 && ps.core[0] === v.core[0] && ps.core[1] === v.core[1] && ps.core[2] === v.core[2];
  });
  return parts.every((p) => satisfiesSingle(v, ver, p, allowPre));
}

// "1.2" → "1.2.x"；"1" → "1.x"；完整版本原样返回
function expandPartial(spec) {
  const m = String(spec || "").trim().match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/);
  if (!m) return spec;
  if (m[3] !== undefined) return spec;
  return m[2] === undefined ? `${m[1]}.x` : `${m[1]}.${m[2]}.x`;
}

// 预发布版本只有范围里含相同 [M.m.p] 的预发布说明符时才参与匹配
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
  // 无比较符的纯部分版本/通配（1.2.x / 1.x / 1.2）→ 部分匹配
  if (!/^[<>=^~]/.test(comp)) {
    if (/[xX*]/.test(comp)) return matchesPartial(v, comp, allowPre);
    const mm = comp.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/);
    if (mm) return matchesPartial(v, comp, allowPre);
  }
  // 部分版本比较符补全：>=1.2 → >=1.2.0；>1.2 → >=1.3.0；>1 → >=2.0.0（npm 语义，含边界）
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
      // ~1.2.3 → >=1.2.3 <1.3.0；~1.2 → >=1.2.0 <1.3.0；~1 → >=1.0.0 <2.0.0
      const [mj, mn] = target.core;
      if (!specHadMinor) return c >= 0 && v.core[0] === mj;
      return c >= 0 && v.core[0] === mj && v.core[1] === mn;
    }
    case "^": {
      // ^1.2.3 → >=1.2.3 <2.0.0；^0.2.3 → >=0.2.3 <0.3.0；^0.0.3 → =0.0.3
      const [mj, mn, pt] = target.core;
      if (mj > 0) return c >= 0 && v.core[0] === mj;
      if (mn > 0) return c >= 0 && v.core[0] === 0 && v.core[1] === mn;
      return c >= 0 && v.core[0] === 0 && v.core[1] === 0 && v.core[2] === pt;
    }
    default:
      return false;
  }
}

// 从 npm packument 挑选目标版本：优先最高稳定版；全部为预发布时才用 dist-tags.latest（或最高版）。
// 解决 monorepo 子包 latest tag 过期/指向 prerelease 导致的误报。
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

// v1.4.10：主程序版本选择——主程序（@deepseek-ai/dsh）暂时没有稳定版（全是 rc），
// 更新逻辑不再做稳定版优先过滤，直接取已发布版本中的最高者（含预发布）。
// 与 pickNpmLatest 的区别：pickNpmLatest 有稳定版时优先稳定版（可能因此忽略 next 通道的
// 更高 rc）；主程序若也这样，rc8 发布在 next 通道时会被 latest=rc7 挡住。
function pickMainLatest(doc) {
  const versions = Object.keys((doc && doc.versions) || {});
  if (!versions.length) return null;
  return versions.slice().sort((a, b) => compareVersions(b, a))[0];
}

// v1.4.10：主程序 GitHub release tag → semver。主程序仓库（deepseek-harness，monorepo）
// 的 release tag 带前缀，形如 `dsh-v0.1.0-rc.8`；兼容裸 `v1.2.3` / `1.2.3`。
function mainTagToVersion(tag) {
  const s = String(tag || "").trim().replace(/^dsh-?/i, "").replace(/^v/i, "");
  return /^\d+\.\d+\.\d+/.test(s) ? s : null;
}

// 版本跳跃风险分级（用于 brief 变更说明）
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

// 状态灯判定（v1.4.5 新增，纯函数供单测）：
//   "update"   — 有更新（黄灯）
//   "latest"   — 已是最新（绿灯）
//   "rollback" — 作者回退版本：本机已装版本比发布源都高（红灯）
//   "error"    — 无法查询到：无发布源可用 / 作者已删除库（红灯）
// 优先级：error > rollback > update > latest。installed 缺失时不误报，归为 latest。
function deriveStatus(installed, target, hasSource) {
  if (!hasSource || !target) return "error";
  if (!installed) return "latest";
  const c = compareVersions(installed, target);
  if (c > 0) return "rollback";
  if (c < 0) return "update";
  return "latest";
}

// tag → semver 版本号（去 v 前缀；非 semver 返回 null）
function tagToVersion(tag) {
  const s = String(tag || "").trim().replace(/^v/i, "");
  return /^\d+\.\d+\.\d+/.test(s) ? s : null;
}

// npm 全局根探测（v1.4.9，issue #7）：npm -g 全局安装形态下部署根是全局前缀——
// `npm root -g` 输出全局 node_modules 目录（Linux: <prefix>/lib/node_modules；
// Windows: %APPDATA%\npm\node_modules），其父目录即前缀，resolve(root, "node_modules/...")
// 才能命中。缓存一次；失败返回 null（静默，不影响其它候选）。
// 测试钩子 DSH_UC_NPM_GLOBAL_ROOT：直接注入 npm root -g 的输出（全局 node_modules 路径），
// 集成测试可模拟 npm -g 布局而无需真实子进程。
let npmGlobalRootCache = null;
let npmGlobalRootProbeAt = 0;
async function probeNpmGlobalRoot() {
  const now = Date.now();
  if (now - npmGlobalRootProbeAt < 60000) return npmGlobalRootCache; // 60s 内复用结果（含失败，避免每次检查都 spawn npm）
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

// 找到部署根目录。策略（布局无关，不硬编码机器路径）：
//   1) junction 反推：profile 侧 @deepseek-ai/dsh 通常是指向部署目录 node_modules 的 junction，
//      realpath 后上溯三级即部署根（junction 场景自动命中，无需任何配置）；
//   2) 候选回退：环境变量 DSH_DEPLOY_ROOT → 进程 cwd → DEPLOY_ROOT_CANDIDATES 其余项 →
//      npm 全局前缀（npm -g 全局安装形态，Linux systemd 托管 web 常见，issue #7）。
// 都失败返回 null。
async function findDeployRoot() {
  try {
    const link = join(PROFILE_NODE_MODULES, "@deepseek-ai", "dsh");
    const st = await lstat(link);
    if (st.isSymbolicLink()) {
      const rp = await realpath(link); // …/部署根/node_modules/@deepseek-ai/dsh
      const candidate = resolve(rp, "..", "..", "..");
      await readFile(resolve(candidate, `node_modules/${PACKAGE}/package.json`), "utf8");
      return candidate;
    }
  } catch {
    // 非 junction 或不可读，走候选回退
  }
  const extra = process.env.DSH_DEPLOY_ROOT ? [process.env.DSH_DEPLOY_ROOT] : [];
  const npmGlobalRoot = await probeNpmGlobalRoot();
  for (const root of [...extra, ...DEPLOY_ROOT_CANDIDATES, ...(npmGlobalRoot ? [npmGlobalRoot] : [])]) {
    try {
      await readFile(resolve(root, `node_modules/${PACKAGE}/package.json`), "utf8");
      return root;
    } catch {
      // 该候选不可读，尝试下一个
    }
  }
  return null;
}

// 部署形态判定：local（部署根有 package.json 且声明了依赖/名字）→ 原位 npm install；
// global（无 package.json，npm -g 全局安装）→ npm install -g。
function deployType(root) {
  try {
    const pj = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
    if (pj && (pj.name || pj.dependencies || pj.devDependencies || pj.optionalDependencies)) return "local";
  } catch {
    // 无 package.json → global
  }
  return "global";
}

// 读取当前 node 附带的 npm 大版本（决定 --allow-scripts 行为）；失败返回 null。
function readNpmMajor() {
  try {
    const pj = JSON.parse(readFileSync(join(dirname(dirname(getNpmCli())), "package.json"), "utf8"));
    const n = Number(String(pj.version || "").split(".")[0]);
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

// 主程序更新参数（布局自适应）。spec 形如 "@deepseek-ai/dsh@latest" 或 "@deepseek-ai/dsh@0.1.0-rc.5"。
function buildNpmInstallArgs(root, spec) {
  const type = deployType(root);
  const args = ["install"];
  if (type === "global") args.push("-g");
  args.push(spec, "--no-audit", "--no-fund");
  const npmMajor = readNpmMajor();
  if (npmMajor !== null && npmMajor >= 12) args.push(`--allow-scripts=${ALLOW_SCRIPTS}`);
  return { args, type, npmMajor };
}

// 执行 npm（真实 node 全路径 + npm-cli.js 全路径，不依赖 PATH；issue #8：Electron 下 execPath 不是 node）
async function runNpm(args, opts = {}) {
  const cmd = `"${resolveNodeExe()}" "${getNpmCli()}" ${args.map((a) => `"${a}"`).join(" ")}`;
  return execP(cmd, {
    cwd: opts.cwd,
    timeout: opts.timeout || 600000,
    maxBuffer: opts.maxBuffer || 8 * 1024 * 1024,
    windowsHide: true,
  });
}

// 更新前安全闸 1：npm install --dry-run，计划里出现 remove 即中止（防止把部署树/全局树 prune 掉）。
// v1.4.10：dry-run 超时降级——npm 10 对超大依赖树（@deepseek-ai/dsh 及其 62+ 直接依赖、原生包）
// 的 dry-run 可能长时间不返回（本机实测 240s+ 卡死，导致进度条停在 dry-run、更新永久挂起）。
// 超时后不再死等：记录警告并降级放行（跳过 dry-run），由后续「安装后回读 installed==latest」
// 与 dry-run 对 local 形态的 prune 风险由 deployType 已判 + 备份兜底。
// 返回 { ok, skipped, text }；skipped=true 表示超时降级。
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

// 执行 npm 并限时等待；超时杀掉子进程返回 null（不抛错），正常返回 stdout+stderr。
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
      try { child.kill(); } catch { /* 已退出 */ }
    }, timeoutMs);
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === null) return resolve(null); // 被超时杀掉
      resolve(out + errOut);
    });
  });
}

// 破解 npm 11 的 reify 快速路径（1.4.1 修复）：
// npm install 会先把 spec 与隐藏 lockfile（node_modules/.package-lock.json）推进到目标版本，
// 然后 reify 因"隐藏 lockfile 已声明目标"而跳过实际目录替换 → 目录永远是旧版本、回读校验必失败。
// 解决：把目标包目录改名（备份）后重装，npm 检测到目录缺失即真正 reify。
// 返回 { ok, installed, output, backupDir }；失败时还原旧目录。
export async function forceReifyMain(root, latestVersion, onProgress) {
  const pkgDir = join(root, "node_modules", ...PACKAGE.split("/"));
  const bak = `${pkgDir}.bak-pre-reify-${Date.now()}`;
  let renamed = false;
  try {
    await rename(pkgDir, bak);
    renamed = true;
  } catch {
    // 目录不存在或不可改名：直接尝试重装
  }
  try {
    const spec = `${PACKAGE}@${latestVersion}`;
    const args = buildNpmInstallArgs(root, spec).args;
    args.push("--loglevel=http");
    const { stdout, stderr } = await runNpmProgress(args, { cwd: root, timeout: 600000 }, onProgress);
    const installed = await readInstalledVersion();
    const ok = installed && compareVersions(installed, latestVersion) === 0;
    if (renamed && ok) {
      // 重装成功：清理改名备份（更新前的完整旧状态已由 backupForUpdate 记录）
      await rm(bak, { recursive: true, force: true }).catch(() => {});
    }
    return {
      ok: !!ok,
      installed,
      output: truncate((stdout || "") + (stderr || ""), 2000),
      backupDir: renamed && !ok ? bak : null,
    };
  } catch (err) {
    // 重装失败：还原旧目录，保持现场
    if (renamed) {
      await rm(pkgDir, { recursive: true, force: true }).catch(() => {});
      await rename(bak, pkgDir).catch(() => {});
    }
    throw err;
  }
}

// 在部署根下查找"启动 dsh 服务"的脚本（重启看门狗回退用；首选派生自当前进程 argv）。
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
      // 不存在，尝试下一个
    }
  }
  return join(root, "start-dsh.cmd"); // 全失败时回退默认名（让看门狗暴露真实错误）
}

// 从当前进程 argv 派生重启命令（比猜启动脚本文件名可靠：非标准启动方式也能复现）。
// 返回 { file: node 全路径, args: [bin.js, ...], cwd }；不可用时返回 null。
function deriveLauncher() {
  const args = process.argv.slice(1);
  if (!args.length || !process.execPath) return null;
  return { file: process.execPath, args, cwd: process.cwd() };
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

// 更新前备份：部署 lockfile + 两套 @deepseek-ai 版本清单 + backup-meta.json（回滚元数据）。
// 返回备份目录。
async function backupForUpdate(deployRoot) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = join((await backupDirs()).main, stamp);
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
  const installed = await readInstalledVersion();
  await writeFile(
    join(dir, "backup-meta.json"),
    JSON.stringify(
      { installed, type: deployType(deployRoot), createdAt: new Date().toISOString() },
      null,
      2
    ),
    "utf8"
  );
  return dir;
}

// ── v1.4.10 main-update 安全状态机（D1/D2/D3/D4/D5/D7）────────────────
// 修复事故根因（BUG-EVIDENCE-20260820）：
//   D2 致命：旧流程在服务运行中直接 npm install → Windows 文件占用导致安装不完整 + 服务死亡。
//           新流程：**先停服务**（taskkill + 端口释放等待）→ install → 校验 → 声明同步 → 重启 → 健康检查。
//   D1 致命：install 无超时（runNpmProgress 的 timeout 从未生效）→ 现在带超时 + 失败回滚。
//   D3 严重：verify 形同虚设 → 现在 verifyDeployTree 校验版本一致/dist 完整/client 入口。
//   D4 严重：restart "done" ≠ 服务活着 → 现在重启后 HTTP 200 + 资源 Content-Type 非 text/html。
//   D5 严重：package.json 声明 ^rc.7 未同步 → 现在安装后改写为精确版本（去 ^）。
//   D7 中等：dry-run 超时跳过保护裸奔 → 现在 dry-run 超时即中止本次更新（不再继续）。
// 本函数在**独立子进程**中执行（见 updateMainInBackground），与 DSH 主进程脱钩，
// 因此可以安全地杀掉 3080 服务进程再 install（杀父进程不会连带终止本进程）。
// 返回 { ok, ... }；任何失败都会尝试从备份回滚并重启服务。
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
      // dry 预览：不停服务、不安装，仅返回计划（供客户端"预览"按钮）
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
        // D7：dry-run 超时视为解析不可行 → dry 预览直接报错
        dryRunOut = { error: String(e && e.message ? e.message : e), code: e && e.code };
      }
      await clearProgress();
      return { ok: true, dry: true, plan, dryRun: dryRunOut };
    }

    // ── 阶段 1：停止服务（D2：install 前必须无运行进程占用文件）──
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

    // ── 阶段 2：安装（D1：带超时；npm 10 大依赖树解析慢，默认 10 分钟）──
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
      // D1：install 失败/超时 → 回滚备份 → 重启服务
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

    // ── 阶段 3：安装后回读（npm 快速路径可能跳过 reify → forceReifyMain）──
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

    // ── 阶段 4：完整性校验（D3）──
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

    // ── 阶段 5：声明同步（D5：package.json 改为精确版本，防降级炸弹）──
    await step("sync-decl", "同步 package.json 声明…", 90);
    await syncDeployDeclaration(deployRoot, targetVersion);

    // ── 阶段 6：重启 + 健康检查（D4）──
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
    // 尽力恢复服务（即便失败流程，也要尝试让服务回到可用状态）
    try {
      const rs = await startDshService(deployRoot);
      await opsLog({ op: "main-update-crash-recovery", startOk: rs.ok, error: rs.error || null });
    } catch {
      /* 恢复失败也上报主错误 */
    }
    return await fail(msg, code || "E_UNKNOWN");
  }
}

// 停止 3080 服务：taskkill 监听进程 + 等待端口释放（复用 restart-service.ps1 的等待逻辑，
// 但用绝对路径调用，不依赖 PATH —— 旁证 9 的 PATH 损坏坑）。
async function stopDshService(deployRoot) {
  const port = 3080;
  const taskkill = "C:\\Windows\\System32\\taskkill.exe";
  const kills = [];
  // 通过 powershell Get-NetTCPConnection 拿 PID（全路径，绕 PATH 损坏）。
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
    /* 探测失败，跳过杀进程 */
  }
  for (const pid of pids) {
    if (pid === process.pid) continue; // 绝不杀自己（独立子进程模式下 pid 不同）
    kills.push(pid);
    try {
      spawn(taskkill, ["/PID", String(pid), "/F"], { windowsHide: true, stdio: "ignore" });
    } catch {
      /* 单个失败继续 */
    }
  }
  // 等待端口释放（最长 20s）
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

// 启动 dsh 服务（绝对路径 cmd 启动 start-dsh.cmd；等端口监听）。
async function startDshService(deployRoot) {
  const port = 3080;
  const cmdExe = "C:\\Windows\\System32\\cmd.exe";
  const launcher = join(deployRoot, "start-dsh.cmd");
  try {
    spawn(cmdExe, ["/c", launcher], {
      cwd: deployRoot,
      windowsHide: true,
      detached: true,
      stdio: "ignore",
    }).unref();
  } catch (err) {
    return { ok: false, error: `launcher spawn failed: ${err.message}` };
  }
  // 等待端口监听（最长 30s）
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
  const deadline = Date.now() + 30000;
  let pid = null;
  while (Date.now() < deadline) {
    try {
      const nums = await probe();
      if (nums.length) { pid = nums[0]; break; }
    } catch { /* 重试 */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return { ok: !!pid, pid, error: pid ? null : "service did not listen within 30s" };
}

// 健康检查：3080 HTTP 200 + 首页引用的 /assets/ 与 /plugins/ 资源 Content-Type 非 text/html。
async function healthCheckDsh() {
  const port = 3080;
  const base = `http://127.0.0.1:${port}`;
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
  // 1) 首页 200
  const home = await fetchOnce(base + "/");
  if (!home || home.status !== 200) {
    problems.push(`GET / -> ${home ? home.status : "no response"}`);
    return { ok: false, problems, error: problems.join("; ") };
  }
  // 2) 首页引用的资源 Content-Type 校验（SPA fallback 会对缺失路径返回 200+text/html）
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

// 从备份回滚主程序（install 失败/校验失败后调用）：重装备份记录的旧版本 + 重启。
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

// 把部署根 package.json 里 @deepseek-ai/dsh 的依赖声明改为精确版本（去 ^ 范围符），防降级炸弹。
async function syncDeployDeclaration(deployRoot, version) {
  const pjPath = join(deployRoot, "package.json");
  try {
    const pj = JSON.parse(await readFile(pjPath, "utf8"));
    const scope = pj.dependencies || {};
    if (typeof scope[PACKAGE] === "string") {
      scope[PACKAGE] = version; // 精确版本（去 ^）
      pj.dependencies = scope;
      await writeFile(pjPath, JSON.stringify(pj, null, 2), "utf8");
      await opsLog({ op: "main-decl-synced", version });
    }
  } catch {
    // 无 package.json（npm -g 形态）→ 无需同步声明
  }
}

// 纯函数：由两份 @deepseek-ai 版本清单计算同步计划（不碰磁盘，可单测）。
// 部署侧有、而 profile 侧缺失或版本不同的包 → 从部署侧拷贝；
// 绝不把 profile 独有的包（如 dshcost / dsh-update-checker）列入计划。
function planSyncFromMaps(deploy, profile) {
  const todo = [];
  for (const [name, ver] of Object.entries(deploy)) {
    if (profile[name] !== ver) {
      todo.push({ name, from: profile[name] || null, to: ver });
    }
  }
  return todo;
}

// 计算同步计划：读取部署侧与 profile 侧两份版本清单，交给纯函数 planSyncFromMaps 计算。
async function planSync(deployRoot) {
  const deploy = await readEcoVersions(join(deployRoot, "node_modules"));
  const profile = await readEcoVersions(PROFILE_NODE_MODULES);
  return { deploy, profile, todo: planSyncFromMaps(deploy, profile) };
}

// 执行同步：把计划内的包从部署侧拷贝到 profile 侧。返回逐包结果。
// junction 情况下 src 与 dst 是同一物理文件（realpath 相同）——跳过，避免自拷贝。
// dst 不存在（新增包）时直接拷贝，不做 realpath 比较（否则会 ENOENT 误报失败）。
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

// ── npm 版本查询（packument 全量 → 稳定版优先，5 分钟 TTL）────────────────
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

// 插件/通用包：corgi 元数据（轻量），返回最新稳定版字符串
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

// 主程序：全量元数据（含 time 发布时间的变更说明用），返回 { version, publishedAt }
// v1.4.10：主程序没有稳定版（全 rc），不再 stable-first——直接取已发布最高版本
// （含预发布，覆盖 next 通道先于 latest 发布的 rc 版本），用 pickMainLatest。
async function fetchMainPackument(force) {
  const now = Date.now();
  if (!force && mainPackumentCache && now - mainPackumentCache.at < CHECK_TTL_MS) {
    return mainPackumentCache.value;
  }
  const doc = await fetchPackument(PACKAGE, true);
  const version = pickMainLatest(doc);
  if (!version) throw new Error("npm registry: no version");
  const value = {
    version,
    publishedAt: (doc.time && doc.time[version]) || null,
    ghRepo: parseGhRepo((doc.versions && doc.versions[version] && doc.versions[version].repository) || null) || null,
  };
  mainPackumentCache = { value, at: now };
  return value;
}

// ── GitHub 源辅助（R31：专用 TLS 客户端，仅 GitHub 域 rejectUnauthorized:false）────
// 从 package.json repository 解析 owner/repo
function parseGhRepo(r) {
  if (!r) return null;
  const url = (typeof r === "string" ? r : r.url) || "";
  const m =
    url.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?(?:\/|$)/) ||
    (typeof r === "string" ? r.match(/^([^/]+)\/([^/]+?)(?:\.git)?$/) : null);
  return m ? m[1] + "/" + m[2] : null;
}

// 通用 GitHub HTTPS 请求：rejectUnauthorized 按域名决定（GitHub 域放行本地 S302 代理证书），
// 自动跟随重定向（≤5 跳，每跳重新判定域名），流式累计并强制大小上限。
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
            // 仅 api.github.com 带认证（token 来自运行者本机环境变量，限额 60/h → 5000/h）；
            // host 每跳重定向都会重新判定，token 不会被带到其它域；codeload 下载保持匿名。
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
// Issue #3：release tag → 仓库根 package.json 的 name 缓存（校验 monorepo 子包误报用）
let ghPkgNameCache = new Map();

// 查询 GitHub 最新 release（带 5 分钟 TTL，force 绕过）。
// 成功 → { tag, version }；无 release（404）→ { none: true }；网络/HTTP 失败抛错（code GITHUB）。
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

// 拉取指定 tag 的 release 正文（前 600 字符）作为变更说明；失败返回 null。
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

// v1.4.10：主程序 GitHub 源查询（列表方式）。插件侧 fetchGitHubLatest 用
// `/releases/latest`，但该端点只返回"最新非 prerelease 非 draft"的 release——
// 主程序仓库（deepseek-harness）的 release 全部是 prerelease（rc），会得到 404。
// 因此主程序改用 `/releases?per_page=30` 拉列表，取其中最高 semver 版本
// （tag 形如 `dsh-v0.1.0-rc.8`，由 mainTagToVersion 解析）。
// 成功 → { tag, version }；无任何可解析 release → { none: true }；失败抛错（code GITHUB）。
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

// Issue #3：读取 release tag 对应仓库根 package.json 的 name（raw 内容，1KB 级）。
// 用于判定该 tag 是否属于本插件：monorepo 主仓库的 tag 根包名 ≠ DSH 子包名，不采信。
// 成功返回 name 字符串；请求失败 / 无 package.json / 无法解析 → null（调用方保持采信，
// 避免误伤 GitHub-only 插件 —— npm 上没有、只能 GitHub 安装的场景）。
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
    if (r.status !== 200) {
      ghPkgNameCache.set(key, { value: null, at: now });
      return null;
    }
    let pkg = null;
    try {
      pkg = JSON.parse(r.buf.toString("utf8"));
    } catch {
      // 非 JSON（仓库根无 package.json）→ null
    }
    const name = pkg && typeof pkg.name === "string" && pkg.name ? pkg.name : null;
    ghPkgNameCache.set(key, { value: name, at: now });
    return name;
  } catch {
    // 限流 / 超时 / 网络错误 → 保守不采信（null），由调用方降级仅 npm
    ghPkgNameCache.set(key, { value: null, at: now });
    return null;
  }
}

// Issue #3：判定 release tag 是否属于本地插件。纯函数（供单元测试）：
// - ghName === null（限流/网络失败/根无 package.json）→ true（保持采信，保护 GitHub-only 插件）
// - ghName === pluginName → true（独立仓库，tag 属于本插件）
// - 其它 → false（monorepo 主仓库 tag 与子包无关，不采信）
function ghTagBelongsTo(ghName, pluginName) {
  if (ghName === null || ghName === undefined) return true;
  return ghName === pluginName;
}

// v1.4.10：主程序目标版本解析（检查与更新共用）——npm + GitHub 双源，非平局取较高者，
// 平局按默认下载源设置。返回 { version, npmVersion, ghVersion, source, ghTag, publishedAt, ghRepo }；
// GitHub 源不可用时不阻断（仅 npm）。供 runCheck 与 /update 路由共用，保证"显示什么就装什么"。
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
    const prefSource = (await readSettings()).downloadSource;
    const { target, src } = pickTargetSource(npmInfo.version, ghInfo.version, prefSource);
    version = target;
    source = src;
    ghTag = ghInfo.tag;
    if (src === "github") publishedAt = ghInfo.publishedAt || publishedAt;
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

// ── 主程序检查 ─────────────────────────────────────────────────────────
// v1.4.10：主程序与插件一致走 npm + GitHub 双源比对——npm 侧取已发布最高版本
// （含预发布，不再 stable-first），GitHub 侧取仓库 releases 列表最高版本；
// 非平局按版本较高者，平局按默认下载源设置（github/npm/smart）。
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
  // v1.4.5：状态灯（黄=有更新 / 绿=最新 / 红=库被删或无法查询或本机版本高于发布源）
  report.status = deriveStatus(report.installed, report.latest, !!report.latest);
  report.suppressUpToDate = await readSuppressUpToDate();
  const settings = await readSettings();
  report.floatingEnabled = settings.floatingEnabled;
  report.notifyEnabled = settings.notifyEnabled;
  return report;
}

// ── 插件扫描（多位置：profiles/node_modules + profiles/*/node_modules，pnpm hoisted 兼容）──
async function readCompositionPluginNames() {
  const names = new Set();
  try {
    const raw = await readFile(await findCompositionFile(), "utf8");
    const re = /^\s*name:\s*['"]([^'"]+)['"]\s*$/gm;
    let m;
    while ((m = re.exec(raw))) names.add(m[1].trim());
  } catch {
    // 组合文件缺失/不可读：退化为仅 dsh 字段判定
  }
  return names;
}

// 判定目录是否为"社区插件"：组合行命中（目录名）或有 dsh 字段，且非官方。
// 不排除自己（SELF）——允许插件自我更新（临时目录安装 + 拷贝，安全）。
async function classifyPlugin(dir, dirName, composition) {
  if (!dirName) return null;
  if (dirName.startsWith("@deepseek-ai/")) return null; // 排除官方
  let pkg = null;
  try {
    pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
  } catch {
    // package.json 不可读：仅当组合行命中时收录（无版本信息）
    if (composition.has(dirName)) return { name: dirName, installed: null, dir, hasDsh: false };
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
    ghRepo: parseGhRepo(pkg && pkg.repository),
    hasDsh,
  };
}

// 所有可能的插件安装位置（顶层 + 每个 profile 子层），按 realpath 去重
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
    // profiles 不可读
  }
  const seen = new Set();
  const out = [];
  for (const r of roots) {
    let key = r;
    try {
      key = await realpath(r);
    } catch {
      // 保持原始路径
    }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

async function pushUnique(found, seenReal, seenNames, pkg, dir) {
  if (!pkg) return;
  let key = dir;
  try {
    key = await realpath(dir);
  } catch {
    // 保持原始路径
  }
  if (seenReal.has(key)) return;
  // 同名去重：同一插件出现在多个位置（顶层 + pnpm hoisted 子层等）时只保留第一处
  if (pkg.name && seenNames.has(pkg.name)) return;
  seenReal.add(key);
  if (pkg.name) seenNames.add(pkg.name);
  found.push(pkg);
}

async function scanInstalledPlugins() {
  const found = [];
  const seenReal = new Set(); // 按实际目录（realpath）去重
  const seenNames = new Set(); // 按包名去重（多位置同插件的物理副本）
  const composition = await readCompositionPluginNames();
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
        if (e.name === "@deepseek-ai") continue; // 官方内置
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
          await pushUnique(found, seenReal, seenNames, pkg, dir);
        }
      } else {
        const dir = join(root, e.name);
        const pkg = await classifyPlugin(dir, e.name, composition);
        await pushUnique(found, seenReal, seenNames, pkg, dir);
      }
    }
  }
  return found;
}

// v1.4.9：两源交叉决定目标版本与下载源（纯函数，可单测）。
// 非平局按版本较高者；平局（npmV === ghV）按首选下载源 pref：
//   'npm' → npm；'github'（默认）→ github；'smart' → 先 github（失败再 npm，见 updatePlugin）。
// 返回 { target, src, source }：source 是显示用的 'both' | 'github' | 'npm' | null。
function pickTargetSource(npmV, ghV, pref) {
  if (npmV && ghV) {
    const cmp = compareVersions(ghV, npmV);
    if (cmp > 0) return { target: ghV, src: "github", source: "both" };
    if (cmp < 0) return { target: npmV, src: "npm", source: "both" };
    if (pref === "npm") return { target: npmV, src: "npm", source: "both" };
    return { target: ghV, src: "github", source: "both" }; // 默认 GitHub；smart 先试 GitHub
  }
  if (ghV) return { target: ghV, src: "github", source: "github" };
  if (npmV) return { target: npmV, src: "npm", source: "npm" };
  return { target: null, src: null, source: null };
}

// 单个插件的交叉检查：npm + GitHub 两源，目标版本取较高者；平局时按默认下载源设置。
// 无 dsh 字段且两源都无 → ignored（本地工具，不可更新，不进噪音清单）。
async function checkPlugin(p, force) {
  const item = {
    name: p.name,
    installed: p.installed,
    latest: null,      // 目标版本（交叉验证后的最高版本）
    npmLatest: null,
    ghLatest: null,
    ghTag: null,
    hasUpdate: false,
    onNpm: false,
    onGithub: false,
    source: null,      // 'npm' | 'github' | 'both' | null
    targetSource: null, // 更新时使用的下载源
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
        // Issue #3：monorepo 子包防误报 —— release tag 对应仓库根 package.json 的
        // name 必须与本地插件名一致才采信该 tag；主仓库 tag（name 对不上）视为与
        // 本插件无关，仅保留 npm 源，避免"黄灯→点更新→失败"死循环。
        // ghName 为 null（限流/网络/根无 package.json）时保持原行为采信，避免误伤
        // GitHub-only 插件（npm 上没有、只能 GitHub 安装的场景）。
        const ghName = await fetchGhPkgName(p.ghRepo, gh.tag);
        if (ghTagBelongsTo(ghName, p.name)) {
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
      // GitHub 访问不了：静默回退（仅 npm），记录原因；若 npm 也失败再一起报错
      item.ghError = String(err && err.message ? err.message : err);
    }
  }
  const npmV = item.npmLatest;
  const ghV = item.ghLatest;
  // v1.4.9：npm 与 GitHub 版本一致（平局）时的首选下载源（'github' | 'npm' | 'smart'）。
  // 仅平局生效；非平局仍按版本较高者。smart = 平局时先 GitHub，失败再 npm（见 updatePlugin）。
  const prefSource = (await readSettings()).downloadSource;
  const { target, src, source } = pickTargetSource(npmV, ghV, prefSource);
  item.source = source;
  item.latest = target;
  item.targetSource = src;
  item.downloadSource = prefSource; // 客户端设置面板显示当前偏好
  item.tie = !!(npmV && ghV && compareVersions(ghV, npmV) === 0); // v1.4.9：平局标记（smart 回退仅平局生效）
  if (item.installed && target) {
    item.hasUpdate = compareVersions(target, item.installed) > 0;
  }
  // v1.4.5：状态灯（黄=有更新 / 绿=最新 / 红=作者回退版本（本机高于两源）或无法查询到）
  item.status = deriveStatus(item.installed, target, !!(npmV || ghV));
  // 两源都拿不到版本 → 汇总报错（含超时）
  if (!target) {
    const parts = [];
    if (item.error) parts.push("npm: " + item.error);
    if (item.ghError) parts.push("github: " + item.ghError);
    item.error = parts.length ? parts.join("; ") : "no update source";
    // 本地工具（无 dsh 字段、两源都没有）→ 归入 ignored，不再刷"not on npm registry"噪音
    if (!p.hasDsh) {
      item.ignored = true;
      item.ignoreReason = "no dsh field and not on npm/GitHub (local tool)";
    }
  }
  // 变更说明：风险等级（semver 差）+ GitHub release 正文（有 gh 源时）
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
  // v1.4.11：并发检查（此前逐个 await，插件多时主程序横幅被拖慢；每插件独立 npm/GitHub 查询）
  const list = await Promise.all(plugins.map((p) => checkPlugin(p, force)));
  const active = list.filter((i) => !i.ignored);
  active.sort((a, b) =>
    a.hasUpdate === b.hasUpdate ? a.name.localeCompare(b.name) : a.hasUpdate ? -1 : 1
  );
  const ignored = list
    .filter((i) => i.ignored)
    .map((i) => ({ name: i.name, reason: i.ignoreReason }));
  const settings = await readSettings();
  return {
    checkedAt: Date.now(),
    plugins: active,
    ignored,
    suppressPluginBanner: settings.suppressPluginBanner,
    floatingEnabled: settings.floatingEnabled,
    notifyEnabled: settings.notifyEnabled,
  };
}

// ── 插件更新：临时目录安装 + 拷贝（布局无关，不破坏 profiles 其它包）─────
async function exists(p) {
  return lstat(p).then(() => true).catch(() => false);
}

// 操作日志（JSONL）：写失败不阻断主流程
async function opsLog(entry) {
  try {
    await mkdir(DSH_HOME, { recursive: true }).catch(() => {});
    const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
    await appendFile(OPS_LOG, line + "\n", "utf8");
  } catch {
    // 日志写失败静默
  }
}

// ── 备份目录（可配置 backupRoot；插件备份统一存 <backupRoot>/plugins）────────
async function readBackupRoot() {
  const s = await readState();
  const v = s.backupRoot;
  return typeof v === "string" && v.trim() ? v.trim() : BACKUP_DIR_DEFAULT;
}

async function writeBackupRoot(path) {
  const p = String(path || "").trim();
  if (!p) throw Object.assign(new Error("backup folder path required"), { code: "EINVALID" });
  // 仅接受绝对路径（Windows 盘符或 UNC），避免相对路径歧义
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

// 一次性迁移旧版插件备份位置（profiles/node_modules/.dsh-plugin-backups → <backupRoot>/plugins）
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
    // 迁移失败不阻断（旧位置备份仍可读——listPluginBackups 兼容读取）
  }
}

// 删除全部备份缓存（主程序 + 插件）；返回删除的条目数
async function clearAllBackups() {
  const { main, plugins } = await backupDirs();
  let removed = 0;
  for (const d of [main, plugins]) {
    try {
      const entries = await readdir(d, { withFileTypes: true });
      for (const e of entries) {
        // plugins 是主程序备份目录下的插件备份容器，单独遍历，不能在 main 层被当作普通条目删除
        if (d === main && e.name === "plugins") continue;
        await rm(join(d, e.name), { recursive: true, force: true }).catch(() => {});
        removed++;
      }
    } catch {
      // 目录不存在/不可读
    }
  }
  return { removed };
}

// Windows 原生文件夹选择对话框（FolderBrowserDialog）：经 PowerShell -EncodedCommand 弹出，
// 用户选择后返回绝对路径；取消或超时（5 分钟）返回 null。
function pickFolderWithDialog(initialPath) {
  return new Promise((resolve, reject) => {
    // 注意：必须给对话框一个 TopMost + ShowInTaskbar 的 owner 窗口（最小化），否则后台启动的
    // PowerShell 弹出的对话框会被其它窗口盖住、且任务栏无按钮（实测问题）。
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
      // 忽略
    });
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // 已退出
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

// ── 主程序更新进度（进度条）：/update 同步执行期间实时写状态文件，客户端轮询读取 ──
let progressCache = null;

async function writeProgress(patch) {
  try {
    progressCache = { at: Date.now(), running: true, ...(progressCache || {}), ...patch };
    await writeFile(UPDATE_PROGRESS_FILE, JSON.stringify(progressCache, null, 2), "utf8");
  } catch {
    // 进度写失败静默
  }
}

async function clearProgress() {
  progressCache = null;
  try {
    await rm(UPDATE_PROGRESS_FILE, { force: true });
  } catch {
    // 不存在也正常
  }
}

async function readProgress() {
  try {
    return JSON.parse(await readFile(UPDATE_PROGRESS_FILE, "utf8"));
  } catch {
    return null;
  }
}

// 统计部署 lockfile 的包条目数（install 目标树大小的近似分母，用于进度百分比）
async function countLockfilePackages(root) {
  try {
    const lk = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
    return lk && lk.packages ? Object.keys(lk.packages).filter((k) => k.startsWith("node_modules/")).length : 0;
  } catch {
    return 0;
  }
}

// spawn 版 npm 执行：逐行捕获输出，实时回调进度（npm --loglevel=http 会给每个包输出一行
// `npm http ...`，数行数/总数即近似进度）。返回 { stdout, stderr }；非零退出 reject（同 execP 语义）。
// v1.4.10：新增 timeout 保护——超过 opts.timeout 即 kill 子进程并 reject（D1：install 无超时保护）。
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
      try { child.kill(); } catch { /* 已退出 */ }
    }, timeoutMs);
    const maybeEmit = (done) => {
      const now = Date.now();
      if (onProgress && (done || now - lastEmit > 200)) {
        lastEmit = now;
        onProgress({ httpCount, done: !!done, stderrTail: stderr.slice(-400), stdoutTail: stdout.slice(-400) });
      }
    };
    child.stdout.on("data", (d) => {
      stdout += d.toString("utf8");
      maybeEmit(false);
    });
    child.stderr.on("data", (d) => {
      const s = d.toString("utf8");
      stderr += s;
      httpCount += (s.match(/npm http /g) || []).length;
      maybeEmit(false);
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      maybeEmit(true);
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

// 解压 GitHub codeload tarball（gzip + tar，纯 node）；返回包根目录（第一层）
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
    const target = resolve(destDir, e.name); // resolve 后校验不逃逸
    if (!target.startsWith(resolve(destDir))) continue;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, e.data);
  }
  return root;
}

// ── v1.4.10 完整性校验（D3）────────────────────────────────────────────
// 安装后校验安装树是否完整可用，任何一项不通过即判定失败（触发回滚）：
//   1) 关键 @deepseek-ai 包 package.json 存在且版本 = 目标版本（全树版本一致性）
//   2) dsh-web-frontend/dist/assets 文件数与 dist/index.html 引用的 /assets/* 一致（无缺文件）
//   3) 每个含 lib/ 或 client.js 的 @deepseek-ai 包入口文件存在（防"空壳包"）
// 返回 { ok, problems: string[] }；problems 含每一项的具体缺失描述。
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
  // 1) 全树 @deepseek-ai 版本一致性（dsh-* 必须等于目标版本；非 dsh- 前缀基础库跳过）
  for (const n of names) {
    if (!n.startsWith("dsh-")) continue;
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
  // 2) dsh-web-frontend/dist 完整性（index.html 引用的 assets 都在）
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
    // 元文件完整性：dist 之外必须有 package.json
    if (!(await exists(join(nm, "dsh-web-frontend", "package.json")))) {
      problems.push("dsh-web-frontend package.json missing (metadata wiped)");
    }
  } catch {
    problems.push("dsh-web-frontend dist/index.html unreadable");
  }
  // 3) client 入口文件存在性（防空壳包）
  for (const n of names) {
    const pkgDir = join(nm, n);
    const hasLib = await exists(join(pkgDir, "lib"));
    if (!hasLib) continue; // 非 client 包（host-only）无需 lib
    const entry =
      (await exists(join(pkgDir, "lib", "client.js"))) ||
      (await exists(join(pkgDir, "lib", "index.js"))) ||
      (await exists(join(pkgDir, "client.js")));
    if (!entry) problems.push(`${n} has lib/ but no client.js/index.js (empty shell)`);
  }
  return { ok: problems.length === 0, problems };
}

// 解析 package.json 的入口文件（main / exports["."] 优先 require/import/default），用于
// GitHub 源码仓库校验（无构建产物时拒绝替换）。
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

// 备份旧版 + 替换（junction 防御，安全替换；可选 node_modules 过滤，避免把 GitHub 通道
// 阶段安装的嵌套依赖树整体拷进插件目录）。返回备份目录（含 backup-info.json 供回滚）。
// manifestSpec：替换前该插件在 profile package.json 里的依赖声明（回滚时写回用；v1.4.6）。
async function backupAndReplace(dst, src, filter, manifestSpec) {
  try {
    const st = await lstat(dst);
    if (st.isSymbolicLink()) await rm(dst, { recursive: false, force: true });
  } catch {
    // dst 不存在
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
      // 备份目录自身无 package.json 也正常
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

// 依赖合并决策（纯函数，可单测）：depSpecs {name: range} × installedMap {name: version|null}
// → [{dep, range, installed, action: copy|keep|replace}]。版本不满足范围 → replace（缺陷修复核心）。
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

// 持久化规格推导（纯函数，可单测）：一键更新只替换 node_modules 里的插件文件，从不回写
// profile 的 package.json / 锁文件 —— 于是下次 pnpm/npm install 按旧声明把插件拉回旧版，
// 检查器又报"有更新"、用户再点更新……同一插件反复提醒的死循环（v1.4.6 修复）。
// 本函数按「声明里的旧 spec + 刚装上的新版本」推导应写回声明的新 spec：
//   - semver 风格：保留前导操作符，版本换成新版本。^0.12.3 → ^0.13.1；~1.13.1 → ~1.14.1；
//     0.2.3 → 0.3.0；单比较符（>=1.2.3 等）保留操作符；复杂范围（含空格/||/连字符）→ ^新版本。
//   - github:owner/repo[#ref] / GitHub URL，且更新源为 github 且有 release tag：钉到
//     github:owner/repo#tag（npm/pnpm 均支持 git 依赖 #ref，下次 install 按该 tag 锁版本）。
//   - 其它（file: / workspace: / npm: 别名 / 无法解析）：null → 跳过持久化（保持旧行为）。
function derivePersistedSpec(oldSpec, newVersion, gh) {
  if (!oldSpec || typeof oldSpec !== "string") return null;
  const s = oldSpec.trim();
  if (!s) return null;
  if (typeof newVersion !== "string" || !/^\d+\.\d+\.\d+([-.][0-9A-Za-z.-]+)?$/.test(newVersion)) {
    return null; // 防注入：只接受 semver 形版本
  }
  const caretTilde = /^(\^|~)/.exec(s);
  if (caretTilde) return `${caretTilde[1]}${newVersion}`;
  if (/^[vV]?\d+\.\d+\.\d+([-.][0-9A-Za-z.-]+)?$/.test(s)) return newVersion; // 精确版本
  const cmp = /^([<>=]+)/.exec(s);
  if (cmp && !/[\s|]/.test(s)) return `${cmp[1]}${newVersion}`; // 单比较符：>=1.2.3 → >=新版本
  if (/^[\d\s<>=~^|*-]/.test(s)) return `^${newVersion}`; // 复杂范围 → npm 默认 caret
  if (gh && gh.source === "github" && gh.tag) {
    const m = /^(?:git\+)?(?:https?:\/\/github\.com\/|git:\/\/github\.com\/|github:)([^#]+?)(?:\.git)?(?:#.*)?$/.exec(s);
    if (m && m[1]) return `github:${m[1]}#${gh.tag}`;
    if (gh.owner && gh.repo) return `github:${gh.owner}/${gh.repo}#${gh.tag}`;
  }
  return null;
}

// 依赖备份（替换共享依赖前留底）
async function backupDep(name, dst) {
  const root = join((await backupDirs()).plugins, `dep-${name.replace(/[/\\]/g, "-")}-${Date.now()}`);
  await mkdir(root, { recursive: true });
  await cp(dst, join(root, basename(dst)), { recursive: true, force: true });
  return root;
}

// 依赖合并（带版本核对）：新插件 package.json 的 dependencies/optionalDependencies 中，
// profiles 缺失的 → 拷贝；已装但不满足版本范围的 → 备份旧版后替换；junction 一律保留。
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

// 收集 tmp/node_modules 下带 install/preinstall/postinstall 脚本的包名（npm≥12 二次安装白名单用）
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
        // 无 package.json，跳过
      }
    }
  }
  await walk(nmDir);
  return [...new Set(out)];
}

// npm ≥12 时依赖 install 脚本默认被拦：二次安装并 --allow-scripts 白名单放行（原生依赖构建）。
// npm 11 及以下默认执行脚本（实测），无需处理。
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

// 插件临时安装参数（npm 通道：--prefix 临时目录，绝不对 profiles 直接执行）
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

// 阶段安装参数（GitHub 通道：以解压出的插件目录为项目根安装其 dependencies）
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

// 收尾：备份替换 + 依赖合并（含版本核对）+ 缓存失效 + 恢复提示标记
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
  // v1.4.6：把新版本持久化回 profile 的 package.json + 锁文件，否则下次 install 会拉回
  // 旧版 → 同一插件反复提醒更新。持久化失败不否决更新本身（文件已替换），如实回报。
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

// ── 插件更新持久化（v1.4.6）：manifest + 锁文件同步 ─────────────────────
// 背景：此前插件更新只替换 node_modules 文件。profile 的 package.json 仍声明旧版本、
// pnpm-lock.yaml / package-lock.json 仍锁旧版本，任何一次 pnpm/npm install（或 profile 重装）
// 都会把插件拉回旧版 → 检查器再报"有更新" → 用户再点更新，同一插件无限循环提醒。
// 修复：更新成功后把新 spec 写回所有声明该插件的 profile 清单，并调用包管理器同步锁文件
// （仅 --lockfile-only / --package-lock-only，不动 node_modules，不触发原生构建）。

// 判定 targetDir 所在的 profile 目录：<PROFILES_ROOT>/<name>/node_modules/... → <PROFILES_ROOT>/<name>；
// 不在任何 profile 层（如共享 profiles/node_modules）→ null，交给声明扫描兜底。
function profileDirOf(targetDir) {
  if (!targetDir || !PROFILES_ROOT) return null;
  const rel = String(targetDir);
  if (!rel.startsWith(PROFILES_ROOT)) return null;
  const rest = rel.slice(PROFILES_ROOT.length).split(/[\\/]/).filter(Boolean);
  if (rest.length >= 2 && rest[1] === "node_modules") return join(PROFILES_ROOT, rest[0]);
  return null;
}

// 找出所有声明了该插件的 profile 目录（package.json 的 dependencies/devDependencies）。
// targetDir 所在的 profile 无条件纳入（即使未声明）；找不到任何声明时返回空数组。
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
    // profiles 不可读：仅剩 targetDir 隐含的 profile
  }
  return [...out];
}

// 读取该插件当前在 profile 清单里的依赖声明（备份记录用；多 profile 声明时取第一个）。
async function readManifestSpecFor(pluginName, targetDir) {
  const profiles = await findDeclaringProfiles(pluginName, targetDir);
  for (const dir of profiles) {
    try {
      const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
      const section = declaredSection(pkg, pluginName);
      const spec = pkg[section] && pkg[section][pluginName];
      if (typeof spec === "string") return spec;
    } catch {
      // 下一个
    }
  }
  return null;
}

// pnpm 可执行文件定位（锁文件同步用；测试钩子 DSH_UC_PNPM_BIN）：
//   1) 显式 DSH_UC_PNPM_BIN（集成测试注入假 pnpm；"__none__" 表示强制视为不可用；
//      值以 .js/.mjs/.cjs 结尾时用 node 执行，便于跨平台测试桩）
//   2) 确定性候选（pnpmCandidates）逐个 existsSync 探测
//   3) PATH 兜底（findPnpmInPath）：pnpm.cmd/pnpm（npm 全局 shim 布局时优先解析真实 pnpm.cjs）
// v1.4.7 修复（实测 Windows 布局缺口）：
//   - node 目录旁无扩展名 corepack 是 bash-only shim（#!/bin/sh），Windows cmd 无法执行 → 用 corepack.cmd/.exe；
//   - npm 全局前缀不一定在 node 目录旁（Windows 用户级安装：%APPDATA%\npm，实测 pnpm 在
//     %APPDATA%\npm\node_modules\pnpm\bin\pnpm.cjs）→ 从 NPM_CLI 反推全局 node_modules 根 + PATH 兜底；
//   - Linux 独立安装（~/.local/bin 等非 node 目录布局）→ PATH 兜底命中。
// pnpmCandidates(exeDir, npmCli, platform) 为纯函数（可单测）；返回 { cmd, viaNode, corepack } 候选列表，
// viaNode=true 时用 node 执行该 .cjs（Windows 常见），corepack=true 时加 "pnpm" 子命令前缀。
function pnpmCandidates(exeDir, npmCli, platform = process.platform) {
  const isWin = platform === "win32";
  const list = [];
  // Windows 常见：node 旁 npm -g（C:\Program Files\nodejs\node_modules\pnpm\bin\pnpm.cjs）
  list.push({ cmd: join(exeDir, "node_modules", "pnpm", "bin", "pnpm.cjs"), viaNode: true, corepack: false });
  // Linux 标准前缀 npm -g（/usr/local/lib/node_modules、nvm 等）
  list.push({ cmd: join(exeDir, "..", "lib", "node_modules", "pnpm", "bin", "pnpm.cjs"), viaNode: true, corepack: false });
  if (!isWin) {
    // Unix：无扩展名 pnpm shim / corepack（shebang 可执行）
    list.push({ cmd: join(exeDir, "pnpm"), viaNode: false, corepack: false });
    list.push({ cmd: join(exeDir, "corepack"), viaNode: false, corepack: true });
  } else {
    // Windows：无扩展名 corepack 是 bash shim（cmd 无法执行），用 .cmd/.exe
    list.push({ cmd: join(exeDir, "corepack.cmd"), viaNode: false, corepack: true });
    list.push({ cmd: join(exeDir, "corepack.exe"), viaNode: false, corepack: true });
  }
  // npm 全局前缀推导：NPM_CLI 位于 <globalNodeModules>/npm/bin/npm-cli.js，
  //   三级 dirname 即全局 node_modules 根（Windows <prefix>/node_modules；Linux <prefix>/lib/node_modules）
  if (npmCli) {
    const npmGlobalRoot = dirname(dirname(dirname(npmCli)));
    list.push({ cmd: join(npmGlobalRoot, "pnpm", "bin", "pnpm.cjs"), viaNode: true, corepack: false });
    if (isWin) {
      list.push({ cmd: join(npmGlobalRoot, "pnpm", "bin", "pnpm.cmd"), viaNode: false, corepack: false });
    }
  }
  return list;
}

// PATH 兜底：遍历 PATH 找 pnpm（Unix）或 pnpm.cmd/.exe/.bat（Windows）。
// Windows 上 npm 生成的 cmd shim 常指向同目录 node_modules/pnpm/bin/pnpm.cjs，优先解析为真实 cjs。
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

// 锁文件同步：仅更新锁文件（pnpm --lockfile-only / npm --package-lock-only），
// 不碰 node_modules、不触发 install 脚本；失败不影响插件文件本身（已替换完成）。
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

// 插件在清单里实际声明的区块（dependencies / devDependencies / 无声明 → 默认 dependencies）。
function declaredSection(pkg, name) {
  if (pkg && pkg.devDependencies && Object.prototype.hasOwnProperty.call(pkg.devDependencies, name)) {
    return "devDependencies";
  }
  return "dependencies";
}

// 把给定 spec 写回所有声明该插件的 profile 清单，并同步各自锁文件。
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

// 更新成功后按「新版本」推导 spec 并持久化（semver 声明 → ^/~/精确升级；github 声明 → 钉 tag）。
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

// GitHub 安装通道：codeload tarball（带大小上限）→ 解压 → 构建产物校验（main/exports 存在、
// tag 与 package.json 版本一致）→ 阶段安装依赖 → 备份替换 + 依赖合并。
async function updatePluginFromGitHub(target, tag, version) {
  const tmp = await mkdtemp(join(tmpdir(), "dsh-update-checker-gh-"));
  try {
    const url = `https://codeload.github.com/${target.ghRepo}/tar.gz/${encodeURIComponent(tag)}`;
    // v1.4.8：下载失败（HTTP 5xx/429、网络错误、超时）与 tarball 损坏统一标 EDOWNLOAD，
    // 使 updatePlugin 的 GitHub→npm fallback 生效（此前 502 无 code 直接失败——
    // 本机 S302 代理对 codeload 转发返回 502 实测；ETOOBIG 保持原码）。
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
    // 阶段安装：以插件目录为项目根安装其 dependencies（含原生依赖构建；npm≥12 补 allow-scripts）
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

// npm 安装通道：临时目录安装（版本钉死，避免检查与安装间竞态）→ 原生脚本 → 收尾
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

// v1.4.8：GitHub 源不可用错误码集合（updatePlugin 的 GitHub→npm fallback 判定，纯函数可单测）。
// EDOWNLOAD 为 v1.4.8 新增：下载失败（HTTP 5xx/429、网络错误、超时）与 tarball 损坏——
// 修复"本机 S302 代理对 codeload 转发 502 时更新直接失败"（此前 502 无 code 不进 fallback）。
function isGhFallbackable(err) {
  return !!err && ["ENOBUILD", "ETAGMISMATCH", "ETOOBIG", "EDOWNLOAD"].includes(err.code);
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
  // GitHub 优先下载源：交叉检查后若目标源为 github 且有 release tag，走 GitHub 通道
  if (probe.targetSource === "github" && probe.ghTag) {
    try {
      return await updatePluginFromGitHub(target, probe.ghTag, probe.latest);
    } catch (err) {
      // GitHub 源不可用（源码仓库无构建产物 / tag 与 package.json 版本不符 / 下载超限 /
      // 下载失败 EDOWNLOAD——HTTP 5xx/429、网络错误、tarball 损坏，v1.4.8 加入）：
      // 若插件在 npm 上存在，自动回退 npm 通道（1.4.1 修复：dshmarket 等"npm 有、GitHub 是源码"的插件）。
      // v1.4.9：默认下载源为 smart 且为平局时（npm 与 GitHub 版本一致），GitHub 任意失败
      // 都回退 npm，不再受 isGhFallbackable 错误码白名单限制（连不上 GitHub 的用户也可更新）；
      // 非平局仍按版本较高者 + 错误码白名单，避免降级到较低版本。
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

// ── 备份清单与回滚 ─────────────────────────────────────────────────────
async function listMainBackups() {
  try {
    const main = (await backupDirs()).main;
    const dirs = await readdir(main, { withFileTypes: true });
    const out = [];
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      // plugins 是插件备份容器目录（不是主程序备份），不能当成备份条目
      if (d.name === "plugins") continue;
      let meta = null;
      try {
        meta = JSON.parse(await readFile(join(main, d.name, "backup-meta.json"), "utf8"));
      } catch {
        // 老备份无 meta
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
        // 老备份无 info
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

// 回滚主程序：按最新备份记录的旧版本重装（dry-run 守卫 + 生态同步 + 回读校验）
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
  await dryRunGuard(root, spec); // 安全闸：回滚同样不允许 remove 计划（超时降级放行，由回读校验兜底）
  const safetyBackup = await backupForUpdate(root); // 回滚前的现场快照（可再回滚回来）
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

// 回滚插件：从 .dsh-plugin-backups/<id> 恢复到原始路径（校验不越界）
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
    // 老备份无 info
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
    // 目标不存在
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
    // 恢复后无 package.json 也继续（至少目录回来了）
  }
  const manifestName = pkgName || (info && info.pkgName) || name;
  // v1.4.6：回滚同样要把旧声明写回 profile 清单 + 锁文件，否则下次 install 又拉回新版本。
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

// ── HTTP 辅助 ──────────────────────────────────────────────────────────
function readJsonBody(req) {
  return new Promise((resolveBody) => {
    let chunks = "";
    let tooLarge = false;
    req.on("data", (c) => {
      if (tooLarge) return; // 已超限，继续排空但不累计
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

// 写操作路由来源校验：仅允许回环来源（浏览器同源请求的 socket 对端即 127.0.0.1）。
// 防止局域网内非浏览器客户端（如装了 0.0.0.0 绑定的 dsh-lan-gateway 场景）远程触发
// 更新/重启/回滚等破坏性操作。
function isLoopback(req) {
  const a = req && req.socket && req.socket.remoteAddress;
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
}

// 写路由公共前置：解析 body → 校验来源/confirm/大小
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
          const g = await writeGate(req, res);
          if (g.err) return;
          const ok = await writeSuppressUpToDate(true);
          return json(res, ok ? 200 : 500, ok ? { ok: true } : { ok: false, error: "failed to write state" });
        },
      });

      // v1.4.10 完整更新主程序（安全状态机，修复 BUG-EVIDENCE-20260820 的 D1/D2/D3/D4/D5/D7）：
      // 检查 → 备份 → 生成独立更新脚本 → 两级 spawn 脱钩执行（脚本内：停服务 → install(超时)
      // → 回读校验 → 完整性校验 → 声明同步 → 重启 → 健康检查；任一失败回滚备份）。
      // 关键：install 在**服务停止后**执行（D2 并发修复），且整个流程在独立子进程运行，
      // 与 DSH 主进程脱钩——杀掉 3080 服务不会中断更新流程。
      webServer.register({
        kind: "exact",
        path: "/dsh-update-checker/update",
        handler: async (req, res) => {
          const g = await writeGate(req, res);
          if (g.err) return;
          const body = g.body;
          if (updateInFlight && Date.now() - updateStartedAt < 600000)
            return json(res, 409, { ok: false, error: "update already running" });
          const root = await findDeployRoot();
          if (!root) return json(res, 500, { ok: false, error: "deployment root not found" });
          const dry = body && body.dry === true;
          updateInFlight = true;
          updateStartedAt = Date.now();
          try {
            await clearProgress();
            await writeProgress({ phase: "check", label: "正在查询最新版本…", percent: 2 });
            const latestInfo = await resolveMainTarget(true); // fresh（v1.4.10 双源）
            if (dry) {
              // dry 预览：同步执行（不停服务、不安装），仅返回计划与 dry-run 结果
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
            // 真实更新：备份 → 写独立脚本 → 脱钩执行（不停 HTTP 同步等）
            await writeProgress({ phase: "backup", label: "备份当前版本…", percent: 8 });
            const backupDir = await backupForUpdate(root); // 事前备份（含旧版本号 + 版本清单）
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
            };
            // 两级 spawn 脱钩（R25）：本进程 spawn powershell → powershell Start-Process 独立孙进程跑脚本，
            // 保证更新流程与 DSH 主进程完全解耦（主进程被杀也不影响更新）。
            // 用 resolveNodeExe() 而非 process.execPath：issue #8（Electron 下 execPath 是 electron.exe，
            // 会把 worker 当 Electron 应用启动）。
            const inner = `Start-Process -WindowStyle Hidden -FilePath '${resolveNodeExe()}' -ArgumentList '${scriptPath}'`;
            const child = spawn(
              "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
              ["-NoProfile", "-NonInteractive", "-Command", inner],
              { stdio: "ignore", windowsHide: true, env }
            );
            child.unref();
            return json(res, 200, {
              ok: true,
              message: "update started in background (stop service -> install -> verify -> restart)",
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

      // 主程序更新进度（进度条数据；/update 执行期间实时更新，客户端轮询）
      webServer.register({
        kind: "exact",
        path: "/dsh-update-checker/update-progress.json",
        handler: async (req, res) => {
          const p = await readProgress();
          if (!p) return json(res, 404, { ok: false, error: "no update in progress or recorded" });
          json(res, 200, p);
        },
      });

      // 回滚主程序：按最新备份记录的旧版本重装（含生态同步与回读校验）
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

      // 备份清单：主程序 + 插件历史备份（回滚入口数据）
      webServer.register({
        kind: "exact",
        path: "/dsh-update-checker/backups.json",
        handler: async (req, res) => {
          const [main, plugins] = await Promise.all([listMainBackups(), listPluginBackups()]);
          json(res, 200, { main, plugins });
        },
      });

      // 备份设置：当前备份文件夹 + 主程序/插件备份计数（设置页"恢复与备份"卡片数据源）
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

      // 修改备份文件夹（要求绝对路径；改后回滚按钮按新位置实时显示）
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

      // 删除备份文件缓存（主程序 + 插件全部备份；删除后回滚按钮自动消失）
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

      // 弹出 Windows 原生文件夹选择对话框，返回用户选择的备份文件夹路径（取消返回 picked:false）
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

      // 用资源管理器打开当前备份文件夹
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

      // 重启服务：两级 spawn 脱钩 + 看门狗（独立孙进程跑 restart-watchdog.ps1；
      // 启动器派生自当前进程 argv，不再猜文件名；杀 PID + 端口双保险；HTTP 恢复确认写结果）
      webServer.register({
        kind: "exact",
        path: "/dsh-update-checker/restart",
        handler: async (req, res) => {
          const g = await writeGate(req, res);
          if (g.err) return;
          if (restartScheduled) return json(res, 409, { ok: false, error: "restart already scheduled" });
          const root = await findDeployRoot();
          if (!root) return json(res, 500, { ok: false, error: "deployment root not found" });
          const port = typeof webServer.port === "number" ? webServer.port : 3080;
          restartScheduled = true;
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

      // 最近一次重启看门狗的结果（恢复确认；服务恢复后页面可轮询）
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

      // 插件更新检测：扫描第三方插件（多位置）+ npm/GitHub 双源版本对比；不可更新工具归入 ignored
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

      // 更新指定插件（临时目录安装 + 拷贝 + 依赖版本核对 + 原生脚本，布局无关）
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

      // 回滚插件：从 .dsh-plugin-backups/<id> 恢复
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

      // 持久化"不再提示插件更新"（插件横幅，与主程序的 /suppress 对称）
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

      // 设置页数据：悬浮窗/提示开关与两个"不再提示"标记
      webServer.register({
        kind: "exact",
        path: "/dsh-update-checker/settings.json",
        handler: async (req, res) => {
          json(res, 200, await readSettings());
        },
      });

      // 更新设置：POST { confirm:true, floatingEnabled?, notifyEnabled?, suppressUpToDate?,
      // suppressPluginBanner?, downloadSource? }
      webServer.register({
        kind: "exact",
        path: "/dsh-update-checker/settings",
        handler: async (req, res) => {
          const g = await writeGate(req, res);
          if (g.err) return;
          const body = g.body;
          const patch = {};
          for (const k of ["floatingEnabled", "notifyEnabled", "suppressUpToDate", "suppressPluginBanner"]) {
            if (typeof body[k] === "boolean") patch[k] = body[k];
          }
          if (["github", "npm", "smart"].includes(body.downloadSource)) patch.downloadSource = body.downloadSource;
          await writeState(patch);
          return json(res, 200, { ok: true, settings: await readSettings() });
        },
      });
    });
  },
};

// ── 纯函数导出（供单元测试 import；插件装载仍只消费 default 导出）──
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
};

// ── 集成测试导出（含 fs 操作；配合 DSH_UC_PROFILE_NODE_MODULES 环境变量在临时目录模拟部署布局）──
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
