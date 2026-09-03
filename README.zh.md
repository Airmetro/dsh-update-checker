# dsh-update-checker

[English](README.md) | 中文

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web GUI 的常驻 Cordis 插件：**自动检查 DeepSeek Harness 主程序与已安装第三方插件的新版本**（原独立的 `dsh-plugin-checker` 已在 v1.1.0 合并进来），向用户提示，并支持一键更新（带成功/失败反馈）。

## 功能特性

- **完整更新生命周期** — 检查、备份、更新、回滚、重启，一个插件全部完成。
- **主程序检查** — 对比已安装的 `@deepseek-ai/dsh` 与 npm 最新版（全量 packument、**稳定版优先**、semver 感知——除非开启 `allowPrerelease` 设置，否则不选 alpha/beta/rc 预发布版，绝不再自动把主框架升进非预期的预发布通道）。
- **第三方插件检查** — 扫描已安装的非官方插件（布局无关，支持 pnpm hoisted 的多位置 `node_modules`），逐一与 npm/GitHub 双源对比（目标版本取较高者）；无发布源的本地工具归入 `ignored`。同名插件多位置时**优先组合所属 profile 的副本**（其余记为 `copies` 供区分），可**逐个"不再提醒"排除**（`excludedPlugins`，设置页可一键恢复）。
- **GitHub 更新通道** — 对 GitHub 域使用专用 HTTPS 客户端（兼容本地自签名证书代理；npm registry 仍走严格校验），带重定向跟随、大小上限与超时；codeload tarball 解压前校验构建产物。
- **界面内横幅** — 跟随 DSH 界面语言（zh/en），显示有更新 / 已是最新 / 失败三种状态，支持"不再提示"；更新横幅展示**变更说明 brief**（vX→vY + 风险等级，有 GitHub release 正文时附更新要点）。
- **安全的一键更新** — 主程序：dry-run 守卫（计划内有 remove 即中止）→ 快照备份（版本清单 + `main-snapshot` 里的 `@deepseek-ai` 整树副本，供离线回滚）→ 布局自适应安装（原位或 `-g`）→ 安装后回读校验 `installed==latest`；插件：临时目录安装 + 拷贝、依赖版本核对、npm ≥ 12 自动补 `--allow-scripts` 构建原生依赖。**更新（与回滚）会持久化回 profile 的 `package.json` + 锁文件**（`pnpm install --lockfile-only` / `npm install --package-lock-only`），之后的 install 不会再把插件悄悄拉回旧版——不再出现「同一插件反复提醒更新」的死循环。
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
- `npm install` 前会向 `$DSH_HOME/dsh-update-checker-backups/<timestamp>/` 写入备份（部署 `package.json` + `package-lock.json` + 两份 @deepseek-ai 版本清单 + `backup-meta.json` + `main-snapshot` 里 `@deepseek-ai` 框架整树副本），主程序与插件都有对应回滚路由；主程序回滚在 `main-snapshot` 存在时直接从磁盘恢复，而不是从 registry 重新安装旧版本。

## 更新日志

- **v1.4.20** — 主程序更新健壮性：stale-lockfile 强制重装修复 + 前端 dist 校验改用 realpath（issue #14）：
  - **stale-lockfile 强制重装**：当目标版本已写入 `package-lock.json` / `node_modules/.package-lock.json`（上一次失败或部分更新的残留）而物理安装的 `@deepseek-ai` 树仍是旧版时，npm 的 reify 信任 lockfile 而跳过重装，导致更新以 `E_VERSION: update did not reach <target> (installed=<old>)` 告终并回滚——一个永恒的"假更新"循环。worker 现在检测到这种不一致（lockfile 声明版本 ≠ 物理版本，且物理 ≠ 目标）后，会在安装前删除这两个过期的 lockfile，强制 npm 重新解析并真正重装目标版本。
  - **前端 dist 校验改用 realpath**（#14）：安装后的完整性校验读取 `dsh-web-frontend/dist/index.html`；现在先通过 `realpath` 解析该目录（跟随 junction / pnpm-hoisted 布局），避免误判"已装好的前端"，仍读不到时也会报出实际尝试的路径——此前会以 `integrity check failed: dsh-web-frontend dist/index.html unreadable` 回滚。

- **v1.4.19** — 无稳定版时跟随预发布 + npx 缓存布局提示（#14）：
  - **无稳定版回退**：`pickMainLatest` 在没有任何稳定版时改为返回已发布最高版本（含预发布），不再返回 `null` 导致检查报「无稳定版；请开启 allowPrerelease」。目前主框架只有 `rc`/`alpha`，默认只跟稳定版的旧策略会让插件形同虚设。
  - **有稳定版仍稳定优先**：只要存在任一稳定版，仍优先最高稳定版、仅在开启 `allowPrerelease` 时才跟进预发布（保留 v1.4.17 的事故防护）。
  - **npx 缓存布局提示**（#14）：检测到部署根是 npm 的 `npx` 缓存路径（`.../_npx/...`）时，状态检查给出明确说明，主框架更新路由以 `E_NPX_CACHE` 拒绝并提示改用官方本地部署或 `npm i -g @deepseek-ai/dsh`，不再装到错误位置后于完整性校验才失败。


- **v1.4.18** — 修复 monorepo 子包误报更新（#13）+ 深色模式主按钮对比度（#11，采用 PR #12）：
  - **monorepo 子包识别**（#13）：`parseGhRepo` 在 npm `repository` 带 `directory`（如 `packages/dsh-weknora`）时返回 `null`，子包只按 npm 检查。此前把仓库根的最新 release tag（如 `v0.7.2`）当成更新目标，点更新后因根目录无 `package.json` 报 `ENOENT`。
  - **GitHub 归属 fail-safe**（#13）：`fetchGhPkgName` 区分「确认根目录无 `package.json`」（HTTP 404 → `hasRootPkg:false`，判为不属于）与「瞬时/未知错误」（`hasRootPkg:null`，仍采信），避免误伤真实仓库。
  - **Homebrew npm-cli 布局**（#13）：`getNpmCli` 增加 `../libexec/lib/node_modules/npm/bin/npm-cli.js` 候选，macOS Homebrew Node ≥ 22 能解析到 npm，插件更新走 npm 渠道可用。
  - **GitHub→npm 回退**（#13）：`isGhFallbackable` 纳入 `ENOENT`/`ENOPKG`，GitHub tarball 仍无根 `package.json` 时回退 npm 渠道并给出明确错误，不再硬失败。
  - **深色模式主按钮**（#11，采用 PR #12）：`.dsh-update-btn-primary` / `.dsh-plugin-btn-primary` 改用 `--dsw-alias-button-primary-fill` + `--dsw-alias-label-primary-foreground`，不再用 `--dsw-alias-brand-primary` + `color:#fff`，深色模式下不再是白底白字。


## 开发

- `lib/index.js` — Host 半身：纯 ESM，仅依赖 Node 内置模块，无构建步骤；纯函数以命名 ESM 导出暴露，供单元测试。
- `lib/client.js` — Client 半身：纯 JS（`window.__ModuleLoader__`），仅依赖 `react`，无构建步骤。
- 测试：`npm test`（Node ≥ 20 内置测试运行器，无第三方依赖）。
- `scripts/restart-service.ps1` — 手动服务重启辅助脚本（需带 `-ExecutionPolicy Bypass` 运行）。

## 许可证

MIT
