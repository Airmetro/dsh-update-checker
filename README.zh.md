# dsh-update-checker

[English](README.md) | 中文

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web GUI 的常驻 Cordis 插件：**自动检查 DeepSeek Harness 主程序与已安装第三方插件的新版本**（原独立的 `dsh-plugin-checker` 已在 v1.1.0 合并进来），向用户提示，并支持一键更新（带成功/失败反馈）。

## 功能特性

- **完整更新生命周期** — 检查、备份、更新、回滚、重启，一个插件全部完成。
- **主程序检查** — 对比已安装的 `@deepseek-ai/dsh` 与 npm 最新版（全量 packument、**稳定版优先**、semver 感知）。预发布版本只有在与当前部署**同频道**时才会安装——跨频道提升（如 `rc` → `alpha`）会以 `E_PRERELEASE` 拒绝，除非显式开启 `allowPrerelease`，因此绝不会把主框架升进非预期的预发布通道。
- **第三方插件检查** — 扫描已安装的非官方插件（布局无关，支持 pnpm hoisted 的多位置 `node_modules`），逐一与 npm/GitHub 双源对比（目标版本取较高者）；无发布源的本地工具归入 `ignored`。同名插件多位置时**优先组合所属 profile 的副本**（其余记为 `copies` 供区分），可**逐个"不再提醒"排除**（`excludedPlugins`，设置页可一键恢复）。
- **GitHub 更新通道** — 对 GitHub 域使用专用 HTTPS 客户端（兼容本地自签名证书代理；npm registry 仍走严格校验），带重定向跟随、大小上限与超时；codeload tarball 解压前校验构建产物。
- **界面内横幅** — 跟随 DSH 界面语言（zh/en），显示有更新 / 已是最新 / 失败三种状态，支持"不再提示"；更新横幅展示**变更说明 brief**（vX→vY + 风险等级，有 GitHub release 正文时附更新要点）。
- **安全的一键更新** — 主程序：dry-run 守卫（只移除更新目标自身传递依赖时放行，只有移除部署根自己声明的包才中止；可用 `allowRemove` 显式覆盖）→ 快照备份（版本清单 + `main-snapshot` 里的 `@deepseek-ai` 整树副本，供离线回滚）→ 布局自适应安装（原位或 `-g`）→ 安装后回读校验 `installed==latest`；插件：临时目录安装 + 拷贝、依赖版本核对、npm ≥ 12 自动补 `--allow-scripts` 构建原生依赖、**降级保护**（GitHub 探测被限流时不再退回更旧的 npm 版本）与**免重命名的原地同步**（针对目录被运行中宿主占住的插件）。**更新（与回滚）会持久化回 profile 的 `package.json` + 锁文件**（`pnpm install --lockfile-only` / `npm install --package-lock-only`），之后的 install 不会再把插件悄悄拉回旧版——不再出现「同一插件反复提醒更新」的死循环。
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

- **插件 / profile 目录** — 由插件自身安装位置（`import.meta.url`）推导，并有两处回退：pnpm `isolated` 布局下插件真实路径位于 `node_modules/.pnpm/…`，会沿 `.pnpm` 回到 profile 自己的 `node_modules`；插件装在 `profiles` 树之外（npm 全局安装）时，优先用**正在运行的 profile**（`$DSH_PROFILE_DIR`、`profiles/$DSH_PROFILE`）。`DSH_UC_PROFILE_NODE_MODULES` 可完全覆盖该推导结果（v1.7.3，issue #40）。
- **`$DSH_HOME`** — `profiles` 根目录的父目录（状态文件、备份、重启日志都在这里）。
- **组合文件** — 以**正在运行的 profile** 为准：`$DSH_PROFILE_DIR/cordis.patch.yml` → `profiles/$DSH_PROFILE/…` → 补丁里声明本插件的 profile → `$DSH_HOME/profiles/web/cordis.patch.yml`。（v1.6.3；此前无法判定时一律用 `web` 默认值，宿主跑在别的 profile 时会读错 `node_modules`——见 issue #31。）
- **部署根** — 先 junction `realpath` 解析，再 `DSH_DEPLOY_ROOT`，然后 `process.cwd()`，最后 **npm 全局前缀**（`npm root -g` 的父目录，v1.4.9 起支持 npm -g 全局安装形态）。
  - systemd / npm -g 逃生口：自动探测万一没命中你的布局时，把 `DSH_DEPLOY_ROOT` 设为包含 `node_modules/@deepseek-ai/dsh` 的目录（Linux 上通常是 `<npm prefix>/lib`）。
