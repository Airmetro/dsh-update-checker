# dsh-update-checker

[English](README.md) | 中文

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web GUI 的常驻 Cordis 插件：**自动检查 DeepSeek Harness 主程序与已安装第三方插件的新版本**（原独立的 `dsh-plugin-checker` 已在 v1.1.0 合并进来），向用户提示，并支持一键更新（带成功/失败反馈）。

## 功能特性

- **完整更新生命周期** — 检查、备份、更新、回滚、重启，一个插件全部完成。
- **主程序检查** — 对比已安装的 `@deepseek-ai/dsh` 与 npm 最新版（全量 packument，稳定版优先——latest tag 指向 prerelease 也不会误报；semver 感知，正确处理预发布版本）。
- **第三方插件检查** — 扫描已安装的非官方插件（组合行 + `dsh` 清单双源、布局无关、支持 pnpm hoisted 的多位置 `node_modules`），逐一与 npm/GitHub 双源对比（目标版本取较高者）。无发布源的本地工具（如 mcp-* 客户端）归入 `ignored`，不再刷"not on npm registry"噪音。
- **GitHub 更新通道（本机可用）** — 对 GitHub 域使用专用 HTTPS 客户端（`rejectUnauthorized:false` 仅限 github.com/githubusercontent.com 等域，兼容本地 S302 代理的自签名证书；npm registry 仍走严格校验），带重定向跟随、下载大小上限与超时；codeload tarball 解压前校验构建产物（`main`/`exports` 入口存在、tag 与 `package.json` 版本一致），杜绝把源码仓库覆盖到可运行插件上。
- **界面内横幅** — 跟随 DSH 界面语言（zh/en），显示有更新 / 已是最新 / 检查失败三种状态，支持"不再提示"抑制标记；更新横幅展示**变更说明 brief**（vX→vY + 风险等级：major/minor/patch/pre，有 GitHub release 正文时附更新要点）。
- **安全的一键更新** —
  - 主程序：**dry-run 守卫**（npm install --dry-run 计划内出现 remove 即中止，防止 prune 部署树/全局树）→ 备份（lockfile + 版本清单 + 记录旧版本号的 `backup-meta.json`）→ **布局自适应**安装（部署根有 `package.json` 的本地项目用原位 `npm install`，无 `package.json` 的全局安装用 `-g`）→ **安装后回读校验** `installed==latest`，装错/未到位返回失败而不是假成功 → 生态同步。
  - 插件：临时目录安装 + 拷贝（绝不触碰 `profiles/node_modules` 无关包），**依赖版本核对**（新 `package.json` 的 dependencies 范围不满足时替换并先备份旧依赖），npm ≥ 12 自动补 `--allow-scripts` 构建原生依赖（koffi/node-pty/sharp 等）。
- **真回滚** — 主程序：`POST /rollback` 按最新备份记录的旧版本重装（同样走 dry-run 守卫 + 生态同步 + 回读校验）；插件：`POST /plugin-rollback` 从 `.dsh-plugin-backups/<id>` 恢复旧目录。`GET /backups.json` 列出两者历史备份。
- **看门狗重启** — 启动器**从当前进程 argv 派生**（不再猜 `start-dsh.cmd` 文件名），杀 PID + 端口双保险，恢复确认升级为**端口监听 + HTTP 200 探测**（`/dsh-update-checker/status.json`），结果写入 JSON 供 `GET /restart-status.json` 读取——重启后能确认服务真的恢复。
- **写操作安全** — 所有写路由除 `{ "confirm": true }` 外还要求**回环来源**（`req.socket.remoteAddress` 为 127.0.0.1/::1），局域网内非浏览器客户端无法远程触发更新/重启/回滚（防 0.0.0.0 绑定场景）。
- **零配置可移植** — profile 目录 / `$DSH_HOME` / 组合文件均由插件自身安装位置推导；部署根通过 junction `realpath` 解析，带 `DSH_DEPLOY_ROOT` / `process.cwd()` 回退。任何机器无需改代码即可使用。

