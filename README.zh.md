# dsh-update-checker

[English](README.md) | 中文

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web GUI 的常驻 Cordis 插件：**自动检查 DeepSeek Harness 主程序与已安装第三方插件的新版本**（原独立的 `dsh-plugin-checker` 已在 v1.1.0 合并进来），向用户提示，并支持一键更新（带成功/失败反馈）。

## 功能特性

- **完整更新生命周期** — 检查、备份、更新、回滚、重启，一个插件全部完成。
- **主程序检查** — 对比已安装的 `@deepseek-ai/dsh` 与 npm 最新版（全量 packument、稳定版优先、semver 感知——latest tag 指向 prerelease 也不会误报）。
- **第三方插件检查** — 扫描已安装的非官方插件（布局无关，支持 pnpm hoisted 的多位置 `node_modules`），逐一与 npm/GitHub 双源对比（目标版本取较高者）；无发布源的本地工具归入 `ignored`。
- **GitHub 更新通道** — 对 GitHub 域使用专用 HTTPS 客户端（兼容本地自签名证书代理；npm registry 仍走严格校验），带重定向跟随、大小上限与超时；codeload tarball 解压前校验构建产物。
- **界面内横幅** — 跟随 DSH 界面语言（zh/en），显示有更新 / 已是最新 / 失败三种状态，支持"不再提示"；更新横幅展示**变更说明 brief**（vX→vY + 风险等级，有 GitHub release 正文时附更新要点）。
- **安全的一键更新** — 主程序：dry-run 守卫（计划内有 remove 即中止）→ 备份 → 布局自适应安装（原位或 `-g`）→ 安装后回读校验 `installed==latest`；插件：临时目录安装 + 拷贝、依赖版本核对、npm ≥ 12 自动补 `--allow-scripts` 构建原生依赖。
- **真回滚** — 主程序 `POST /rollback`、插件 `POST /plugin-rollback`；`GET /backups.json` 列出两者备份。
- **看门狗重启** — 启动器从当前进程 argv 派生，杀 PID + 端口双保险，恢复确认升级为端口监听 + HTTP 200 探测（`GET /restart-status.json`）。
- **写操作安全** — 所有写路由除 `{ "confirm": true }` 外还要求回环来源（127.0.0.1/::1），局域网客户端无法远程触发更新/重启/回滚。
- **零配置可移植** — profile 目录 / `$DSH_HOME` / 组合文件 / 部署根均由插件自身安装位置自动推导，任何机器无需改代码。

### Host 与 Client

- **Host**（`lib/index.js`）— HTTP 路由：`status.json`（检查）、`suppress`、`update`（支持 `dry` 预览）、`rollback`、`backups.json`、`restart`、`restart-status.json`、`plugins.json`、`plugin-update`、`plugin-rollback`。
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
- **部署根** — 先 junction `realpath` 解析，再 `DSH_DEPLOY_ROOT`，最后 `process.cwd()`。
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
