# dsh-update-checker 安装教程

> 面向中文用户的图文安装指南。完整技术细节与平台限制见 [README](../README.md) / [README.zh.md](../README.zh.md)。

## 前置条件

- Windows / macOS / Linux + Node.js，且 DeepSeek Harness（`dsh`）本体已能正常运行（Linux/macOS 上主程序一键更新需要系统里有 `ss` 或 `lsof`）
- `@deepseek-ai/dsh` 是 **npm 全局安装**（`npm install -g`）——本插件的一键更新/重启针对此形态开发；非全局安装请先看「平台与安装布局支持」
- 能访问 npm registry

## 第一步：把包放进 profile

`dsh` 的 profile 位于 `$DSH_HOME/profiles`（本机默认 `~/.dsh/profiles`）。插件需要能被 `profiles/node_modules` 解析到。

> ⚠️ **绝不要在 `$DSH_HOME/profiles` 目录里直接执行 `npm install`**——该目录没有 `package.json`，npm 会把整个 `node_modules` 判为"多余依赖"并清空（数据丢失）。

**安全方式 A（推荐）：临时目录安装 + 只拷贝本包**

```bash
# 1) 在临时目录安装
npm i dsh-update-checker --prefix "$TEMP/duc-tmp" --no-save

# 2) 只把本包拷贝进 profile（PowerShell 下用 Copy-Item -Recurse）
cp -r "$TEMP/duc-tmp/node_modules/dsh-update-checker" "$DSH_HOME/profiles/node_modules/"
```

**安全方式 B（最简单）：手动拷贝包目录**

从 GitHub 下载源码 zip 或从 npm 拉 tarball，解压后把 `dsh-update-checker/` 整个目录拷到 `$DSH_HOME/profiles/node_modules/dsh-update-checker/`。

## 第一步半：给 profile 建链接 + 声明依赖（dsh `0.1.6-alpha.2` 起必须）

> 只做第一步在 `0.1.6-alpha.2` 上**会启动失败**：
> `ERR_MODULE_NOT_FOUND: Cannot find package 'dsh-update-checker' imported from …\profiles\web\`
> 该版本把 profile 默认解析模式由 `link` 改为 `runtime`，`profiles/node_modules` 从此只服务部署依赖闭包，
> 第三方插件必须挂在 profile 自己的 `node_modules` 下才能被解析。

```powershell
# 1) 链接（junction，不要用拷贝）
New-Item -ItemType Junction `
  -Path   "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-update-checker" `
  -Target "$env:USERPROFILE\.dsh\profiles\node_modules\dsh-update-checker"
```

```jsonc
// 2) $DSH_HOME/profiles/web/package.json
{
  "name": "dsh-profile-web",
  "private": true,
  "dependencies": {
    "dsh-update-checker": "^1.6.1"   // ← 加这一行
  },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"] } }
}
```

> ⚠️ **首次安装时这一步必做，不能省。** 解析不到插件的 profile 会在 `composeProfile` 阶段直接崩掉——
> 那时插件还没有被加载，所以插件自己**救不了这一次启动**。手工做完 2a + 2b，profile 就能起来。
>
> 💡 首次成功启动之后，挂载就交给插件自己维护：v1.6.0 起它会在启动时、每次插件更新后、每次插件回滚后
> 重跑 `ensurePluginMount()`，为每个 profile 建/修链接并补写依赖声明（幂等，且绝不覆盖你刻意设置的
> `link:`/`file:`）。新增 profile、链接丢失、dsh 升级后都不必再手工编辑。
> 状态查看：`GET http://127.0.0.1:3080/dsh-update-checker/mount.json`（只读）；
> 强制复查：`POST .../dsh-update-checker/mount`（需 `{"confirm":true}` + 回环来源）。

## 第二步：挂载组合行

编辑 `$DSH_HOME/profiles/web/cordis.patch.yml`，加入：

```yaml
- insert:
    - id: dsh-update-checker
      name: 'dsh-update-checker'
```

## 第三步：生效

等 patch HMR 自动应用（或重启 `dsh web`），然后刷新浏览器页面。

## 验证安装

- 打开 DSH Web GUI：顶部会出现主程序更新横幅（有更新时）或"已是最新"提示；设置里出现"检查更新"入口
- 浏览器访问 `http://127.0.0.1:3080/dsh-update-checker/status.json`，应返回 JSON（含 `latest` / `installed` / `hasUpdate`）
- 访问 `http://127.0.0.1:3080/dsh-update-checker/mount.json`，应返回 `ok: true` 且每个 profile 的 `linked` / `declared` 均为 `true`

## 常见问题

### 0. 启动即崩：`Cannot find package 'dsh-update-checker' imported from …\profiles\web\`

dsh `0.1.6-alpha.2` 之后的解析模式变化所致，见「第一步半」。注意**报错里的路径是 dsh 改写过的**，
真实失败基准是 `$DSH_HOME/package.json`，所以"包明明就在旁边却说找不到"是正常现象，不要顺着报错去改。

处置：确认 `profiles\web\node_modules\dsh-update-checker` 存在且是链接
（`Get-Item -Force <路径> | Select LinkType,Target`），并确认 `profiles\web\package.json` 里已声明本插件
（写在 `dependencies` 或 `devDependencies` 均可）。缺哪个补哪个——**这时不能靠"重启让插件自行修复"**，
因为插件正是在这一步加载失败、根本没机会运行（见「第一步半」的警告）。修好后首次成功启动，
之后的维护就交给插件自己了。

### 1. 重启时报 `taskkill` / `cmd` "not recognized"
本机 PATH 损坏所致。插件内部已用全路径调用 System32 工具，正常无需处理；只有手动跑 `scripts/restart-service.ps1` 时才需带 `-ExecutionPolicy Bypass`。

### 2. profile 侧的 `@deepseek-ai/*` 是 junction（省 C 盘方案）
正常现象。插件靠 junction 的 `realpath` 反推部署根，无需任何配置。

### 3. 点"立即更新"失败，或全局 node_modules 被清空
本插件用 `npm install -g` 更新主程序。如果你的 dsh 是**非全局安装**（本地 `node_modules`），不要点主程序"立即更新"——先在 README 的「平台与安装布局支持」里核对你的布局。

### 4. 改了代码但没生效
Host 半身（`lib/index.js`）改动必须重启 `dsh web`；Client 半身（`lib/client.js`）改动刷新页面即可。

### 5. 想更新这个插件本身
设置页"检查更新"→ 插件列表里更新 `dsh-update-checker`；或按"安全方式 A"重新安装新版后重启服务。

## 卸载

从 `cordis.patch.yml` 删除该组合行，删除 `$DSH_HOME/profiles/node_modules/dsh-update-checker/`，重启 `dsh web`。状态文件在 `$DSH_HOME/dsh-update-checker-state.json`，备份在 `$DSH_HOME/dsh-update-checker-backups/`，可一并删除。
