# dsh-update-checker

[English](README.md) | 中文

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web GUI 的常驻 Cordis 插件：**自动检查 DeepSeek Harness 主程序与已安装第三方插件的新版本**（原独立的 `dsh-plugin-checker` 已在 v1.1.0 合并进来），向用户提示，并支持一键更新（带成功/失败反馈）。

## 功能特性

- **完整更新生命周期** — 检查、备份、更新、回滚、重启，一个插件全部完成。
- **主程序检查** — 对比已安装的 `@deepseek-ai/dsh` 与 npm 最新版（全量 packument、稳定版优先、semver 感知——latest tag 指向 prerelease 也不会误报）。
- **第三方插件检查** — 扫描已安装的非官方插件（布局无关，支持 pnpm hoisted 的多位置 `node_modules`），逐一与 npm/GitHub 双源对比（目标版本取较高者）；无发布源的本地工具归入 `ignored`。同名插件多位置时**优先组合所属 profile 的副本**（其余记为 `copies` 供区分），可**逐个"不再提醒"排除**（`excludedPlugins`，设置页可一键恢复）。
- **GitHub 更新通道** — 对 GitHub 域使用专用 HTTPS 客户端（兼容本地自签名证书代理；npm registry 仍走严格校验），带重定向跟随、大小上限与超时；codeload tarball 解压前校验构建产物。
- **界面内横幅** — 跟随 DSH 界面语言（zh/en），显示有更新 / 已是最新 / 失败三种状态，支持"不再提示"；更新横幅展示**变更说明 brief**（vX→vY + 风险等级，有 GitHub release 正文时附更新要点）。
- **安全的一键更新** — 主程序：dry-run 守卫（计划内有 remove 即中止）→ 备份 → 布局自适应安装（原位或 `-g`）→ 安装后回读校验 `installed==latest`；插件：临时目录安装 + 拷贝、依赖版本核对、npm ≥ 12 自动补 `--allow-scripts` 构建原生依赖。**更新（与回滚）会持久化回 profile 的 `package.json` + 锁文件**（`pnpm install --lockfile-only` / `npm install --package-lock-only`），之后的 install 不会再把插件悄悄拉回旧版——不再出现「同一插件反复提醒更新」的死循环。
- **真回滚** — 主程序 `POST /rollback`、插件 `POST /plugin-rollback`；`GET /backups.json` 列出两者备份。
- **看门狗重启** — 启动器从当前进程 argv 派生，杀 PID + 端口双保险，恢复确认升级为端口监听 + HTTP 200 探测（`GET /restart-status.json`）。
- **写操作安全** — 所有写路由除 `{ "confirm": true }` 外还要求回环来源（127.0.0.1/::1），局域网客户端无法远程触发更新/重启/回滚。
- **零配置可移植** — profile 目录 / `$DSH_HOME` / 组合文件 / 部署根均由插件自身安装位置自动推导，任何机器无需改代码。

### Host 与 Client

- **Host**（`lib/index.js`）— HTTP 路由：`status.json`（检查）、`suppress`、`update`（支持 `dry` 预览）、`rollback`、`backups.json`、`restart`、`restart-status.json`、`plugins.json`、`plugin-update`、`plugin-rollback`、`plugin-exclude`。
- **Client**（`lib/client.js`）— 在根级 `shell.overlay` 插槽渲染两个横幅：主程序横幅（更新状态）与插件横幅（可更新插件，支持单个 / 全部更新）。页面加载时各检查一次，之后每 6 小时复查；设置页「检查更新」另提供回滚按钮。

## 安装与装载

