# dsh-update-checker

[English](README.md) | 中文

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web GUI 的常驻 Cordis 插件：**自动检查 DeepSeek Harness 主程序与已安装第三方插件的新版本**（原独立的 `dsh-plugin-checker` 已在 v1.1.0 合并进来），向用户提示，并支持一键更新（带成功/失败反馈）。

## 功能特性

- **完整更新生命周期** — 检查、备份、更新、重启，一个插件全部完成。
- **主程序检查** — 对比已安装的 `@deepseek-ai/dsh` 与 npm 最新版（semver 感知，正确处理预发布版本）。
- **第三方插件检查** — 扫描已安装的非官方插件（组合行 + `dsh` 清单双源、布局无关），逐一与 npm 最新版对比。
- **界面内横幅** — 跟随 DSH 界面语言（zh/en），显示有更新 / 已是最新 / 检查失败三种状态，支持"不再提示"抑制标记。
- **安全的一键更新** — 安装前备份部署 lockfile + `@deepseek-ai` 版本清单，升级失败可回滚；插件更新在临时目录安装后拷贝（绝不触碰 `profiles/node_modules` 里无关的包）。
- **看门狗重启** — 通过脱离宿主进程的看门狗脚本重启 dsh web 服务（杀掉端口监听进程、重新拉起启动脚本、重试直到端口恢复）。
- **零配置可移植** — profile 目录 / `$DSH_HOME` / 组合文件均由插件自身安装位置推导；部署根通过 junction `realpath` 解析，带 `DSH_DEPLOY_ROOT` / `process.cwd()` 回退。任何机器无需改代码即可使用。

- **Host 半身**（`lib/index.js`）注册 HTTP 路由：
  - `GET /dsh-update-checker/status.json` — 从 npm registry 获取 `@deepseek-ai/dsh` 最新版、读取本地已装版本（部署目录的 `node_modules`）、按 semver 语义比较，返回 JSON 状态（含持久化的 `suppressUpToDate` 标记）。
  - `POST /dsh-update-checker/suppress` — 持久化"已是最新版本"横幅的"不再提示"标记（要求 `{ "confirm": true }`）。
  - `POST /dsh-update-checker/update` — **完整更新**：备份部署 lockfile + @deepseek-ai 版本清单，在部署根执行 `npm install @deepseek-ai/dsh@latest`，随后把有变化的 @deepseek-ai 包防御性同步进 `$DSH_HOME/profiles/node_modules`（junction 链接的包跳过——运行中的 Web 应用经链接解析）。要求 `{ "confirm": true }`；支持 `{ "dry": true }` 只预览不执行。
  - `POST /dsh-update-checker/restart` — 重启 dsh web 服务（spawn 一个 PowerShell 辅助进程杀掉端口监听并重新拉起 `<deploy-root>/start-dsh.cmd`；端口与启动器路径均在运行时推导）。要求 `{ "confirm": true }`。
  - `GET /dsh-update-checker/plugins.json` — 扫描已安装的第三方（非内置）插件（组合行 + `dsh` 字段双源、布局无关），与 npm 最新版比较（semver），返回更新状态。
  - `POST /dsh-update-checker/plugin-update` — 通过临时目录 `npm install` + 拷贝更新单个插件（绝不触碰 `profiles/node_modules` 其它包，junction 感知，先备份旧版）。要求 `{ "confirm": true, "name" }`。
- **Client 半身**（`lib/client.js`）是一个 web 模块（ModuleLoader 格式），在根级 `shell.overlay` 插槽注册两个单元：
  - **主程序横幅**（顶部）：主程序的 有更新 / 已是最新 / 失败 三种状态（立即更新 / 重新检查 / 知道了；"不再提示"持久化抑制标记），
  - **插件横幅**（下方错开）：列出可更新插件（`installed → latest`），支持单个更新 / 全部更新按钮与逐条成功/失败反馈。
  页面加载时各检查一次，之后每 6 小时复查。

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
- **一键更新与重启目前针对开发时的布局调优：**
  - **仅 Windows** — 重启流程 spawn PowerShell（`taskkill` + `.cmd`/`.bat` 启动脚本），看门狗脚本是 PowerShell。
  - **npm 全局安装** — 主程序更新执行 `npm install -g @deepseek-ai/dsh@latest`（带原生依赖包的 `--allow-scripts`）。在 `@deepseek-ai/dsh` 为全局安装的环境（本插件开发时的部署形态）下这是正确命令。在 dsh 位于本地 `node_modules`（非 `-g`）的部署中，更新命令需要适配——**绝不能**在部署根执行普通 `npm install`，因为 npm 可能把现有包判为 extraneous 并清空。
- 其它平台/布局下横幅与版本检查仍可用，但更新/重启按钮会失败或需要改代码。Linux/macOS 支持是自然的下一步。

