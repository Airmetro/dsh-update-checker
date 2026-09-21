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
#     $DSH_HOME/profiles/web/package.json → "dependencies": { "dsh-update-checker": "^1.6.0" }
```

**必须是 junction 而不是副本**：链接的 realpath 必须仍落在 `…/profiles/node_modules/…`，
否则 `pickDshHome` 认不出 Harness home，插件的自我定位会漂移（连带把 `@deepseek-ai/*`
同步写到错误位置）。而依赖声明是 dsh 的 `readProfilePlugins` 与本插件自己的
`findDeclaringProfiles`/`persistPluginUpdate` 判定"这个插件归哪个 profile"的依据——缺了它，
插件会一直把自己报成"需要更新"。

**通常不必手工做这两步。** 自 v1.6.0 起插件会在启动时自行（重新）建立挂载
（`ensurePluginMount`）：为每个 profile 创建或修复链接，为每个 harness profile 写入依赖声明；
该操作幂等，绝不覆盖你刻意设置的 `link:`/`file:` 规格，也绝不删除无法证明是自己副本的目录。
`GET /dsh-update-checker/mount.json` 可随时查看状态，`status.json` 里也会带 `mount` 字段。
只有在离线安装、或希望"首次启动前 profile 就已正确"时，才需要手工执行第 2 步。

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

- **v1.6.0** — 插件自行挂载，dsh `0.1.6-alpha.2` 不再加载失败：
  - **根因**：`0.1.6-alpha.2` 把 profile 解析默认值从 `options.resolutionMode ?? "link"` 改成 `?? "runtime"`。于是 `PluginPackages` 收到的配置由 `{}` 变为 `{ generation, behavior: "enforce" }`，`routeScoped` 把 `$DSH_HOME/profiles/node_modules` 登记为**受管共享目录**并在遍历搜索路径时直接 `break` 掉，不再检索。该目录从此只能服务"解析代"表里的条目——部署依赖闭包与被选中的 bundle 闭包——而第三方插件两者皆不属于，于是解析落到 `after-fallback`、以 `$DSH_HOME/package.json` 为基准，最终 `ERR_MODULE_NOT_FOUND`，且发生在 **Web 服务绑定端口之前**。dsh 还会把报错里的 importer 路径改写成 profile 目录，所以看起来像"包就在旁边却说找不到"。
  - **修复——插件自我保证挂载**（`ensurePluginMount`，启动时执行，并暴露为 `GET /dsh-update-checker/mount.json`，结果同时作为 `mount` 字段出现在 `status.json`）：为每个 profile 创建/修复 `profiles/<profile>/node_modules/dsh-update-checker` → `profiles/node_modules` 下真实包的 **junction**，并为每个 harness profile 写入 `dependencies` 声明。两半都必需：链接让 `routeScoped` 在共享目录**之前**就命中候选（设计文档原文 "pnpm-managed entries in the profile's `node_modules` resolve first"），而声明是 dsh 的 `readProfilePlugins` 与本插件 `findDeclaringProfiles`/`persistPluginUpdate` 判定归属的依据——缺它插件会一直把自己报成需要更新。必须用 junction 而非副本：副本会让 `import.meta.url` 落到 `profiles/<profile>/node_modules`，`pickDshHome` 认不出 Harness home，自我定位漂移，`@deepseek-ai/*` 同步也会写错位置。在 `"link"` 模式下同样正确（该模式不装路由钩子，原生解析照样命中这份链接），因此不是"看版本下菜"的临时手段。
  - **构造上安全**：幂等；已有声明绝不覆盖（你刻意设置的 `file:`/`link:` 会被保留并记为 `foreignDecl`）；实体目录只有在 `package.json` 的 `name` 能证明是本插件自己的副本时才回收；其余情况报告 `refusing to replace` 并原样留下；只写 harness profile；插件若装在 `profiles/node_modules` 之外（npm `-g`、部署根）则安全跳过。
  - **`runSync` 不再往 profile 里写实体目录**：`lib/index.js` 中主程序同步对 `@deepseek-ai/*` 框架树仍在用 `cp(src, dst, { recursive: true, force: true })`——正是 v1.5.0 在更新 worker 里修掉的那条写入路径，也正是会让 `healProfilesModuleFallback`/`ensureSymlink` 在下一次启动抛 `exists and is not a symlink or dsh-managed module proxy` 的那条。现在它改走同一套"可证明才回收"的逻辑建 junction（Windows）/ 目录符号链接（POSIX），两条同步路径不会再互相矛盾。
  - **回归测试**：`scripts/integration-plugin-mount.test.mjs` 用真实导出函数在临时 Harness home 上跑十个场景——缺失链接被建立（且 realpath 仍位于 `profiles/node_modules` 下）、残留实体副本被回收、已正确的链接保持字节不变、同名外来目录绝不被删、悬空链接被重建、已有/外来声明被保留、非 harness profile 只建链接不写声明、树外安装为空操作、`runSync` 写链接且仍拒绝替换外来包。

- **v1.5.0** — `syncProfilesToDeploy` 改为建链接而非复制（修复主程序更新之后启动崩溃）：
  - **根因**：函数名与日志字段 `junctionSkipped` 都写着"链接"，但新建路径从未建过链接——用的是 `cp(src, dst, { recursive: true, force: true })`。已存在且 realpath 指向同一份的条目会被跳过（实机 236 个里跳过 228 个），而 profile 里**尚不存在**的包（`0.1.6-alpha.1` 更新带来的 8 个）被**实体复制**进 `$DSH_HOME/profiles/node_modules/@deepseek-ai/`。
  - **为何致命**：dsh 的 `healProfilesModuleFallback`/`ensureSymlink` 只接管符号链接或 dsh 托管的模块代理目录，真实目录会直接抛错 `dsh: <path> exists and is not a symlink or dsh-managed module proxy; remove it so dsh can manage the installation fallback`，且发生在 `composeProfile` 阶段——**Web 服务监听之前**，于是下一次启动直接崩掉；而更新本身却报告成功（`main-profile-sync total:236 junctionSkipped:228 failed:[]`）。
  - **修复**：写入路径改为 `mkdir` + `symlink(src, dst, process.platform === "win32" ? "junction" : "dir")`，profile 只保留指向部署侧唯一一份的链接——这也正是 `healProfilesModuleFallback` 期望的形态。
  - **自愈**：目标已存在但不是部署副本时会安全回收——符号链接（含悬空链接）直接重建；实体目录必须 `package.json` 的 `name` 与部署侧一致才替换；其余一律原封不动并记一条失败（`refusing to replace`），顺带堵上第二个此前未被报告的隐患：`fs.cp(..., { force: true })` 对"同名但来自别处"的目录不会报错，而是覆盖那个包的文件、留下其余内容，把它静默毁掉。
  - **回归测试**：`scripts/integration-sync-profiles.test.mjs` 从真实 worker 源码里**提取** `syncProfilesToDeploy` 执行（避免测试与实现漂移），覆盖六个场景——新包建为链接、残留实体副本被回收、同名外来目录绝不被删除、悬空链接被重建、非 `dsh` 前缀包被忽略、deploy 树不可读时安全退出。同一套用例对 1.4.23 的 worker 4/6 失败，对本版 6/6 通过。
  - **安装后的健康检查现在证明"新进程真的起来了"**：原先只要端口有人应答就算成功——`GET /` 返回 200 就扫资源，返回 401/403/407 直接判成功——于是在 `composeProfile` 阶段就崩掉（根本没有服务器）的构建也会被报告为"更新成功"。现在宿主把自己当前的 `instanceId` 交给 worker，worker 从插件自身的路由读回（`update-progress.json`，其次 `status.json`，两者都无需浏览器会话即可访问）：读到**不同**的 id 才说明新构建确实起来了；读到**相同**的 id 说明重启前那个实例还在应答，本次更新判**失败**。探针无法判断时（插件未组合、路由尚未就绪、宿主较旧没传 id）保持原有行为，不把可能健康的更新误判为失败。
  - **预发布闸门改为按"频道"判断，而不再问"是否存在正式版"**：原条件是 `isPrerelease(target) && !allowPrerelease && hasStable`，而 `hasStable` 的含义是"npm 上存在非预发布版本"。`@deepseek-ai/dsh` 至今发布的**全部**版本都是 rc/alpha，`hasStable` 恒为 false，这道闸门从未生效：`allowPrerelease: false` 的部署照样被从 `rc` 升到了 `alpha`。现在按预发布标识（`alpha`/`beta`/`rc`/正式版）比较——同频道升级放行，跨频道提升以 `E_PRERELEASE` 拒绝并在文案里指明 `allowPrerelease` 设置；数据缺失时失败开放（宁可不拦，也不误拦）。
  - **状态、备份与日志遵循 `DSH_HOME`**：原先只按"本包装在哪个 node_modules"推导 home，装在 `…/profiles/node_modules` 之外时会把状态写到程序文件旁边。现在：布局确实是 Harness home 时仍以安装位置为准（`DSH_UC_PROFILE_NODE_MODULES` 覆盖与测试隔离因此不受影响），否则退回 `DSH_HOME`，再退回 `~/.dsh`。
  - **已被此 bug 影响的机器如何自救**：把 `$DSH_HOME/profiles/node_modules/@deepseek-ai/` 下的**真实目录移走**（不要删，先备份），下次启动 dsh 会自动把它们重建为 junction。

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

## 开发

- `lib/index.js` — Host 半身：纯 ESM，仅依赖 Node 内置模块，无构建步骤；纯函数以命名 ESM 导出暴露，供单元测试。
- `lib/client.js` — Client 半身：纯 JS（`window.__ModuleLoader__`），仅依赖 `react`，无构建步骤。
- 测试：`npm test`（Node ≥ 20 内置测试运行器，无第三方依赖）。
- `scripts/restart-service.ps1` — 手动服务重启辅助脚本（需带 `-ExecutionPolicy Bypass` 运行）。

## 许可证

MIT