- **node / npm 可执行文件** — `resolveNodeExe()` 定位真实 node：`DSH_UC_NODE_EXE` 覆盖 → `npm_node_execpath` → `process.execPath`（若确实是 node）→ 常见安装目录 → PATH。这就是 DSH Desktop（Electron，`process.execPath` 是 electron.exe）能跑 npm 更新插件的原因；若你的桌面端把 node 打包在别处，设 `DSH_UC_NODE_EXE` 指向它即可。若你的 node 由 **mise / asdf / nvm** 管理、PATH 里只有版本管理器的 **shim**（如 `~/.local/share/mise/shims/node`），shim 目录旁并没有 npm；v1.4.22+ 会通过 `node -p process.execPath` 在 shim 后解析出真实二进制。如果仍失败（或想免去这次探测），把 `DSH_UC_NODE_EXE` 设为真实二进制，如 `mise which node` / `asdf which node`。v1.6.3 起 npm 搜索面更宽：node 旁、`node_modules_<major>`（Fedora/RHEL 的 `nodejs24-npm`）、`/usr/lib`、`/usr/local/lib`、`/opt/homebrew/lib`、`/usr/local/opt/npm/lib`、`$npm_config_prefix`，以及 `PATH` 上的每个 `npm` / `npm.cmd`（含 shim 背后的真实目标）。桌面端 App 若完全没有 npm，插件更新会改用应用自带的 pnpm（v1.7.1+）；把调用包管理器这一步换成内置安装器仍属未做（issue #32）。
- **重启启动器** — 自适应：`DSH_UC_LAUNCHER` / `DSH_RESTART_LAUNCHER`，其次部署根下的常见启动脚本名（`DeepSeek Harness.cmd`、`start-dsh.cmd` …）；选中的启动器**带可见窗口**拉起，重启后的服务因此有控制台（v1.6.3——此前的隐藏拉起留下占着端口的孤儿进程，还吞掉了访问地址）。web 端口读取运行中的 `webServer.port`。
- **调优环境变量** — `DSH_UC_UPDATE_PORT` 指定更新 worker 停止/启动/探测的端口（默认 `3080`）；`DSH_UC_RESTART_WINDOW_MS` 指定首次启动偏慢时继续观察的时长（默认 `150000`，观察期间进度记录持续刷新）。

## 平台与安装布局支持

- **检测（检查类功能）** — 布局无关，可在任何机器工作。
- **一键更新与重启** — 不再仅限 Windows：
  - **服务停止/启动探测**：Windows 用 `Get-NetTCPConnection` + `taskkill`，Linux/macOS 用 `ss -H -tlnp "sport = :<端口>"`（退化时 `lsof -tiTCP:<端口> -sTCP:LISTEN`）+ `SIGKILL`。端口始终显式指定，因此绝不会误匹配无关监听；POSIX 下只有当 `/proc/<pid>/cmdline` 读不到、或其中确实写着 node/dsh 时才杀死该 PID。
  - **POSIX 重启看护**为 `scripts/restart-watchdog.sh`，与 `scripts/restart-watchdog.ps1` 一一对应：环境变量相同（`DSH_RESTART_PORT`、`DSH_RESTART_PID`、`DSH_RESTART_NODE_FILE`、`DSH_RESTART_NODE_ARGS`（JSON 数组）、`DSH_RESTART_LAUNCHER`、`DSH_RESTART_WORKDIR`、`DSH_RESTART_LOG`、`DSH_RESTART_RESULT`），结果 JSON 也相同（`startedAt`、`port`、`pid`、`recovered`、`recoveredAt`、`attempts`、`error`）。重启顺序：node argv → `systemctl --user restart dsh-web.service` → 启动器路径（作为单个参数传入，带空格的路径不会被拆开）；三者皆无时明确报 `no launcher available`，而不是假装恢复成功。调用方式是 `sh <脚本>`，因此不依赖可执行位。
  - 主程序更新自适应：部署根有 `package.json` 时原位 `npm install`，否则 `npm install -g`；两种形态都先过 dry-run 守卫并在安装后回读校验版本。
  - 插件更新 — 临时目录安装 + 拷贝，兼容 npm 11/12+。
