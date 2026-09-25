# dsh-update-checker

[English](README.md) | 中文

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web GUI 的常驻 Cordis 插件：**自动检查 DeepSeek Harness 主程序与已安装第三方插件的新版本**（原独立的 `dsh-plugin-checker` 已在 v1.1.0 合并进来），向用户提示，并支持一键更新（带成功/失败反馈）。

## 功能特性

- **完整更新生命周期** — 检查、备份、更新、回滚、重启，一个插件全部完成。
- **主程序检查** — 对比已安装的 `@deepseek-ai/dsh` 与 npm 最新版（全量 packument、**稳定版优先**、semver 感知）。预发布版本只有在与当前部署**同频道**时才会安装——跨频道提升（如 `rc` → `alpha`）会以 `E_PRERELEASE` 拒绝，除非显式开启 `allowPrerelease`，因此绝不会把主框架升进非预期的预发布通道。
- **第三方插件检查** — 扫描已安装的非官方插件（布局无关，支持 pnpm hoisted 的多位置 `node_modules`），逐一与 npm/GitHub 双源对比（目标版本取较高者）；无发布源的本地工具归入 `ignored`。同名插件多位置时**优先组合所属 profile 的副本**（其余记为 `copies` 供区分），可**逐个"不再提醒"排除**（`excludedPlugins`，设置页可一键恢复）。
- **GitHub 更新通道** — 对 GitHub 域使用专用 HTTPS 客户端（兼容本地自签名证书代理；npm registry 仍走严格校验），带重定向跟随、大小上限与超时；codeload tarball 解压前校验构建产物。
- **界面内横幅** — 跟随 DSH 界面语言（zh/en），显示有更新 / 已是最新 / 失败三种状态，支持"不再提示"；更新横幅展示**变更说明 brief**（vX→vY + 风险等级，有 GitHub release 正文时附更新要点）。
- **安全的一键更新** — 主程序：dry-run 守卫（计划内有 remove 即中止）→ 快照备份（版本清单 + `main-snapshot` 里的 `@deepseek-ai` 整树副本，供离线回滚）→ 布局自适应安装（原位或 `-g`）→ 安装后回读校验 `installed==latest`；插件：临时目录安装 + 拷贝、依赖版本核对、npm ≥ 12 自动补 `--allow-scripts` 构建原生依赖。**更新（与回滚）会持久化回 profile 的 `package.json` + 锁文件**（`pnpm install --lockfile-only` / `npm install --package-lock-only`），之后的 install 不会再把插件悄悄拉回旧版——不再出现「同一插件反复提醒更新」的死循环。
- **真回滚** — 主程序 `POST /rollback`、插件 `POST /plugin-rollback`；`GET /backups.json` 列出两者备份。
- **看门狗重启** — 启动器从当前进程 argv 派生，杀 PID + 端口双保险；恢复确认 = 端口监听 + HTTP 200 探测（`GET /restart-status.json`）+ **从插件自身路由读回的实例 id**，"端口有人应答"不再被当成"新版本已经起来"。
- **写操作安全** — 所有写路由除 `{ "confirm": true }` 外还要求回环来源（127.0.0.1/::1），局域网客户端无法远程触发更新/重启/回滚。
- **零配置可移植** — profile 目录 / 组合文件 / 部署根由插件自身安装位置自动推导；状态、备份与日志遵循 `DSH_HOME`（再退回 `~/.dsh`）。任何机器无需改代码。
- **自挂载（适配 dsh `0.1.6-alpha.2`+）** — 该版本把 profile 默认解析模式由 `"link"` 改为 `"runtime"`，于是放在 `$DSH_HOME/profiles/node_modules` 的第三方插件不再被解析，启动在服务绑定端口之前就以 `ERR_MODULE_NOT_FOUND` 崩掉。插件现在会在启动时自行重建挂载（`ensurePluginMount`）：为每个 profile 的 `node_modules` 建一份指向真实包的 junction，并补上各 profile 判定归属所需的 `dependencies` 声明。幂等、绝不覆盖你刻意设置的规格、绝不删除无法证明是自己副本的目录；`mount.json` / `status.json` 可查看状态。

### Host 与 Client

- **Host**（`lib/index.js`）— HTTP 路由：`status.json`（检查）、`mount.json`（自挂载状态）、`suppress`、`update`（支持 `dry` 预览）、`rollback`、`backups.json`、`restart`、`restart-status.json`、`plugins.json`、`plugin-update`、`plugin-rollback`、`plugin-exclude`。
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