## 说明

- **Host 代码改动需要重启服务才生效**（加载器缓存已导入的模块）；client 代码改动由 client-modules HMR 监视拾取，下次刷新页面即生效。
- update/restart/suppress POST 路由均由 `{ "confirm": true }` 守护，防止误触发的请求触发安装或重启。
- 更新安全：`npm install` 执行前会向 `$DSH_HOME/dsh-update-checker-backups/<timestamp>/` 写入备份（部署 `package-lock.json` + 两份 @deepseek-ai 版本清单），升级失败可回滚。

## 更新日志

- **v1.3.2** — 修复 `runSync` 无法拷贝新增 `@deepseek-ai` 包的问题（profile 侧缺失目录导致 `realpath` 抛 ENOENT 而中止同步）；修复 `parseGhRepo` 截断含点号仓库名的问题。新增集成测试：在临时目录模拟「真实拷贝」与「junction」两种部署布局（经 `DSH_UC_PROFILE_NODE_MODULES` 钩子），覆盖生态版本读取、同步计划、同步执行、备份与部署根检测；`npm test` 一键运行（30 项断言 + host `apply()` 冒烟测试）。
- **v1.3.1** — 插件更新的 GitHub 交叉检查：读取每个插件的 `repository` 字段并查询 `api.github.com/releases/latest`，与 npm 交叉验证（目标版本取两者中较高者，平局时 GitHub 优先作为下载源），支持仅存在于 GitHub 的插件（经 `codeload` tarball 下载、备份 + 替换），在设置页显示更新来源（`[GH]` / `[GH/npm]`）。GitHub 不可达时静默回退 npm；两个源都失败时报告合并错误（含超时）。新增 fetch 超时（查询 20s / 下载 120s）。
- **v1.3.0** — 新增"检查更新"设置页：主程序与各插件版本对比的黄/绿状态灯、页面内一键更新 + 逐插件更新（串行队列、实时进度 "1/N"、逐行实时刷新）、独立重新检查按钮、悬浮窗/横幅提示开关（样式化滑块）、统一"不再提示"（同时抑制两个横幅、可在设置页重新启用）、可拖动横幅、插件更新锁带 10 分钟超时接管（npm install 卡住时不再永久 409）。
- **v1.2.3** — 插件横幅 UX 重构：逐插件更新显示 "{name} updated to vX.Y.Z"（不再误报"全部最新"）；部分更新后横幅保持可见（仍列出剩余可更新插件而非消失）；长插件/结果列表在视口高度上限内滚动并带样式滚动条；批量更新显示实时进度 "Updating {name}… (6/15)"；全部完成后的确认会干净地收起横幅；两个横幅可按标题/空白区拖动。
- **v1.2.2** — 一键更新改为 `npm install -g @deepseek-ai/dsh@latest` 并带五个原生依赖包的 `--allow-scripts`（npm 11 要求），经 `process.execPath` + 内置 `npm-cli.js` 调用（不依赖 PATH）。修复了之前非 `-g` 的 `npm install` 在 dsh 全局安装（全局前缀无 `package.json`）的机器上会把整个全局 `node_modules` 判为 extraneous 并清空的问题。
- **v1.2.1** — README：新增 Features 章节（完整更新生命周期概览）。
- **v1.2.0** — 从插件自身安装位置自动检测所有路径（profile 目录、`$DSH_HOME`、组合文件、部署根、重启启动器）；合并原独立 `dsh-plugin-checker` 的插件更新能力。

## 开发

- `lib/index.js` — Host 半身：纯 ESM，仅依赖 Node 内置模块。无构建步骤。纯函数辅助（`parseVersion`、`compareVersions`、`tagToVersion`、`parseGhRepo`、`planSyncFromMaps`、`extractTarGzToDir`、`truncate`）以命名 ESM 导出暴露，供单元测试。
- `lib/client.js` — Client 半身：纯 JS，`window.__ModuleLoader__` 格式，仅依赖 `react`。无构建步骤。
- 单元测试：`npm test`（即 `node --test scripts/`，Node ≥ 20 内置测试运行器，无第三方依赖）。覆盖：semver 比较与 tag/repo 解析（`unit-semver.test.mjs`）、同步计划（`unit-sync.test.mjs`）、tar 解压含路径逃逸安全（`unit-tar.test.mjs`），以及 host `apply()` 冒烟测试。
- `scripts/test-host-apply.mjs` — 用假 ctx 驱动 `apply()` 的隔离测试（`npm test` 也会拾取它）。
- `scripts/restart-service.ps1` — 手动服务重启辅助脚本（需带 `-ExecutionPolicy Bypass` 运行）；传 `-Launcher`（或设置 `DSH_RESTART_LAUNCHER`）及可选的 `-Port/-WorkingDir/-Log`。

## 许可证

MIT
