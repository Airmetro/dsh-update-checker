# dsh-update-checker 安装教程

> 面向中文用户的图文安装指南。完整技术细节与平台限制见 [README](../README.md) / [README.zh.md](../README.zh.md)。

## 前置条件

- Windows + Node.js，且 DeepSeek Harness（`dsh`）本体已能正常运行
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

## 常见问题

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