### dsh `0.1.6-alpha.2` 之后：profile 还必须有自己的一份链接

只做第 1 步**已经不够了**。`0.1.6-alpha.2` 把 profile 的默认模块解析模式从 `"link"` 改成
`"runtime"`，于是 `$DSH_HOME/profiles/node_modules` 变成 dsh **受管的共享目录**，被排除在
Node 原生解析之外——它现在只服务部署依赖闭包与被选中的 bundle 闭包（见
`@deepseek-ai/dsh-app-boot` 的 `PluginPackages` / `routeScoped`），而第三方插件两者都不属于。
结果就是 profile 里那句裸包名 `dsh-update-checker` 解析不到，启动在 Web 服务绑定端口之前就崩：

```
ERR_MODULE_NOT_FOUND: Cannot find package 'dsh-update-checker' imported from …\profiles\web\
```

（这条报错里的 importer 路径是 dsh **改写**过的，真实失败基准是 `$DSH_HOME/package.json`，
不要相信报错里的那个目录。）修法是两件事，缺一不可：

```powershell
# 2a) 给 profile 的 node_modules 建一份指向真实包的链接（junction，绝不能用副本）
New-Item -ItemType Junction `
  -Path   "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-update-checker" `
  -Target "$env:USERPROFILE\.dsh\profiles\node_modules\dsh-update-checker"

# 2b) 在 profile 清单里声明依赖
#     $DSH_HOME/profiles/web/package.json → "dependencies": { "dsh-update-checker": "^1.6.1" }
```

**必须是 junction 而不是副本**：链接的 realpath 必须仍落在 `…/profiles/node_modules/…`，
否则 `pickDshHome` 认不出 Harness home，插件的自我定位会漂移（连带把 `@deepseek-ai/*`
同步写到错误位置）。而依赖声明是 dsh 的 `readProfilePlugins` 与本插件自己的
`findDeclaringProfiles`/`persistPluginUpdate` 判定"这个插件归哪个 profile"的依据——缺了它，
插件会一直把自己报成"需要更新"。

**全新安装时第 2 步不是可选项。** 解析不到插件的 profile 会在 `composeProfile` 阶段就崩掉——
**在插件被加载之前**——所以插件内部任何代码都救不了那一次启动。安装时（或新增第二个 profile 时）
请手工执行 2a 与 2b，profile 即可起来。

**首次成功启动之后，挂载由插件自己维护。** 自 v1.6.0 起，它会在启动时、每次插件更新后、每次插件
回滚后重跑 `ensurePluginMount`：为每个 profile 创建或修复链接，为每个 harness profile 写入依赖
声明；幂等，绝不覆盖你刻意设置的 `link:`/`file:` 规格，也绝不删除无法证明是自己副本的目录。
因此后续的 dsh 升级、新加 profile（同一台机器）、链接丢失、版本变化都不必再手工编辑。
随时可用 `GET /dsh-update-checker/mount.json`（只读）查看状态，`status.json` 里也带 `mount` 字段；
`POST /dsh-update-checker/mount` 可强制复查（与其它写路由一样需要 `{ "confirm": true }` + 回环来源）。

然后让 patch HMR 生效（或重启 `dsh web`）并刷新页面。

> 图文安装步骤与常见问题：见 [docs/INSTALL.md](docs/INSTALL.md)。

## 配置与可移植性

所有路径**运行时自动检测——没有任何硬编码**：

- **插件 / profile 目录** — 由插件自身安装位置（`import.meta.url`）推导。
- **`$DSH_HOME`** — `profiles` 根目录的父目录（状态文件、备份、重启日志都在这里）。
- **组合文件** — 以**正在运行的 profile** 为准：`$DSH_PROFILE_DIR/cordis.patch.yml` → `profiles/$DSH_PROFILE/…` → 补丁里声明本插件的 profile → `$DSH_HOME/profiles/web/cordis.patch.yml`。（v1.6.3；此前无法判定时一律用 `web` 默认值，宿主跑在别的 profile 时会读错 `node_modules`——见 issue #31。）
- **部署根** — 先 junction `realpath` 解析，再 `DSH_DEPLOY_ROOT`，然后 `process.cwd()`，最后 **npm 全局前缀**（`npm root -g` 的父目录，v1.4.9 起支持 npm -g 全局安装形态）。
  - systemd / npm -g 逃生口：自动探测万一没命中你的布局时，把 `DSH_DEPLOY_ROOT` 设为包含 `node_modules/@deepseek-ai/dsh` 的目录（Linux 上通常是 `<npm prefix>/lib`）。