- **profile 布局** — npm 风格的 `hoisted` 与 pnpm 默认的 `isolated` 两种布局都支持：符号链接/结点（junction）形式的插件条目在列取时会被跟随（更新替换的是 profile 里的条目，而不是存储区路径），`.pnpm` 本身永远不会被当成插件；`runtime` 块会报告 `profileLinker`（`isolated` / `hoisted` / `null`），isolated 布局下设置面板还会给出可见提示（v1.7.3，issue #40）。
- **无法安全完成时**，`/update` 仍会返回 `501 E_PLATFORM_UNSUPPORTED`：只有 `ss` 或 `lsof` 存在时才能可靠地定位服务进程。装一个（`iproute2`、`lsof`）即可，或者停掉 DSH 手工更新。

## 桌面端（Electron）支持

插件在运行期判断自己是被 `dsh web`（普通 Node）托管，还是被桌面端应用（Electron，`ELECTRON_RUN_AS_NODE=1`）托管，并把结果以 `platform` 与 `runtime` 块写进 `/dsh-update-checker/status.json` 与 `/dsh-update-checker/plugins.json`：

- **判定依据** — Electron 运行时（`process.versions.electron`）、`process.argv` 里的桌面端宿主入口（`…/dsh-desktop-host/lib/index.js`）、`process.resourcesPath`、以及已打包的 `app-update.yml`。`DSH_UC_FORCE_PLATFORM=desktop|web` 可强制覆盖；`DSH_UC_RESOURCES_DIR`、`DSH_UC_RUNTIME_DIR`、`DSH_UC_APP_VERSION`、`DSH_UC_FEED_URL` 供测试与非标准布局使用。
- **版本检查** — 桌面端内核随签名应用打包在 `resources/app.asar` 内，因此"已安装"读的是 `app.asar/package.json`（回退 `app.asar/dsh/package.json`），"最新"来自 Electron 自己用的那份更新源：`app-update.yml`（`provider` / `url` / `channel`，本机为 `nightly`）→ `<url>/<channel><平台后缀>.yml`——Windows 用 `<channel>.yml`、macOS 用 `<channel>-mac.yml`、Linux 用 `<channel>-linux.yml`（v1.7.2，issue #38）；平台名 404 时回退一次裸 `<channel>.yml`，并在 ops 日志记 `main-update-desktop-feed-fallback`。解析出的 `version`、`releaseDate`、安装包 URL 与 sha512 用于比对。桌面端的内核版本不再查 npm registry。
- **一键更新** — 桌面端由应用自身完成更新（下载 → 任务检查 → 安装 → 重启），所以横幅给出的是**打开更新窗口**：调用 `window.dshDesktop.updates.open()`（仅 `dsh-app://app` 文档可见的 preload 桥），并通过 `updates.subscribe()` 同步 Electron 的更新状态（`downloading` / `verifying` / `ready` / `installing`）。`POST /dsh-update-checker/update` 在桌面端返回 `409 E_DESKTOP_OWNED`（带 `action: "open-native-update"`），且**不写**进度文件与更新锁：插件绝不对 `app.asar` 做 npm 覆盖安装。web 侧（npm / tarball、备份、回滚、重启看护）行为完全不变。
- **回滚** — 返回 `409 E_DESKTOP_OWNED`：打包内核没有插件管辖的备份可还原；需要降级请从官方更新源重装对应版本的桌面端应用。
- **重启** — 返回 `409 E_DESKTOP_RESTART_MANUAL` 并附本地化指引。profile 与 Host 进程归 Electron 管理，插件不会去结束它；插件更新后请从托盘菜单「退出 DeepSeek Harness」再重新打开应用。
- **插件更新** — 行为不变，作用于正在运行的 profile（如 `profiles/desktop`）。桌面端上同步锁定文件优先使用应用自带的 pnpm（`resources/runtime/pnpm/bin/pnpm.mjs`，以 `Electron --expose-internals …` + `ELECTRON_RUN_AS_NODE=1` 启动，并把自带 `runtime/bin` 前置到 `PATH`）；若该调用失败则退回探测到的 pnpm。机器上完全没有 npm 时，暂存安装不再直接失败，而是改用自带 pnpm（`pnpm add <spec> --dir <tmp>` / `pnpm install --dir <root> --prod`，构建脚本走 `pnpm rebuild`）。npm 的 Node 解析仍可用 `DSH_UC_NODE_EXE` 覆盖。
- **设置面板** — 桌面端下会列出运行时来源、更新通道与更新源，隐藏仅对 npm 有意义的控件（预发布开关、默认下载源），并说明内核由应用自行更新。

