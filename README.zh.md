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
- **node / npm 可执行文件** — `resolveNodeExe()` 定位真实 node：`DSH_UC_NODE_EXE` 覆盖 → `npm_node_execpath` → `process.execPath`（若确实是 node）→ 常见安装目录 → PATH。这就是 DSH Desktop（Electron，`process.execPath` 是 electron.exe）能跑 npm 更新插件的原因；若你的桌面端把 node 打包在别处，设 `DSH_UC_NODE_EXE` 指向它即可。若你的 node 由 **mise / asdf / nvm** 管理、PATH 里只有版本管理器的 **shim**（如 `~/.local/share/mise/shims/node`），shim 目录旁并没有 npm；v1.4.22+ 会通过 `node -p process.execPath` 在 shim 后解析出真实二进制。如果仍失败（或想免去这次探测），把 `DSH_UC_NODE_EXE` 设为真实二进制，如 `mise which node` / `asdf which node`。
- **重启启动器** — 自适应：在部署根下探测常见启动脚本名；web 端口读取运行中的 `webServer.port`。
- **调优环境变量** — `DSH_UC_UPDATE_PORT` 指定更新 worker 停止/启动/探测的端口（默认 `3080`）；`DSH_UC_RESTART_WINDOW_MS` 指定首次启动偏慢时继续观察的时长（默认 `150000`，观察期间进度记录持续刷新）。

## 平台与安装布局支持

- **检测（检查类功能）** — 布局无关，可在任何机器工作。
- **一键更新与重启** — 针对开发时的布局调优：
  - **仅 Windows** — 重启流程 spawn PowerShell。
  - 主程序更新自适应：部署根有 `package.json` 时原位 `npm install`，否则 `npm install -g`；两种形态都先过 dry-run 守卫并在安装后回读校验版本。
  - 插件更新 — 临时目录安装 + 拷贝，兼容 npm 11/12+。
- 其它平台/布局下横幅与版本检查仍可用。Linux/macOS 上主框架更新路由现在会立即以 `501 E_PLATFORM_UNSUPPORTED` 拒绝（该平台的安装/重启仍需改代码），而不是卡在 8% 并残留横幅；插件更新与回滚可用。完整 POSIX 支持是自然的下一步。

## 说明

- **Host 代码改动需要重启服务才生效**（加载器缓存已导入模块）；client 改动由 HMR 拾取，下次刷新页面即生效。
- update/rollback/restart/suppress/settings 等写路由由 `{ "confirm": true }` **且回环来源**（127.0.0.1/::1）双重守护。
- `npm install` 前会向 `$DSH_HOME/dsh-update-checker-backups/<timestamp>/` 写入备份（部署 `package.json` + `package-lock.json` + 两份 @deepseek-ai 版本清单 + `backup-meta.json` + `main-snapshot` 里 `@deepseek-ai` 框架整树副本），主程序与插件都有对应回滚路由；主程序回滚在 `main-snapshot` 存在时直接从磁盘恢复，而不是从 registry 重新安装旧版本。

## 更新日志