- **node / npm 可执行文件** — `resolveNodeExe()` 定位真实 node：`DSH_UC_NODE_EXE` 覆盖 → `npm_node_execpath` → `process.execPath`（若确实是 node）→ 常见安装目录 → PATH。这就是 DSH Desktop（Electron，`process.execPath` 是 electron.exe）能跑 npm 更新插件的原因；若你的桌面端把 node 打包在别处，设 `DSH_UC_NODE_EXE` 指向它即可。若你的 node 由 **mise / asdf / nvm** 管理、PATH 里只有版本管理器的 **shim**（如 `~/.local/share/mise/shims/node`），shim 目录旁并没有 npm；v1.4.22+ 会通过 `node -p process.execPath` 在 shim 后解析出真实二进制。如果仍失败（或想免去这次探测），把 `DSH_UC_NODE_EXE` 设为真实二进制，如 `mise which node` / `asdf which node`。v1.6.3 起 npm 搜索面更宽：node 旁、`node_modules_<major>`（Fedora/RHEL 的 `nodejs24-npm`）、`/usr/lib`、`/usr/local/lib`、`/opt/homebrew/lib`、`/usr/local/opt/npm/lib`、`$npm_config_prefix`，以及 `PATH` 上的每个 `npm` / `npm.cmd`（含 shim 背后的真实目标）。桌面端 App 若完全没有 npm，仍需自行安装（issue #32）。
- **重启启动器** — 自适应：`DSH_UC_LAUNCHER` / `DSH_RESTART_LAUNCHER`，其次部署根下的常见启动脚本名（`DeepSeek Harness.cmd`、`start-dsh.cmd` …）；选中的启动器**带可见窗口**拉起，重启后的服务因此有控制台（v1.6.3——此前的隐藏拉起留下占着端口的孤儿进程，还吞掉了访问地址）。web 端口读取运行中的 `webServer.port`。
- **调优环境变量** — `DSH_UC_UPDATE_PORT` 指定更新 worker 停止/启动/探测的端口（默认 `3080`）；`DSH_UC_RESTART_WINDOW_MS` 指定首次启动偏慢时继续观察的时长（默认 `150000`，观察期间进度记录持续刷新）。

## 平台与安装布局支持

- **检测（检查类功能）** — 布局无关，可在任何机器工作。
- **一键更新与重启** — 不再仅限 Windows：
  - **服务停止/启动探测**：Windows 用 `Get-NetTCPConnection` + `taskkill`，Linux/macOS 用 `ss -H -tlnp "sport = :<端口>"`（退化时 `lsof -tiTCP:<端口> -sTCP:LISTEN`）+ `SIGKILL`。端口始终显式指定，因此绝不会误匹配无关监听；POSIX 下只有当 `/proc/<pid>/cmdline` 读不到、或其中确实写着 node/dsh 时才杀死该 PID。
  - **POSIX 重启看护**为 `scripts/restart-watchdog.sh`，与 `scripts/restart-watchdog.ps1` 一一对应：环境变量相同（`DSH_RESTART_PORT`、`DSH_RESTART_PID`、`DSH_RESTART_NODE_FILE`、`DSH_RESTART_NODE_ARGS`（JSON 数组）、`DSH_RESTART_LAUNCHER`、`DSH_RESTART_WORKDIR`、`DSH_RESTART_LOG`、`DSH_RESTART_RESULT`），结果 JSON 也相同（`startedAt`、`port`、`pid`、`recovered`、`recoveredAt`、`attempts`、`error`）。重启顺序：node argv → `systemctl --user restart dsh-web.service` → 启动器路径（作为单个参数传入，带空格的路径不会被拆开）；三者皆无时明确报 `no launcher available`，而不是假装恢复成功。调用方式是 `sh <脚本>`，因此不依赖可执行位。
  - 主程序更新自适应：部署根有 `package.json` 时原位 `npm install`，否则 `npm install -g`；两种形态都先过 dry-run 守卫并在安装后回读校验版本。
  - 插件更新 — 临时目录安装 + 拷贝，兼容 npm 11/12+。
- **无法安全完成时**，`/update` 仍会返回 `501 E_PLATFORM_UNSUPPORTED`：只有 `ss` 或 `lsof` 存在时才能可靠地定位服务进程。装一个（`iproute2`、`lsof`）即可，或者停掉 DSH 手工更新。

## 说明