## 说明

- **Host 代码改动需要重启服务才生效**（加载器缓存已导入模块）；client 改动由 HMR 拾取，下次刷新页面即生效。
- update/rollback/restart/suppress/settings 等写路由由 `{ "confirm": true }` **且回环来源**（127.0.0.1/::1）双重守护。
- `npm install` 前会向 `$DSH_HOME/dsh-update-checker-backups/<timestamp>/` 写入备份（部署 `package.json` + `package-lock.json` + 两份 @deepseek-ai 版本清单 + `backup-meta.json` + `main-snapshot` 里 `@deepseek-ai` 框架整树副本），主程序与插件都有对应回滚路由；主程序回滚在 `main-snapshot` 存在时直接从磁盘恢复，而不是从 registry 重新安装旧版本。

## 更新日志

- **v1.7.3** — pnpm `isolated` 布局的 profile 不会再只剩插件自己一条（issue #40）：
  - **扫描根跑到 pnpm 存储区去了。** pnpm 默认 `isolated` 链接方式下，Node 会把本插件解析成真实路径（`…/profiles/web/node_modules/.pnpm/dsh-update-checker@1.7.2_react@18.3.1/node_modules/dsh-update-checker/lib`），于是"向上找第一个 `node_modules`"命中的是**存储区内部**的目录，`PROFILE_NODE_MODULES` / `PROFILES_ROOT` / `$DSH_HOME` 随之全错——`plugins.json` 只剩插件自己一条，而 profile 里其实有 14 个。现在 `resolveProfileNodeModules()` 会沿 `.pnpm`（包括 pnpm 自带的 `.pnpm/node_modules`）退回 profile 自己的 `node_modules`；插件装在 `profiles` 树之外（npm 全局）时，改用**正在运行的 profile**（`$DSH_PROFILE_DIR`、`profiles/$DSH_PROFILE`），而不是 node 安装目录。`DSH_UC_PROFILE_NODE_MODULES` 仍然完全覆盖，并已补进上面的文档。
  - **符号链接条目被静默跳过。** `scanInstalledPlugins()` 用 `Dirent.isDirectory()` 过滤，而符号链接/结点该值是 `false`，所有 pnpm 安装的插件在读取 `package.json` 之前就被丢掉了。现在会跟随链接（`lstat` + `stat`），插件目录仍是 profile 里的条目（更新替换的就是它），并显式跳过 `.pnpm` / `.bin` / 插件自己的临时目录；`link:` 形式的依赖（从源码目录链接进来的插件，例如本地预设 bundle）会被标记为本地链接并记入 `ignored` 并附原因，而不是变成一条红色的“获取失败”。
  - **不再静默。** `runtime` 块新增 `profileLinker`（读 `node_modules/.modules.yaml`）并带 `profile-isolated-linker` 提示，设置面板会显示出来——某次 `pnpm-workspace.yaml` 丢掉 `nodeLinker: hoisted` 之后，profile 不会再有"只装了一个插件"这种假象。
  - **测试**：`node --test "scripts/*.test.mjs"` **323** 项全过，新增 `scripts/unit-isolated-linker.test.mjs`（Windows/POSIX 两种路径的存储区退回、`.pnpm/node_modules`、显式覆盖、npm 全局 → 运行中的 profile、`.modules.yaml` 解析）与 `scripts/integration-isolated-scan.test.mjs`——后者搭出真实的 isolated 布局（`.pnpm` 存储区 + 结点条目，被测插件**从存储区内部**导入），断言扫描根是 profile 的 `node_modules`、每个条目都按 profile 路径列出、存储区与真实目录插件版本正确、只有 `link:` 源码条目被标记为本地链接、`runtime.profileLinker` 为 `isolated`、hoisted 布局行为不变。1.7.2 的代码路径（`Dirent.isDirectory()` 过滤 + 不逃逸 `.pnpm`）正对应报告里的 `plugins: ["dsh-update-checker"]`；`scripts/integration-client-settings-linker.test.mjs` 经模块加载器渲染真实设置面板，断言 isolated 布局下提示出现、hoisted 布局与旧版无 runtime 块时不出现，并校验中英两份字典都带该文案。