- **v1.4.23** — 主程序实时进度、残留更新状态自愈、插件安全替换（issue #17 #18 #20 #21 #25，PR #23 #24）：
  - **依赖树检查阶段有真实进度**（#18 及"6% → 64%"反馈）：此前下载阶段在整个 `npm install --dry-run`（数分钟）里一直停在 4–6%，然后直接跳到 64%。现在每个阶段都有单调递增的"爬坡"计时器，每秒重写一次进度记录（`phaseCreepPercent`，已导出并单测），npm/tarball 的真实计数只把下限往上抬。里程碑整体重排（`下载 10→55`、`停止服务 58`、`安装 62→78`、`校验 84→87`、`同步声明 88`、`重启 92→95`、`健康检查 96`、`等待恢复 97–98`、`完成 100`），任何阶段都不再瞬移；启动服务的 30 秒与重启观察期间同样持续刷新进度。
  - **重启改为"继续观察"而不是直接判失败**（#18）：安装、完整性校验、版本声明同步都成功之后，重启失败不再终止更新。worker 进入 `restart-pending` 状态持续刷新进度，重新探测端口并按需重新拉起启动器，最长等待 `DSH_UC_RESTART_WINDOW_MS`（默认 150000 毫秒），之后才以 `E_RESTART` 结束——记录里带 `installed`、`restartPending: true`，文案明确"安装本身已成功"。期间端口起来即判定成功。
  - **进度计数修正**（#18）：安装阶段不再用硬编码的 `587` 去除 npm 的 http 行计数；总数改为从真实 lockfile 读取（`countLockPackages`，未知时 `null`），`done` 按总数封顶，界面上不会再出现 `done > total`（如 1338/587）。横幅同时提示"关闭此页面不会中断更新"。
  - **前端需要认证不再被误判为服务坏了**（#18，实机场景）：健康检查原先要求 `GET /` 返回 200，于是在 `/` 返回 **401/403**（口令/令牌保护界面）的机器上，**每一次安装成功最后都以 `E_RESTART: update installed <version> but restart/health failed: GET / -> 401` 收尾**，而紧接着的崩溃自愈又把服务拉起来了——用户被告知"更新失败"，实际早已成功。健康判定现在抽成纯函数 `classifyHealthStatus`：200 → 继续做 dist/assets 全量校验；401/403/407 → 服务活着但前端受认证保护，判定更新成功并跳过资源扫描（记录 `main-update-health-auth-gated`）；超时、5xx 与其它 4xx 仍判失败。`E_RESTART` 文案也同时给出启动器错误与健康检查问题。
  - **残留进度/状态自愈**（#25）：修掉 `writeProgress` 里被缓存记录覆盖 `at` 时间戳的问题——`at` 会永远停在下发第一次写入的时刻，这正是"更新中断后看起来仍是更新中"或"正在跑的更新看起来过期"的根因。进度记录现在写入属主 `workerPid`/`hostPid`；`isStaleProgress` 在属主进程已消失时判为陈旧（无 pid 时按 10 分钟无更新判定），Host 在启动时与读取时把它改写成 `running:false` + `phase:error` + `code:E_INTERRUPTED` 并释放更新锁。陈旧锁不再阻塞新更新 10 分钟：超过 2 分钟拉起宽限期且无存活 worker 的锁会被丢弃。
  - **worker 崩溃不再留下 `running:true`**（#25）：`uncaughtException`/`unhandledRejection` 与 `main()` 的致命异常都会写入一条 `error` 进度并释放锁，此前进程直接消失。`startService`/`taskkill` 的 spawn 补上 `error` 监听（POSIX 的 `ENOENT`、批处理文件的 `EINVAL` 以前会变成未处理的 error 事件、把 worker 打断在更新中途），拉起失败也改为快速失败而不是干等 30 秒。
  - **插件替换改为"先暂存后交换"**（#21）：`backupAndReplace` 先把新内容拷到目标旁的 `.dsh-uc-staging-*`，再把旧目录改名为 `.dsh-uc-trash-*`，然后把暂存树改名就位，最后尽力删除回收站。此前"先删后拷"在 Windows 上遇到运行中宿主映射的原生模块（如 `better_sqlite3.node`）会在**已经删掉全部文件之后**才报 `EPERM`，把插件掏成只剩那个被占用文件（连 `package.json` 都没了）、并连带拖垮宿主。现在交换前任何失败都不会动已装包，被占用的回收站留待下次更新清理。"不再提示"两个按钮也不再互相写对方的开关。
  - **瞬时请求失败不再触发整页刷新**（#20）：client 的 1.5 秒状态探针把任何一次失败请求（LLM 流式输出、工具执行、代理抖动）都当成"服务重启过"，下一次成功就无条件 `location.reload()`，导致对话过程中整页刷新。现在改为由服务端 `instanceId` 驱动：只有实例真的变化才刷新，且同一实例最多刷新一次（`sessionStorage` 守护），瞬时失败被完全忽略。
  - **locale 服务时序修复**（#22/#23）：client 半身改为等待 `locale` 服务（`ctx.inject(["slots", "locale"])`）后再注册字典与插槽绑定，不再在 apply 时读 `ctx.get("locale")` 静默退化为 `fallbackT()`（永远中文），英文界面下不再显示中文。
  - **POSIX 主程序更新快速失败**（#24）：Linux/macOS 上主框架 `/update` 路由在创建锁、备份、拉起 Windows 专用 PowerShell 之前就返回 `501 E_PLATFORM_UNSUPPORTED`，不再卡在 8% 并残留横幅。完整 POSIX 支持仍待上游 PR #19。