- **Host 代码改动需要重启服务才生效**（加载器缓存已导入模块）；client 改动由 HMR 拾取，下次刷新页面即生效。
- update/rollback/restart/suppress/settings 等写路由由 `{ "confirm": true }` **且回环来源**（127.0.0.1/::1）双重守护。
- `npm install` 前会向 `$DSH_HOME/dsh-update-checker-backups/<timestamp>/` 写入备份（部署 `package.json` + `package-lock.json` + 两份 @deepseek-ai 版本清单 + `backup-meta.json` + `main-snapshot` 里 `@deepseek-ai` 框架整树副本），主程序与插件都有对应回滚路由；主程序回滚在 `main-snapshot` 存在时直接从磁盘恢复，而不是从 registry 重新安装旧版本。

## 更新日志

- **v1.6.3** — 升级后重启看得见、进度条按包数走、npm 探测覆盖发行版布局（issue #30 #31 #32）：
  - **主程序升级后不再留下无控制台孤儿进程。** `startService()` 原以 `detached: true` + `stdio: "ignore"` + `windowsHide: true` 拉起服务——一个没有控制台的隐形实例：它活过更新 worker、继续占着 Web 端口，启动时打印的访问地址/token 随 stdout 一起丢弃；下次启动就会撞 `listen EADDRINUSE 127.0.0.1:3080`，并炸出一片「N required plugins did not activate」（`webserver` 是 required，整个插件图都组不起来）。现在重启优先走部署自带的启动器（`DSH_UC_LAUNCHER` / `DSH_RESTART_LAUNCHER` / `DeepSeek Harness.cmd` / `start-dsh.cmd` …）且**带可见窗口**；没有启动器时退回 `node … bin.js web`，同样可见，并在 ops 日志记下 `main-update-service-restart`。
  - **进度条改为「已下载包数 / 总包数」。** 不再用依赖树时间爬坡、也不数 npm 的 HTTP 行（含元数据，会跑到真实进度前面）。下载/安装期间百分比 = `round(已完成 / 总数 * 100)`：200 个包下到 100 个就是 50%，198 个就是 99%；详情写「已下载 137/273 个包（50%）」。总数取自 npm dry-run 的「added N packages」或 lockfile；tarball 回退路径按已下载 tarball 同样计算。进度条不再回退，100% 留给「已完成」。
  - **发行版布局与 shim 安装也能找到 npm（#30 #32）。** `npmCliCandidates()` 新增 `node_modules_<major>`（Fedora/RHEL 的 `nodejs24-npm`）、`/usr/lib`、`/usr/local/lib`、`/opt/homebrew/lib`、`/usr/local/opt/npm/lib` 与 `$npm_config_prefix`；`locateNpmCli()` 在放弃前会依次解析 `PATH` 上的每个 `npm`/`npm.cmd`（以及 shim 背后的真实目标），`ENPMCLI` 报错也列出搜索过的布局与 `DSH_UC_NODE_EXE` 逃生口。桌面端 App 若**完全没有** npm，插件更新仍无法进行——那需要安装 Node/npm 或等应用内 tarball 安装器（见 #32）。
  - **插件清单只读「正在运行的那个 profile」（#31）。** `findCompositionFile()` 以前在无法判定时默认 `profiles/web/cordis.patch.yml`，于是宿主跑在别的 profile（桌面端的 `desktop`）时，面板读的是**另一个** profile 的 `node_modules`——永远显示 `dshmarket 1.60.0 → 1.65.0`，而运行中的 profile 已经是 1.65.0。现在 composition 与其 `node_modules` 先按 `DSH_PROFILE_DIR` / `DSH_PROFILE` 解析，并校验它属于本安装的 profiles 根。
  - **测试**：`node --test "scripts/*.test.mjs"` 230 项全过，新增覆盖包数进度映射、npm fetch 解析、启动器选择与可见性、运行中 profile 解析、Fedora `node_modules_<major>` 布局；进度 E2E 时间线按新契约断言。