- **Host 半身**（`lib/index.js`）注册 HTTP 路由：
  - `GET /dsh-update-checker/status.json` — 从 npm registry 获取 `@deepseek-ai/dsh` 最新稳定版、读取本地已装版本（部署目录的 `node_modules`）、按 semver 语义比较，返回 JSON 状态（含持久化的 `suppressUpToDate` 标记与 `brief` 变更说明）。
  - `POST /dsh-update-checker/suppress` — 持久化"已是最新版本"横幅的"不再提示"标记（要求 `{ "confirm": true }`）。
  - `POST /dsh-update-checker/update` — **完整更新**：dry-run 守卫（计划内不得有 remove）→ 备份（lockfile + @deepseek-ai 版本清单 + 旧版本号）→ 布局自适应 `npm install`（本地项目原位 / 全局 `-g`）→ 安装后回读校验 `installed==latest` → 生态同步。要求 `{ "confirm": true }`；支持 `{ "dry": true }` 只预览不执行（含 dry-run 输出）。
  - `POST /dsh-update-checker/rollback` — **主程序回滚**：按最新备份记录的旧版本重装（同样 dry-run 守卫 + 同步 + 回读校验），回滚前先做现场快照。要求 `{ "confirm": true }`。
  - `GET /dsh-update-checker/backups.json` — 主程序与插件的历史备份清单（回滚入口数据）。
  - `POST /dsh-update-checker/restart` — 重启 dsh web 服务（启动器从当前进程 argv 派生，杀 PID + 端口双保险；独立孙进程跑 `restart-watchdog.ps1`，HTTP 恢复确认写结果 JSON）。要求 `{ "confirm": true }`。
  - `GET /dsh-update-checker/restart-status.json` — 最近一次重启看门狗的结果（服务是否恢复）。
  - `GET /dsh-update-checker/plugins.json` — 扫描已安装的第三方（非内置）插件（组合行 + `dsh` 字段双源、多位置 `node_modules` 支持 pnpm hoisted），与 npm/GitHub 双源比较（semver），返回更新状态与 `ignored` 清单（本地工具）。
  - `POST /dsh-update-checker/plugin-update` — 更新单个插件：临时目录 `npm install`（npm ≥ 12 自动补 `--allow-scripts` 构建原生依赖）+ 拷贝，**依赖版本核对**（范围不满足的依赖先备份再替换），GitHub 源走 codeload（构建产物校验 + 阶段安装依赖）。要求 `{ "confirm": true, "name" }`。
  - `POST /dsh-update-checker/plugin-rollback` — 从 `.dsh-plugin-backups/<id>` 恢复插件旧目录。要求 `{ "confirm": true, "id" }`。
- **Client 半身**（`lib/client.js`）是一个 web 模块（ModuleLoader 格式），在根级 `shell.overlay` 插槽注册两个单元：
  - **主程序横幅**（顶部）：主程序的 有更新 / 已是最新 / 失败 三种状态（立即更新 / 重新检查 / 知道了；"不再提示"持久化抑制标记；有更新时展示 `brief` 变更说明行：vX→vY + 风险等级 + 更新要点），
  - **插件横幅**（下方错开）：列出可更新插件（`installed → latest`），支持单个更新 / 全部更新按钮与逐条成功/失败反馈。
  页面加载时各检查一次，之后每 6 小时复查。设置页「检查更新」另提供**回滚按钮**（主程序与各插件，存在备份时显示）。

## 本地化

横幅通过 client 的 `locale` 服务（`@deepseek-ai/dsh-client-locale`）跟随 DSH 界面语言：**zh → 中文, en → English**，只内置这两种——其它语言环境回退到中文。在 DSH 设置（Settings → General → Language）切换语言会即时更新横幅文案，无需刷新页面。若组合中没有 locale 服务，client 回退到中文词典。

## 安装与装载