- **v1.4.22** — 版本管理器 shim 解析（issue #17）：
  - `resolveNodeExe()` 通过 shim 执行 `node -p process.execPath` 反查真实 Node，`getNpmCli()` 不再回退到不存在的路径，而是抛出带 `DSH_UC_NODE_EXE` 提示的 `ENPMCLI`，避免 npm 阶段出现 `MODULE_NOT_FOUND`。

- **v1.4.21** — 跨 npm -g 嵌套布局的主程序更新（#16）+ 外部守护进程 / 文件占用恢复（#15）+ 错误部署根提前拦截（#14）：
  - **npm -g 嵌套布局校验**（#16）：`verifyTree`/`verifyDeployTree` 现在按真实位置定位 `dsh-web-frontend`——顶层或嵌套在 `dsh/node_modules/@deepseek-ai`——而不再只看顶层，全局安装不再以 `integrity check failed: dsh-web-frontend dist/index.html unreadable` 回滚。
  - **外部守护 / EBUSY 恢复**（#15）：停止服务后重新探测端口并补杀可能被外部看护进程拉起的监听者；每次安装前都确保服务已停；安装遇到文件占用（`EBUSY`/`EPERM`/…）或端口被重新占用时最多重试 3 次而不是静默死亡，并始终把 `running:false` + 错误写入进度，让网页端能看到失败原因。
  - **错误部署根提前拦截**（#14）：更新路由在动手前先校验解析出的部署根确实包含 `dsh-web-frontend`（顶层或嵌套），否则以 `E_LAYOUT` 快速失败，而不是装到错误位置后再回滚。
  - **stale-lockfile 检测加固**：`readLockedDshVersion` 同时检查 `node_modules/.package-lock.json`，并把重置逻辑抽成可单测单元，确保"lockfile 声明了目标但物理树滞后"的错位被可靠清除。

- **v1.4.20** — 主程序更新健壮性：stale-lockfile 强制重装修复 + 前端 dist 校验改用 realpath（issue #14）：
  - **stale-lockfile 强制重装**：当目标版本已写入 `package-lock.json` / `node_modules/.package-lock.json`（上一次失败或部分更新的残留）而物理安装的 `@deepseek-ai` 树仍是旧版时，npm 的 reify 信任 lockfile 而跳过重装，导致更新以 `E_VERSION: update did not reach <target> (installed=<old>)` 告终并回滚——一个永恒的"假更新"循环。worker 现在检测到这种不一致（lockfile 声明版本 ≠ 物理版本，且物理 ≠ 目标）后，会在安装前删除这两个过期的 lockfile，强制 npm 重新解析并真正重装目标版本。
  - **前端 dist 校验改用 realpath**（#14）：安装后的完整性校验读取 `dsh-web-frontend/dist/index.html`；现在先通过 `realpath` 解析该目录（跟随 junction / pnpm-hoisted 布局），避免误判"已装好的前端"，仍读不到时也会报出实际尝试的路径——此前会以 `integrity check failed: dsh-web-frontend dist/index.html unreadable` 回滚。

- **v1.4.19** — 无稳定版时跟随预发布 + npx 缓存布局提示（#14）：
  - **无稳定版回退**：`pickMainLatest` 在没有任何稳定版时改为返回已发布最高版本（含预发布），不再返回 `null` 导致检查报「无稳定版；请开启 allowPrerelease」。目前主框架只有 `rc`/`alpha`，默认只跟稳定版的旧策略会让插件形同虚设。
  - **有稳定版仍稳定优先**：只要存在任一稳定版，仍优先最高稳定版、仅在开启 `allowPrerelease` 时才跟进预发布（保留 v1.4.17 的事故防护）。
  - **npx 缓存布局提示**（#14）：检测到部署根是 npm 的 `npx` 缓存路径（`.../_npx/...`）时，状态检查给出明确说明，主框架更新路由以 `E_NPX_CACHE` 拒绝并提示改用官方本地部署或 `npm i -g @deepseek-ai/dsh`，不再装到错误位置后于完整性校验才失败。

## 开发

- `lib/index.js` — Host 半身：纯 ESM，仅依赖 Node 内置模块，无构建步骤；纯函数以命名 ESM 导出暴露，供单元测试。
- `lib/client.js` — Client 半身：纯 JS（`window.__ModuleLoader__`），仅依赖 `react`，无构建步骤。
- 测试：`npm test`（Node ≥ 20 内置测试运行器，无第三方依赖）。
- `scripts/restart-service.ps1` — 手动服务重启辅助脚本（需带 `-ExecutionPolicy Bypass` 运行）。

## 许可证

MIT