- **v1.6.2** — Linux/macOS 可用一键主程序更新；插件更新不再被 pnpm 重装打回（issue #27 #28 #29，PR #26）：
  - **POSIX 主程序更新（#29，取代 PR #19）**：更新 worker、服务停止/启动探测与重启路由不再假定 Windows PowerShell。worker 改为直接 `node <脚本>`（detached）拉起，并接上 `error` 监听——spawn 失败会释放更新锁、写入真实的 `error` 进度记录；此前这种失败是静默的，横幅会永远停在 8%。POSIX 下找端口进程用 `ss -H -tlnp "sport = :<端口>"`，退化时用 `lsof -tiTCP:<端口> -sTCP:LISTEN`，绝不扫描全部监听；只有 `/proc/<pid>/cmdline` 读不到或确实写着 node/dsh 时才杀该 PID，用 `SIGKILL` 取代 `taskkill`。`scripts/restart-watchdog.sh` 与 `restart-watchdog.ps1` 对齐（同样的环境变量、同样的结果 JSON），重启顺序为 node argv → `systemctl --user restart dsh-web.service` → 启动器路径（作为**单个**参数传入）。Windows 行为完全未变（`Get-NetTCPConnection`、`taskkill /T /F`、PowerShell `Start-Process`）。既没有 `ss` 也没有 `lsof` 的机器仍以 `501 E_PLATFORM_UNSUPPORTED` 快速失败。
  - **只有 peerDependencies 的插件能装了（#28）**：`buildStageInstallArgs`/`buildPluginInstallArgs` 追加 `--legacy-peer-deps`。暂存前缀是一棵用完就丢的树，插件的 peer 由 DSH 宿主机在运行时提供，所以这里不该去 registry 解析——那边 `*` 范围会落到一个并不存在的包上（`@deepseek-ai/dsh-compact`，`E404`），于是所有纯 peer 插件必然 `ERESOLVE` 失败。
  - **`PROFILES_ROOT` 支持"每个 profile 自带 node_modules"布局（#27、PR #26）**：`dirname(profileNodeModules)` 只在共用布局下才是 profiles 目录；对 `…/profiles/<名字>/node_modules` 它等于 profile 目录本身，于是 `findDeclaringProfiles()` 一个清单都找不到，版本从未写回 `package.json`，锁文件也不会推进（`persistedManifest:0`，而 `persistedLock:true` 不过是 `[].every(...)`）。此后任何一次 `pnpm add`/`pnpm install` 都会按这份陈旧锁文件重新 reify，把此前更新过的插件全部打回冻结版本。新增的 `pickProfilesRoot()` 同时支持两种布局，`pickDshHome()` 也随之修正，自定义 `DSH_HOME` 不会再退回 `~/.dsh`。

- **v1.6.1** — 在 v1.6.0 基础上做加固与"说实话"的修正：
  - **`GET /mount.json` 不再写盘。** 它原本在一个普通 GET 里调用 `ensurePluginMount()`——建 junction、
    `mkdir`、改写 `profiles/*/package.json`——却既无 `writeGate` 也无回环来源校验，与其它所有写路由
    不一致。现在它是只读的（返回最近一次结果；启动时的检查尚未完成则返回 `202`），真正的重挂载移到
    `POST /mount`，与其它写路由一样需要 `{ "confirm": true }` + 回环来源。
  - **插件更新后、插件回滚后都会重新校验挂载。** 此前只在启动时检查一次，于是换入新版本之后挂载状态
    要到下次 `dsh` 启动才被验证。现在 `finalizePluginInstall` 与 `rollbackPlugin` 都会重跑，并把结果
    作为 `mount` 一并返回。
  - **尊重写在 `devDependencies` 里的声明。** 原先声明步骤只读写 `dependencies`，而本包自己的
    `declaredSection` 是优先 `devDependencies` 的——于是把插件声明为 dev 依赖的 profile 会被塞进第二条
    重复声明。现在按 profile 实际所在的依赖段处理，并在报告里以 `section` 说明。
  - **harness profile 的判定放宽**：由 `pkg.dsh.profile` 改为 `pkg.dsh`，于是缺少该子对象但合法的清单
    也会被写入依赖声明，而不是只建链接（只建链接会让它一直把自己报成需要更新）。
  - **文档写明真实限制。** 自挂载逻辑运行在插件内部，也就是只在 profile 组合成功之后才会执行——因此它
    **无法**修复"首次启动就解析不到插件"那一次。全新安装（以及每新增一个 profile）**必须**手工建链接 +
    写声明；此后的维护才由插件自己负责。此前的措辞暗示"重启一次可自行修复"，而那恰恰是它修不了的情形。

## 开发

- `lib/index.js` — Host 半身：纯 ESM，仅依赖 Node 内置模块，无构建步骤；纯函数以命名 ESM 导出暴露，供单元测试。
- `lib/client.js` — Client 半身：纯 JS（`window.__ModuleLoader__`），仅依赖 `react`，无构建步骤。
- 测试：`npm test`（Node ≥ 20 内置测试运行器，无第三方依赖）。
- `scripts/restart-service.ps1` — 手动服务重启辅助脚本（需带 `-ExecutionPolicy Bypass` 运行）。

## 许可证

MIT