- **v1.7.2** — 桌面端更新源文件名改为按平台取名，macOS 上的主程序检查恢复（issue #38）：
  - **`<channel>.yml` 只对 Windows 成立。** `desktopFeedUrl()` 只用通道名拼 electron-builder 的清单文件名，而 electron-builder 在 macOS 上写的是 `<channel>-mac.yml`、Linux 上是 `<channel>-linux.yml`——打包应用的 `app-update.yml` 给的是"按平台分的**目录**"，不是"按平台分的**文件名**"。于是 macOS 上插件请求 `…/feeds/mac-arm64/nightly.yml`（404），而该目录里真正存在的是 `…/feeds/mac-arm64/nightly-mac.yml`（200），导致 macOS 上**每一次**主程序检查都以 `status: "error"` / `desktop update feed HTTP 404` 收尾，设置页卡片显示 `latest: null`。对着线上更新源实测：`…/mac-arm64/nightly.yml` → 404、`…/mac-arm64/nightly-mac.yml` → 200、`…/win-x64/nightly.yml` → 200（Windows 仍是不带后缀的名字）、`…/win-x64/nightly-win.yml` → 404。
  - **文件名改由平台推导** —— `desktopFeedName(channel, platform)`（`darwin` → `-mac`、`linux` → `-linux`、其余平台不带后缀）驱动 `desktopFeedUrl(baseUrl, channel, platform)`；platform 与文件内其它平台辅助函数一样是可注入参数，任何平台的分支都能在任意机器上测。平台名 404 视为"文件名不匹配"，回退一次裸 `<channel>.yml`（其它状态码与网络错误照原样上报）；回退写入 ops 日志 `main-update-desktop-feed-fallback`，`status.json` 与设置页卡片显示的是**真正应答的那个 URL**。
  - **测试**：`node --test "scripts/*.test.mjs"` **306** 项全过，新增 `scripts/unit-desktop-feed-url.test.mjs`（各平台文件名与候选顺序、macOS 只读 `<channel>-mac.yml`、404 回退及其 ops 日志、Windows 单次请求、两个名字都失败时按主名字上报并带 `attempts`/`lastError`、500 不得回退、清单无 version、`DSH_UC_FEED_URL` 覆盖），`scripts/integration-desktop-host.test.mjs` 新增"真实 status.json 的第一次更新源请求必须是平台对应的文件名"断言。线上 macOS 更新源经真实代码路径读取：`version = 0.2.0-rc.2`、`feedUrl = …/feeds/mac-arm64/nightly-mac.yml`、下载地址 `…/bin/mac-arm64/deepseek-harness-0.2.0-rc.2-mac-arm64.zip`；同一份构建对 Windows 更新源仍请求 `…/feeds/win-x64/nightly.yml`。