该包是一个 [profile bundle](https://github.com/deepseek-ai/deepseek-harness)（其清单声明了 `dsh.bundle.patch`）。

```bash
# 1) 把包放进 $DSH_HOME/profiles/node_modules/，让 profile 能解析到它。
#    ⚠️ 绝不要在 $DSH_HOME/profiles 目录里直接跑 `npm install`——该目录没有
#    package.json，npm 会把整个 node_modules 判为多余并清空（数据丢失）。
#
#    安全方式 A —— 临时目录安装后只拷贝本包：
npm i dsh-update-checker --prefix <temp-dir> --no-save
cp -r <temp-dir>/node_modules/dsh-update-checker $DSH_HOME/profiles/node_modules/
#
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

所有路径**运行时自动检测——没有任何硬编码**，同一包可在任何机器工作：

- **插件 / profile 目录**（`$DSH_HOME/profiles/node_modules`）：由插件自身安装位置（`import.meta.url`）向上走到最近的 `node_modules` 推导。无需配置。
- **`$DSH_HOME`**：推导为 `profiles` 根目录的父目录（状态文件、备份、重启日志都在这里）。
- **组合文件**（`cordis.patch.yml`）：默认 `$DSH_HOME/profiles/web/cordis.patch.yml`；不存在时使用 `$DSH_HOME/profiles/` 下其它包含本插件 id 的 `cordis.patch.yml`。
- **部署根**：按两种策略依次检测：
  1. **junction 解析** — 在 `profiles/node_modules/@deepseek-ai/dsh` 是 junction 的机器上（常见的"省 C 盘"方案），`realpath()` 得到 `<deploy-root>/node_modules/@deepseek-ai/dsh`，从而自动推导部署根。
  2. **候选回退** — 环境变量 `DSH_DEPLOY_ROOT`，然后是 `process.cwd()`（启动脚本通常会 `cd` 到部署目录）。要指定其它位置，设置 `DSH_DEPLOY_ROOT` 或在 `lib/index.js` 顶部追加 `DEPLOY_ROOT_CANDIDATES`。
- **重启启动器**：自适应——在检测到的部署根下探测常见名称（`start-dsh.cmd`、`启动 dsh.bat`、`start-dsh.bat`、…）；web 端口读取运行中的 `webServer.port`。重启流程没有硬编码任何机器特定路径。
- 持久化状态（抑制标记、备份）存放在检测到的 `$DSH_HOME` 下——与机器无关。

## 平台与安装布局支持

- **检测（检查类功能）** 与布局无关：路径由插件自身安装位置推导，可在任何机器工作（见"配置与可移植性"）。
- **一键更新与重启针对开发时的布局调优：**
  - **仅 Windows** — 重启流程 spawn PowerShell（`taskkill` + 派生启动/`.cmd` 启动脚本），看门狗脚本是 PowerShell。
  - **布局自适应主程序更新** — 部署根有 `package.json`（本地项目，如只声明 `@deepseek-ai/dsh` 依赖的 wrapper 部署）：原位 `npm install @deepseek-ai/dsh@latest`（`-g` 会装进全局前缀、对部署目录无效）；部署根无 `package.json`（npm 全局安装形态）：`npm install -g @deepseek-ai/dsh@latest`。两种形态都先过 dry-run 守卫（计划内不得出现 remove）并在安装后回读校验版本。npm ≥ 12 自动附加 `--allow-scripts` 白名单（npm 11 默认执行依赖脚本，无需该参数）。
  - **插件更新** — 临时目录安装 + 拷贝，兼容 npm 11/12+；GitHub 源插件在解压后进行构建产物校验并阶段安装其 dependencies。
- 其它平台/布局下横幅与版本检查仍可用，但更新/重启按钮会失败或需要改代码。Linux/macOS 支持是自然的下一步。

## 说明

- **Host 代码改动需要重启服务才生效**（加载器缓存已导入的模块）；client 代码改动由 client-modules HMR 监视拾取，下次刷新页面即生效。
- update/rollback/restart/suppress/settings 等写路由由 `{ "confirm": true }` **且回环来源**（127.0.0.1/::1）双重守护，防止误触发与局域网远程触发。
- 更新安全：`npm install` 执行前会向 `$DSH_HOME/dsh-update-checker-backups/<timestamp>/` 写入备份（部署 `package-lock.json` + 两份 @deepseek-ai 版本清单 + `backup-meta.json` 旧版本号），主程序与插件都有对应回滚路由。

## 更新日志

- **v1.4.1** — 更新链路与备份管理完善（本机实测验证）：
  - **主程序更新不再超时/不再假成功**：改用**显式版本号**（`@latest` 每次全量解析本机实测 145s 易超时；显式版本走缓存 ~1s）；破解 npm 11 的 **reify 快速路径跳过**问题（npm 会把 spec/隐藏 lockfile 先推进到目标、却不替换实际目录 → 回读校验必失败）：安装后回读不符时自动**改名目录强制重装**（`forceReifyMain`，实测 2s 完成）。
  - **主程序更新进度条**：`/update` 同步执行期间实时写进度状态文件（`update-progress.json`），npm 安装用 `--loglevel=http` 逐包计数（`已解析 x/420 个包`），分阶段（检查→dry-run→备份→安装→校验→同步→完成）；横幅与设置页都显示进度条。
  - **插件更新 GitHub→npm 回退**：GitHub 源为源码仓库（无构建产物 ENOBUILD / tag 不符 ETAGMISMATCH / 下载超限 ETOOBIG）且插件在 npm 上存在时，自动回退 npm 通道（dshmarket 实测更新成功）。
  - **扫描按包名去重**：同一插件出现在多个物理位置（顶层 + pnpm hoisted 子层）只列一条。
  - **更新状态跨界面同步**：横幅/设置页共享"更新中"状态（模块级订阅），关闭设置再打开不丢、互相同步。
  - **主程序横幅"知道了"可关闭**：有新版时点"知道了"本轮横幅直接关闭（此前有更新时 dismissed 被忽略导致点了没反应）。
  - **备份管理**：设置页新增"恢复与备份"卡片——备份文件夹**可配置**（默认 `$DSH_HOME/dsh-update-checker-backups`，插件备份统一存 `<root>/plugins`，旧位置自动迁移）；**Windows 原生文件夹选择对话框**（TopMost + 任务栏，不被其它窗口盖住）+ **打开文件夹**按钮；**删除备份文件缓存**按钮（确认后删除全部备份，回滚按钮随之消失；手动删单个插件备份则仅该插件的回滚按钮消失）。
  - **操作日志落盘**：update/rollback/plugin-update/restart 等关键节点与 npm 输出写入 `$DSH_HOME/dsh-update-checker-ops.log`（报错可追溯）。
- **v1.4.0** — 缺陷清单全量修复：
  - **GitHub 通道本机可用**（R31）：对 GitHub 域使用专用 HTTPS 客户端（`rejectUnauthorized:false` 仅限 github.com / *.githubusercontent.com，兼容本地 S302 代理自签名证书），带重定向跟随、下载大小上限与超时；codeload 解压前校验构建产物（`main`/`exports` 入口存在、tag 与 `package.json` 版本一致），杜绝源码仓库覆盖可运行插件；GitHub 源插件在解压后阶段安装其 dependencies（依赖同样做版本核对与原生构建）。
  - **插件依赖版本核对**：新 `package.json` 的 dependencies/optionalDependencies 中，已装版本不满足范围时先备份旧依赖再替换（`satisfies` 自带与 npm semver 一致的子集实现，1110 例交叉校验 0 偏差）。
  - **原生依赖构建**：npm ≥ 12 自动二次安装 + `--allow-scripts` 白名单（npm 11 默认执行依赖脚本，实测无需参数）。
  - **主程序更新安全闸**：dry-run 守卫（计划内不得出现 remove）→ 备份（含旧版本号）→ **布局自适应**（本地项目原位 `npm install` / 全局 `-g`）→ **安装后回读校验** `installed==latest`（不再恒定返回成功）。
  - **真回滚**：`POST /rollback`（主程序，按备份记录重装 + 同步 + 校验）、`POST /plugin-rollback`（插件，从 `.dsh-plugin-backups/<id>` 恢复）、`GET /backups.json`；设置页显示回滚按钮。
  - **扫描多位置**：`profiles/node_modules` + `profiles/*/node_modules`（pnpm hoisted 布局兼容），按 realpath 去重；无发布源的本地工具归入 `ignored`，不再刷"not on npm registry"噪音。
  - **写路由回环校验**：update/rollback/restart/plugin-update/plugin-rollback/suppress/settings 要求来源为 127.0.0.1/::1。
  - **看门狗可靠化**：启动器从当前进程 argv 派生（不再猜文件名），杀 PID + 端口双保险，恢复确认升级为 HTTP 200 探测，结果写入 JSON 供 `GET /restart-status.json`。
  - **变更说明 brief**：主程序与插件检查结果带 `brief`（vX→vY + 风险等级 + GitHub release 正文），横幅展示。
  - **低危项**：readJsonBody 超 1MB 返回 413（不再静默截断）；npm 通道改用全量 packument 稳定版优先（latest tag 指向 prerelease 不误报）；codeload 下载大小上限；头部注释版本号同步；`npm test` 命令适配本机（glob 形式）。
- **v1.3.2** — 修复 `runSync` 无法拷贝新增 `@deepseek-ai` 包的问题（profile 侧缺失目录导致 `realpath` 抛 ENOENT 而中止同步）；修复 `parseGhRepo` 截断含点号仓库名的问题。新增集成测试：在临时目录模拟「真实拷贝」与「junction」两种部署布局（经 `DSH_UC_PROFILE_NODE_MODULES` 钩子），覆盖生态版本读取、同步计划、同步执行、备份与部署根检测；`npm test` 一键运行（30 项断言 + host `apply()` 冒烟测试）。
- **v1.3.1** — 插件更新的 GitHub 交叉检查：读取每个插件的 `repository` 字段并查询 `api.github.com/releases/latest`，与 npm 交叉验证（目标版本取两者中较高者，平局时 GitHub 优先作为下载源），支持仅存在于 GitHub 的插件（经 `codeload` tarball 下载、备份 + 替换），在设置页显示更新来源（`[GH]` / `[GH/npm]`）。GitHub 不可达时静默回退 npm；两个源都失败时报告合并错误（含超时）。新增 fetch 超时（查询 20s / 下载 120s）。
- **v1.3.0** — 新增"检查更新"设置页：主程序与各插件版本对比的黄/绿状态灯、页面内一键更新 + 逐插件更新（串行队列、实时进度 "1/N"、逐行实时刷新）、独立重新检查按钮、悬浮窗/横幅提示开关（样式化滑块）、统一"不再提示"（同时抑制两个横幅、可在设置页重新启用）、可拖动横幅、插件更新锁带 10 分钟超时接管（npm install 卡住时不再永久 409）。
- **v1.2.3** — 插件横幅 UX 重构：逐插件更新显示 "{name} updated to vX.Y.Z"（不再误报"全部最新"）；部分更新后横幅保持可见（仍列出剩余可更新插件而非消失）；长插件/结果列表在视口高度上限内滚动并带样式滚动条；批量更新显示实时进度 "Updating {name}… (6/15)"；全部完成后的确认会干净地收起横幅；两个横幅可按标题/空白区拖动。
- **v1.2.2** — 一键更新改为 `npm install -g @deepseek-ai/dsh@latest` 并带五个原生依赖包的 `--allow-scripts`（npm 11 要求），经 `process.execPath` + 内置 `npm-cli.js` 调用（不依赖 PATH）。修复了之前非 `-g` 的 `npm install` 在 dsh 全局安装（全局前缀无 `package.json`）的机器上会把整个全局 `node_modules` 判为 extraneous 并清空的问题。
- **v1.2.1** — README：新增 Features 章节（完整更新生命周期概览）。
- **v1.2.0** — 从插件自身安装位置自动检测所有路径（profile 目录、`$DSH_HOME`、组合文件、部署根、重启启动器）；合并原独立 `dsh-plugin-checker` 的插件更新能力。

## 开发

- `lib/index.js` — Host 半身：纯 ESM，仅依赖 Node 内置模块。无构建步骤。纯函数辅助（`parseVersion`、`compareVersions`、`satisfies`、`pickNpmLatest`、`deriveRisk`、`tagToVersion`、`parseGhRepo`、`planSyncFromMaps`、`planDepMerges`、`resolveEntryFile`、`extractTarGzToDir`、`truncate`、`isLoopback` 等）以命名 ESM 导出暴露，供单元测试。
- `lib/client.js` — Client 半身：纯 JS，`window.__ModuleLoader__` 格式，仅依赖 `react`。无构建步骤。
- 单元测试：`npm test`（即 `node --test "scripts/*.test.mjs"`，Node ≥ 20 内置测试运行器，无第三方依赖）。覆盖：semver 比较与 tag/repo 解析（`unit-semver.test.mjs`）、v1.4.0 新纯函数（`unit-v140.test.mjs`）、同步计划（`unit-sync.test.mjs`）、tar 解压含路径逃逸安全（`unit-tar.test.mjs`），以及 host `apply()` 冒烟测试。
- `scripts/test-host-apply.mjs` — 用假 ctx 驱动 `apply()` 的隔离测试（`npm test` 也会拾取它）。
- `scripts/restart-service.ps1` — 手动服务重启辅助脚本（需带 `-ExecutionPolicy Bypass` 运行）；传 `-Launcher`（或设置 `DSH_RESTART_LAUNCHER`）及可选的 `-Port/-WorkingDir/-Log`。

## 许可证

MIT