该包是一个 [profile bundle](https://github.com/deepseek-ai/deepseek-harness)（其清单声明了 `dsh.bundle.patch`）。

```bash
# 1) 把包放进 $DSH_HOME/profiles/node_modules/，让 profile 能解析到它。
#    ⚠️ 绝不要在 $DSH_HOME/profiles 目录里直接跑 `npm install`——该目录没有
#    package.json，npm 会把整个 node_modules 判为多余并清空（数据丢失）。
#    安全方式 A —— 临时目录安装后只拷贝本包：
npm i dsh-update-checker --prefix <temp-dir> --no-save
cp -r <temp-dir>/node_modules/dsh-update-checker $DSH_HOME/profiles/node_modules/
#    安全方式 B —— 手动拷贝包目录（git clone 或解包 tarball 后整目录拷入）。

# 2) 在 $DSH_HOME/profiles/web/cordis.patch.yml 增加组合行
```

```yaml
# $DSH_HOME/profiles/web/cordis.patch.yml
- insert:
    - id: dsh-update-checker
      name: 'dsh-update-checker'
```

然后让 patch HMR 生效（或重启 `dsh web`）并刷新页面。

> 图文安装步骤与常见问题：见 [docs/INSTALL.md](docs/INSTALL.md)。

## 配置与可移植性

所有路径**运行时自动检测——没有任何硬编码**：

- **插件 / profile 目录** — 由插件自身安装位置（`import.meta.url`）推导。
- **`$DSH_HOME`** — `profiles` 根目录的父目录（状态文件、备份、重启日志都在这里）。
- **组合文件** — 默认 `$DSH_HOME/profiles/web/cordis.patch.yml`。
- **部署根** — 先 junction `realpath` 解析，再 `DSH_DEPLOY_ROOT`，然后 `process.cwd()`，最后 **npm 全局前缀**（`npm root -g` 的父目录，v1.4.9 起支持 npm -g 全局安装形态）。
  - systemd / npm -g 逃生口：自动探测万一没命中你的布局时，把 `DSH_DEPLOY_ROOT` 设为包含 `node_modules/@deepseek-ai/dsh` 的目录（Linux 上通常是 `<npm prefix>/lib`）。
- **node / npm 可执行文件** — `resolveNodeExe()` 定位真实 node：`DSH_UC_NODE_EXE` 覆盖 → `npm_node_execpath` → `process.execPath`（若确实是 node）→ 常见安装目录 → PATH。这就是 DSH Desktop（Electron，`process.execPath` 是 electron.exe）能跑 npm 更新插件的原因；若你的桌面端把 node 打包在别处，设 `DSH_UC_NODE_EXE` 指向它即可。
- **重启启动器** — 自适应：在部署根下探测常见启动脚本名；web 端口读取运行中的 `webServer.port`。

## 平台与安装布局支持

- **检测（检查类功能）** — 布局无关，可在任何机器工作。
- **一键更新与重启** — 针对开发时的布局调优：
  - **仅 Windows** — 重启流程 spawn PowerShell。
  - 主程序更新自适应：部署根有 `package.json` 时原位 `npm install`，否则 `npm install -g`；两种形态都先过 dry-run 守卫并在安装后回读校验版本。
  - 插件更新 — 临时目录安装 + 拷贝，兼容 npm 11/12+。
- 其它平台/布局下横幅与版本检查仍可用，但更新/重启按钮需要改代码。Linux/macOS 支持是自然的下一步。

## 说明

- **Host 代码改动需要重启服务才生效**（加载器缓存已导入模块）；client 改动由 HMR 拾取，下次刷新页面即生效。
- update/rollback/restart/suppress/settings 等写路由由 `{ "confirm": true }` **且回环来源**（127.0.0.1/::1）双重守护。
- `npm install` 前会向 `$DSH_HOME/dsh-update-checker-backups/<timestamp>/` 写入备份（部署 `package-lock.json` + 两份 @deepseek-ai 版本清单 + `backup-meta.json`），主程序与插件都有对应回滚路由。

## 更新日志

- **v1.4.16** — 单个插件排除 + 同名副本处理：
  - **单个插件"不再提醒"**（issue #10）：插件横幅与设置页都是每个插件一个「不再提醒 / Don't remind」动作；被排除的插件进入「已排除的插件」列表，可一键恢复。持久化在 `dsh-update-checker-state.json` 的 `excludedPlugins`。
  - **同名副本**：同名插件装在多个 `node_modules` 时，**优先组合所属 profile 的 `node_modules` 那份**（符合 Node 就近解析），其余记为 `copies`；每个插件也显示安装路径，让你能分辨检查的是哪一份。

- **v1.4.14** — 下载优先的主程序更新（不再一点击就杀进程）、健康检查/校验器修复、跨进程更新锁、profiles 同步、全源码注释移除：
  - **下载优先流程**（用户要求）：点更新不再立即停服务——worker 先在服务运行中把东西**全部下载/预热到本地缓存**（npm `--dry-run` 预热，或 registry tarball 整树下载），下载完才停服做快速应用；网络耗时阶段页面保持可用。
  - **健康检查修复**：此前用 `https.get()` 请求 `http://127.0.0.1:3080`，必然抛 `ERR_INVALID_PROTOCOL`——每次安装成功后最后一步健康检查崩、误报失败且不自动重启（v1.4.10 潜伏，2026-08-21 首次暴露）。现按 URL 协议选 http/https。
  - **dist 校验修复**：资源遍历产生 `//assets/...`（双斜杠）导致引用永远匹配不上，前端更新成功后必被误判缺失。现已正确构造路径。
  - **入口校验修复**：接受 `lib/bin.js` / `lib/index.cjs` / `index.mjs` 等常见入口，`dsh`、`schemastery` 不再被误报"空壳"。
  - **不在目标发布集的包**（如 `dsh-client-schema-form` / `dsh-client-web-react` 在 npm 上无 `0.1.0-rc.8`）跳过并排除其版本校验，不再导致更新失败。
  - **跨进程更新锁文件**：防止两个并发更新（此前两个 worker 并发会互相踩踏、损坏前端 dist）。
  - **部署树 → profiles 同步**：非 junction（pnpm hoisted）安装在主程序更新后保持两侧一致。
  - 全部源码注释移除（用户指令：代码中不写注释）。

- **v1.4.13** — npm 死锁快速熔断：npm 解析 dsh 超大依赖树可能**无任何输出地死锁**（本机必现，BUG 证据 7）。`runNpm`/`runNpmProgress` 现在连续 **120 秒无输出即 kill**（`ENPMDEADLOCK`），不再傻等 600 秒超时——主程序更新约 2 分钟就进入整树 tarball 回退，整体从 ~16 分钟缩短到 ~5 分钟。

- **v1.4.12** — 让主程序更新在 npm 卡死的机器上真正到达目标版本 + 重启可用性：
  - **tarball 回退改为整树更新**（不只 `@deepseek-ai/dsh` 主包）：v1.4.10 的回退只替换主包，导致安装后完整性校验（`verifyDeployTree`：所有 `dsh-*` 包必须 = 目标版本）**必然失败** → 回滚 → "更新完成但重启后还是旧版本"。现在回退会从 registry 直连下载主包**以及所有版本 ≠ 目标的 `dsh-*` 子包**的 tarball 覆盖到部署树（不经 npm 解析），逐包进度 + 失败清单（失败的包仍由完整性校验统一判定）。
  - **`/restart` 锁自动过期**：`restartScheduled` 在成功路径从不重置，第一次重启后所有后续重启都 409 "restart already scheduled"。现改为调度 180 秒后自动过期。
  - **设置页新增手动「重启服务」按钮**（显示与控制区）：更新流程本身不再调 `/restart`（v1.4.11 起由 worker 内部重启），这是显式、可观察的重启入口，也便于验证看门狗工作。

- **v1.4.11** — 修复「点更新后立即显示更新完成、重启后还是旧版本」、DSH Desktop（Electron）插件更新失败、横幅双检查门控：
  - **主程序更新不再提前重启**（[#9](https://github.com/Airmetro/dsh-update-checker/issues/9)，Airmetro 反馈）：`/update` 只是**启动**了独立 worker（停服务→安装→校验→重启→健康检查）。此前客户端把 `/update` 的 200 当作"更新完成"，立刻再调 `/restart`，与 worker 的安装并发（文件占用 → 安装失败回滚 → 服务以旧版本被拉起）——这就是"点更新→立即显示完成→手动重启后还是旧版本"的根因。现在横幅与设置页都轮询 `update-progress.json`，直到 worker 报 `phase=done/error` 才显示"更新完成"并刷新页面；重启由 worker 自己完成，不再需要单独的 restart 调用。
  - **DSH Desktop（Electron）插件更新修复**（[#8](https://github.com/Airmetro/dsh-update-checker/issues/8)）：所有 npm/pnpm 子进程原来都用 `process.execPath` 启动——Electron 下那是 electron.exe，npm 根本没运行（报 `WSALookupServiceBegin…10108` / "npm install produced no package"）。新增 `resolveNodeExe()` 定位真实 node（`DSH_UC_NODE_EXE` 覆盖 → `npm_node_execpath` → execPath 若确实是 node → 常见安装目录 → PATH），`getNpmCli()` 从真实 node 目录推导 npm-cli.js；主程序更新 worker 也改用真实 node 启动。
  - **横幅只在主程序与插件都检查完后显示**：主程序横幅与插件横幅现在都等**两个检查都完成**才显示（不再两段式弹出）。插件检查也改为并发（此前逐个 await）。
  - **设置页「显示与控制」立即渲染**：开关与下载源下拉框立即按默认值显示，不再等 `settings.json` 网络往返（此前 settings 为 null 时整个控制区是空的）。
  - `probeNpmGlobalRoot` 失败改为 60 秒冷却（npm -g 布局仍覆盖）。
  - 新增纯函数 `buildNodeExeCandidates()`（带单元测试）；测试 110 通过。

- **v1.4.10** — 主程序检查改为 npm + GitHub 双源比对（不再稳定版优先）：
  - **主程序（`@deepseek-ai/dsh`）目前没有稳定版**（全是 rc）。旧 `pickNpmLatest` 优先稳定版、全预发布时回退 `dist-tags.latest`，导致发布在 `next` 通道的 rc（如 `latest=0.1.0-rc.7` 而 `next=0.1.0-rc.8`）被隐藏。主程序检查改用 `pickMainLatest()`——直接取已发布**最高版本（含预发布）**。
  - **与插件一致的双源比对**：主程序检查同时查询 GitHub 仓库 release（deepseek-harness，tag 带 `dsh-v` 前缀如 `dsh-v0.1.0-rc.8`），取 npm / GitHub 中较高者；平局时按默认下载源设置决定（GitHub 默认 / npm / 智能）。注意不能用 `/releases/latest`（该端点只返回非预发布 release，而该仓库 release 全是预发布会 404），改用列表端点。
  - `/update` 路由安装的也是双源决策后的目标版本，"横幅显示什么就装什么"。
  - 新增纯函数 `pickMainLatest()`、`mainTagToVersion()`（带单元测试）；测试 104 通过。

- **v1.4.9** — 修复 npm -g 全局安装形态下部署根探测不到（[#7](https://github.com/Airmetro/dsh-update-checker/issues/7)）+ 新增默认下载源设置：
  - **部署根探测新增 npm 全局前缀候选**（`npm root -g` 输出的父目录，如 `<prefix>/lib/node_modules` → `<prefix>/lib`）：Linux 服务器用 `npm -g` 安装 dsh、web 服务由 systemd 托管时，原有两条探测路径都会落空（pnpm hoisted 布局下 profile 侧是独立目录而非 junction、工作目录是用户家目录），导致核心程序已装版本显示 `?`。探测为异步 + 缓存，失败静默跳过；提供 `DSH_UC_NPM_GLOBAL_ROOT` 测试钩子供集成测试模拟该布局。
  - **新增"默认下载源"设置**（设置页）：当 npm 与 GitHub **版本一致（平局）**时，可选择首选下载源——`GitHub（默认）` / `npm` / `智能选择（先 GitHub，失败再 npm）`。非平局仍按版本较高者。`smart` 模式下平局时 GitHub **任意失败**都回退 npm（不再局限于 `ENOBUILD` / `ETAGMISMATCH` / `ETOOBIG` / `EDOWNLOAD` 白名单），连不上 GitHub 的用户也能更新；非平局更新仍按版本较高者 + 错误码白名单，避免降级到较低版本。
  - 新增纯函数 `pickTargetSource()`（带单元测试）；新增 npm -g 布局集成测试。

- **v1.4.8** — GitHub 下载失败自动回退 npm：
  - GitHub codeload 下载失败（HTTP 5xx/429、网络错误、超时）或 tarball 损坏时，错误统一标记 `EDOWNLOAD`，插件在 npm 存在时**自动回退 npm 通道**（此前 `502` 无错误码会直接中止更新）。实测修复"本地 GitHub 代理对 codeload.github.com 返回 502（如 hosts 劫持的 S302 代理）导致插件更新报 GitHub download HTTP 502 失败"的场景。
  - 新增纯函数 `isGhFallbackable()`（带单元测试）；GitHub→npm 回退现覆盖 `ENOBUILD` / `ETAGMISMATCH` / `ETOOBIG` / `EDOWNLOAD`。

- **v1.4.7** — pnpm 探测增强（锁文件同步跨平台补全）：
  - `findPnpm` 新增 **npm 全局前缀推导**（由 `NPM_CLI` 反推全局 node_modules 根）与 **PATH 兜底**（`pnpm.cmd`/`pnpm`），Windows 上改用 `corepack.cmd`/`corepack.exe`——不再命中 cmd 无法执行的无扩展名 bash shim（`#!/bin/sh`）。实测修复 Windows 用户级 npm 前缀（如 `%APPDATA%\npm`）与 Linux 独立安装布局下 pnpm-lock.yaml 同步失败的缺口。
  - 新增纯函数 `pnpmCandidates()`（带单元测试）返回跨平台候选列表。

- **v1.4.6** — 修复「同一插件反复提醒更新、更新了几遍都不生效」的死循环：
  - **插件更新/回滚现在会持久化回 profile 清单 + 锁文件**：此前一键更新只替换 `node_modules/<插件>` 里的文件——profile 的 `package.json` 仍声明旧版本、`pnpm-lock.yaml`/`package-lock.json` 仍锁旧版本，于是下一次 `pnpm install`/`npm install`（或 profile 重装）会把插件悄悄拉回旧版，横幅又提示同一个更新，永远循环。现在更新（或回滚）成功后，会把新的依赖声明写回所有声明了该插件的 profile `package.json`，并用 `pnpm install --lockfile-only` / `npm install --package-lock-only` 同步锁文件（不动 node_modules、不触发 install 脚本）。spec 改写保持保守：`^0.12.3 → ^0.13.1`（保留前导操作符）、精确版本保持精确、复杂范围收敛为 npm 默认 `^新版`、`github:owner/repo` 钉到 release tag（`github:owner/repo#tag`）；无法推导的声明（`file:`/`workspace:`/别名）原样不动。回滚对称处理：更新前的旧 spec 记录在 `backup-info.json`，回滚时原样写回。
  - 持久化失败不会否决更新本身（插件文件已替换完成）；结果随 API 响应返回，并记入操作日志（`persistedManifest` / `persistedLock`）。
- **v1.4.5** — 设置页状态灯新增红灯档：
  - **红/黄/绿三态**：黄灯=有更新；绿灯=已是最新；**红灯=三种异常**——① 作者已删除库（两源都查不到）；② 作者回退版本（本机已装版本比 npm 与 GitHub 发布源都高）；③ 无法查询到发布源。悬停红灯可看到具体原因。
  - 插件横幅位置与主程序横幅恢复同位（`top:64px`），不再错开到下方。
- **v1.4.4** — 修复两个社区反馈的问题：
  - **monorepo 子包不再误报更新**（[#3](https://github.com/Airmetro/dsh-update-checker/issues/3)）：GitHub 源检查时，release tag 对应仓库根 `package.json` 的 `name` 必须与本地插件名一致才采信该 tag；主仓库 tag（monorepo 根包名 ≠ 子包名）视为与本插件无关，仅保留 npm 源，避免"黄灯常驻 → 点更新失败"的死循环（如 `@tt-a1i/archify-dsh`、`@vectorize-io/hindsight-coding-agents`）。`ghName` 获取失败（限流/网络）时保持原行为，不影响 GitHub-only 插件。
  - **横幅不再被会话顶栏/上下文注入遮挡**（[#5](https://github.com/Airmetro/dsh-update-checker/issues/5)）：`shell.overlay` 容器自身是低层 stacking context，子元素 `z-index` 再高也压不出容器；现把整个 overlay 层提升到顶栏/上下文注入（≤100）之上、全屏弹层（1000）之下，并将横幅初始位置下移避开顶栏区域。
- **v1.4.3** — 修复两个现场反馈的问题：
  - `NPM_CLI` 定位支持多种 node 前缀布局（含标准 Linux `<prefix>/lib/node_modules`），`readNpmMajor` 从解析到的 npm 位置读版本号——标准 Linux 布局下插件更新可用。
  - GitHub API 可选 token 认证（`GH_TOKEN` / `GITHUB_TOKEN` 环境变量，每台机器各自设置）：仅 `api.github.com` 带 `Authorization: Bearer`，匿名 60/h 限额提升到 5000/h；codeload 下载保持匿名。403 文案区分"限速"与"token 无效"。
- **v1.4.1** — 更新链路与备份管理完善：
  - 主程序更新不再超时/不再假成功：改用显式版本号（走缓存 ~1s，`@latest` 全量解析本机实测 ~145s），并加 `forceReifyMain`（改名目录强制重装）破解 npm 11 的 reify 快速路径跳过问题。
  - 主程序更新实时进度条（`update-progress.json`，分阶段显示），横幅与设置页都可见。
  - 插件更新 GitHub→npm 自动回退（GitHub 源为源码仓库 / tag 不符 / 下载超限时）。
  - 扫描按包名去重；横幅/设置页更新状态跨界面同步；「知道了」现在能真正关闭横幅。
  - 备份管理：备份文件夹可配置（原生 Windows 文件夹选择对话框 + 打开文件夹）、删除备份缓存按钮、旧位置自动迁移。
  - 操作日志写入 `$DSH_HOME/dsh-update-checker-ops.log`。
- **v1.4.0** — 缺陷清单全量修复：
  - GitHub 通道本机可用：对 GitHub 域使用专用 HTTPS 客户端（兼容自签名证书代理），codeload 解压前校验构建产物，GitHub 源插件解压后阶段安装依赖。
  - 插件依赖版本核对（范围不满足的依赖先备份再替换）；原生依赖构建（npm ≥ 12 自动补 `--allow-scripts` 白名单）。
  - 主程序更新安全闸：dry-run（不得有 remove）→ 备份（含旧版本号）→ 布局自适应安装 → 安装后回读校验 `installed==latest`。
  - 真回滚（`POST /rollback`、`POST /plugin-rollback`、`GET /backups.json`）+ 设置页回滚按钮。
  - 多位置扫描（兼容 pnpm hoisted、按 realpath 去重）；写路由回环校验；看门狗可靠化（argv 派生启动器 + HTTP 200 恢复探测）；变更说明 brief。
  - 低危项：超 1MB 返回 413、npm 通道全量 packument 稳定版优先、codeload 下载大小上限、头部注释版本号同步。
- **v1.3.2** — 修复 `runSync` 无法拷贝新增 `@deepseek-ai` 包（profile 侧缺目录导致 `realpath` 抛 ENOENT）；修复 `parseGhRepo` 截断含点号仓库名。新增集成测试（真实拷贝 + junction 两种部署布局，`npm test`：30 项断言 + host `apply()` 冒烟测试）。
- **v1.3.1** — 插件更新 GitHub 交叉检查：读取每个插件的 `repository` 并查询 `api.github.com/releases/latest`，与 npm 交叉验证（目标版本取较高者、平局时 GitHub 优先下载源），支持仅存在于 GitHub 的插件（codeload），设置页显示更新来源（`[GH]` / `[GH/npm]`）；GitHub 不可达时静默回退 npm；fetch 超时（查询 20s / 下载 120s）。
- **v1.3.0** — 新增「检查更新」设置页：状态灯、一键 + 逐插件更新（串行队列、实时进度）、重新检查按钮、横幅开关、统一"不再提示"（可重新启用）、可拖动横幅、插件更新锁带 10 分钟超时接管。
- **v1.2.3** — 插件横幅 UX 重构：逐插件更新准确的成功文案、部分更新后横幅保持可见、视口上限内滚动列表、批量更新实时进度、横幅可拖动。
- **v1.2.2** — 一键更新改为 `npm install -g @deepseek-ai/dsh@latest --allow-scripts`（npm 11），经 `process.execPath` + 内置 `npm-cli.js` 调用（不依赖 PATH）；修复此前非 `-g` 安装会清空无 `package.json` 的全局 `node_modules` 的问题。
- **v1.2.1** — README 新增 Features 章节（完整更新生命周期概览）。
- **v1.2.0** — 从插件自身安装位置自动检测所有路径（profile 目录、`$DSH_HOME`、组合文件、部署根、重启启动器）；合并原独立 `dsh-plugin-checker` 的插件更新能力。

## 开发

- `lib/index.js` — Host 半身：纯 ESM，仅依赖 Node 内置模块，无构建步骤；纯函数以命名 ESM 导出暴露，供单元测试。
- `lib/client.js` — Client 半身：纯 JS（`window.__ModuleLoader__`），仅依赖 `react`，无构建步骤。
- 测试：`npm test`（Node ≥ 20 内置测试运行器，无第三方依赖）。
- `scripts/restart-service.ps1` — 手动服务重启辅助脚本（需带 `-ExecutionPolicy Bypass` 运行）。

## 许可证

MIT