- **v1.7.1** — 插件现在能分辨自己跑在哪种宿主上，并针对桌面端（Electron）应用做适配，同时保留 web 端行为：
  - **运行期平台判定。** `detectDesktopRuntime()` 依据 Electron 运行时、`process.argv` 里的 `dsh-desktop-host` 入口、`process.resourcesPath` 与已打包的 `app-update.yml` 判定宿主，所有状态响应新增 `platform` 与 `runtime` 块（`managedBy`、Electron 版本、应用根目录、resources/runtime 目录、更新源可用性、通道、更新源 URL）；测试可用 `DSH_UC_FORCE_PLATFORM` 强制覆盖。
  - **桌面端内核版本改由应用自己的更新源决定。** "已安装" = 打包应用版本（`app.asar/package.json`，回退 `app.asar/dsh/package.json`）；"最新" = 由 `app-update.yml`（generic provider，`nightly`）解析出的 `<url>/<channel>.yml`，用一个零依赖解析器读取（能处理更新源里 `url: >-` 这类折叠标量块）。web 侧不变（仍走 npm/GitHub），桌面端此前"`installed: null`"的错报随之消失。
  - **桌面端更新是"转交"，不是"代做"。** 桌面端 `POST /update` 返回 `409 E_DESKTOP_OWNED`，带 `action: "open-native-update"`、目标版本与通道，且既不写更新锁也不写进度记录——插件不能、也不该对签名应用内的 `app.asar` 做 npm 覆盖安装。`/rollback` 同理返回 `409`（打包内核没有插件管辖的备份）。
  - **桌面端重启按设计走手动。** `/restart` 返回 `409 E_DESKTOP_RESTART_MANUAL` 并给出指引，而不是杀掉由 Electron 监管的 Host（托盘菜单 →「退出 DeepSeek Harness」→ 重新打开）；设置面板在原来"重启服务"的位置显示同一份指引。
  - **桌面端包管理器。** 锁定文件同步优先使用应用自带的 pnpm（桌面端宿主 `argv[5]`，以 `Electron --expose-internals` + `ELECTRON_RUN_AS_NODE=1`、`DSH_DESKTOP_NODE_EXECUTABLE` 与自带 `runtime/bin` 前置 PATH 的方式启动），该调用失败时退回探测到的 pnpm；npm 维持原有解析逻辑，桌面端在找不到真实 Node 时用 Electron 可执行文件充当 Node。插件暂存安装仍优先用 npm，机器上没有 npm 时退回自带 pnpm（`pnpm add --dir` / `pnpm install --dir --prod`，构建脚本走 `pnpm rebuild`）。
  - **客户端识别。** 覆盖层会识别 `dsh-app://` 来源与 `window.dshDesktop.updates`：桌面端把**打开更新窗口**作为主按钮（绝不显示 npm 安装按钮），订阅 Electron 更新状态在横幅里显示下载/校验/安装进度；web 端的 npm 确认与更新流程保持不变。设置区会显示桌面端运行时、通道与更新源，隐藏预发布开关与下载源选择，插件更新结果提示"重启桌面端应用后生效"。
  - **挂载不再能把真实安装降级。** `ensurePluginMount()` 会把各 profile 里的插件副本换成指向"当前运行实例"的链接；此前它对"真实目录"是无条件替换的，于是某个 profile 里更新的真实副本（1.7.0）会被静默换成指向更旧共享副本（1.4.23）的链接。现在 `linkPackageIntoProfile()` 在替换真实目录前先比版本，目标更新即拒绝（`conflict: "downgrade"`，写进 mount 的 errors，磁盘不动）；相等或更新的源仍按原逻辑去重。
  - **测试**：`node --test "scripts/*.test.mjs"` **293** 项全过，新增 `scripts/unit-desktop-runtime.test.mjs`（web/Electron/argv/强制覆盖各情形的判定、真实 `app-update.yml` 与更新源文本的解析、更新源 URL 拼接、pnpm 暂存参数）、`scripts/integration-desktop-host.test.mjs`（本地 HTTP 更新源 + 真实路由处理器：桌面端状态与版本、`E_DESKTOP_OWNED` 且不产生锁/进度文件、重启指引、回滚拒绝、`plugins.json` 带平台字段）、`scripts/integration-client-desktop.test.mjs`（用假 React 经模块加载器渲染真实覆盖层组件：桌面端渲染原生动作、`downloading` 状态渲染 42% 进度、web 端仍 POST `/update`）与 `scripts/integration-mount-guard.test.mjs`（旧源对新真实副本 → 拒绝且目标不变；新源对旧副本 → 照常去重；预发布目标仍算更新）。另外 `scripts/test-client-apply.mjs` 里有一条对 worker 进度的陈旧断言，在未改动的 1.7.0 上就已经失败；现改为校验 worker 各里程碑百分比单调不减。

  - **已在真实环境验证** —— 本版本在真正的 Electron-as-node 进程内（`DeepSeek Harness.exe` 44.0.0 + 已安装应用的 `resources`）跑镜像 profile：**24/24** 项通过，包括从签名 `app.asar` 读出 `installed = 0.2.0-rc.2`、从 `https://download.deepseek.com/dsh-desk/feeds/win-x64/nightly.yml` 实时取到 `latest = 0.2.0-rc.2`、`channel = nightly`、`/update` → `409 E_DESKTOP_OWNED` 且不产生更新锁、进度记录或备份目录、`/restart` → `409 E_DESKTOP_RESTART_MANUAL` 并带指引、`/rollback` → `409`。同一份构建在普通 Node 进程里仍报 `platform: web`、`source: npm`，走原有 npm/部署树路径（9/9 项通过）。

## 开发

- `lib/index.js` — Host 半身：纯 ESM，仅依赖 Node 内置模块，无构建步骤；纯函数以命名 ESM 导出暴露，供单元测试。
- `lib/client.js` — Client 半身：纯 JS（`window.__ModuleLoader__`），仅依赖 `react`，无构建步骤。
- 测试：`npm test`（Node ≥ 20 内置测试运行器，无第三方依赖）。
- `scripts/restart-service.ps1` — 手动服务重启辅助脚本（需带 `-ExecutionPolicy Bypass` 运行）。

## 许可证

MIT

