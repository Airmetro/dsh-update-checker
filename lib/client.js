// dsh-update-checker — Client half (web module bundle, ModuleLoader format). v1.4.11
// 已合并 dsh-plugin-checker：页面加载同时检查
//   A) 主程序更新（/dsh-update-checker/status.json）→ 主程序横幅（顶部 top:64px）
//   B) 第三方插件更新（/dsh-update-checker/plugins.json）→ 插件横幅（top:64px，与主程序横幅同位）
// 插件横幅列出可更新插件（单个更新/全部更新），逐条反馈"更新成功/更新失败"。
// 每 6 小时自动复查；重新检查走 ?fresh=1 强制刷新。i18n 跟随界面语言（zh/en，其余回退中文）。
window.__ModuleLoader__.load({
  id: "dsh-update-checker",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let react = require("react");

    // ── 样式注入（幂等；主程序横幅与插件横幅同位置 top:64px）──
    if (
      typeof document !== "undefined" &&
      document.querySelector('style[data-plugin-css="dsh-update-checker"]') === null
    ) {
      const tag = document.createElement("style");
      tag.dataset.plugin = "dsh-update-checker";
      tag.dataset.pluginCss = "dsh-update-checker";
      tag.textContent =
        // Issue #5：shell.overlay 容器自身是 z-index:20 的 stacking context（position:absolute;inset:0），
        // 子元素 z-index 再高也压不出容器；把容器整体提到 500（高于顶栏/上下文注入 ≤100，低于全屏 modal 1000）。
        "[data-shell-overlay]{z-index:500!important;}" +
        ".dsh-update-banner{position:fixed;top:64px;left:50%;transform:translateX(-50%);z-index:9999;pointer-events:auto;max-width:min(560px,calc(100vw - 32px));background:var(--dsw-alias-bg-overlay,#1f2937);color:var(--dsw-alias-label-primary,#f3f4f6);border:1px solid var(--dsw-alias-border-l2,#374151);border-radius:10px;padding:12px 16px;box-shadow:0 8px 24px rgba(0,0,0,.35);font-size:13px;line-height:1.5;}" +
        ".dsh-update-body{min-width:0;}" +
        ".dsh-update-title{font-weight:600;margin-bottom:2px;cursor:move;}" +
        ".dsh-update-detail{color:var(--dsw-alias-label-secondary,#9ca3af);}" +
        ".dsh-update-detail b{color:var(--dsw-alias-brand-primary,#4f8cff);}" +
        ".dsh-update-hint{color:var(--dsw-alias-label-secondary,#9ca3af);font-size:12px;margin-top:4px;}" +
        ".dsh-update-actions{display:flex;gap:8px;margin-top:8px;align-items:center;}" +
        ".dsh-update-btn{background:var(--dsw-alias-bg-layer-2,#374151);color:var(--dsw-alias-label-primary,#f3f4f6);border:1px solid var(--dsw-alias-border-l1,#4b5563);border-radius:6px;padding:3px 10px;font-size:12px;cursor:pointer;}" +
        ".dsh-update-btn:hover{border-color:var(--dsw-alias-brand-primary,#4f8cff);}" +
        ".dsh-update-btn:disabled{opacity:.5;cursor:default;}" +
        ".dsh-update-btn-primary{background:var(--dsw-alias-brand-primary,#4f8cff);border-color:var(--dsw-alias-brand-primary,#4f8cff);color:#fff;font-weight:600;}" +
        ".dsh-update-status{color:var(--dsw-alias-label-secondary,#9ca3af);font-size:12px;}" +
        ".dsh-plugin-banner{position:fixed;top:64px;left:50%;transform:translateX(-50%);z-index:9998;pointer-events:auto;max-width:min(560px,calc(100vw - 32px));background:var(--dsw-alias-bg-overlay,#1f2937);color:var(--dsw-alias-label-primary,#f3f4f6);border:1px solid var(--dsw-alias-border-l2,#374151);border-radius:10px;padding:12px 16px;box-shadow:0 8px 24px rgba(0,0,0,.35);font-size:13px;line-height:1.5;}" +
        ".dsh-plugin-body{min-width:0;}" +
        ".dsh-plugin-title{font-weight:600;margin-bottom:4px;cursor:move;}" +
        ".dsh-plugin-list{margin:4px 0 8px;max-height:min(45vh,360px);overflow-y:auto;scrollbar-width:thin;scrollbar-color:rgba(148,163,184,.5) transparent;padding-right:4px;}" +
        ".dsh-plugin-row{display:flex;align-items:center;gap:8px;padding:3px 0;border-bottom:1px solid var(--dsw-alias-border-l1,#374151);}" +
        ".dsh-plugin-row:last-child{border-bottom:none;}" +
        ".dsh-plugin-name{font-weight:500;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}" +
        ".dsh-plugin-vers{color:var(--dsw-alias-label-secondary,#9ca3af);font-size:12px;white-space:nowrap;}" +
        ".dsh-plugin-detail{color:var(--dsw-alias-label-secondary,#9ca3af);font-size:12px;margin-top:2px;}" +
        ".dsh-plugin-actions{display:flex;gap:8px;margin-top:8px;align-items:center;flex-wrap:wrap;}" +
        ".dsh-plugin-btn{background:var(--dsw-alias-bg-layer-2,#374151);color:var(--dsw-alias-label-primary,#f3f4f6);border:1px solid var(--dsw-alias-border-l1,#4b5563);border-radius:6px;padding:3px 10px;font-size:12px;cursor:pointer;}" +
        ".dsh-plugin-btn:hover{border-color:var(--dsw-alias-brand-primary,#4f8cff);}" +
        ".dsh-plugin-btn:disabled{opacity:.5;cursor:default;}" +
        ".dsh-plugin-btn-primary{background:var(--dsw-alias-brand-primary,#4f8cff);border-color:var(--dsw-alias-brand-primary,#4f8cff);color:#fff;font-weight:600;}" +
        ".dsh-plugin-ok{color:#34d399;}" +
        ".dsh-plugin-fail{color:#f87171;}" +
        ".dsh-plugin-warn{color:#fbbf24;}" +
        ".dsh-plugin-spacer{flex:1;}" +
        ".dsh-plugin-results{margin:4px 0 8px;max-height:min(45vh,360px);overflow-y:auto;scrollbar-width:thin;scrollbar-color:rgba(148,163,184,.5) transparent;padding-right:4px;}" +
        ".dsh-plugin-list::-webkit-scrollbar,.dsh-plugin-results::-webkit-scrollbar{width:8px;}" +
        ".dsh-plugin-list::-webkit-scrollbar-thumb,.dsh-plugin-results::-webkit-scrollbar-thumb{background:rgba(148,163,184,.4);border-radius:4px;}" +
        ".dsh-plugin-list::-webkit-scrollbar-thumb:hover,.dsh-plugin-results::-webkit-scrollbar-thumb:hover{background:rgba(148,163,184,.7);}" +
        ".dsh-plugin-list::-webkit-scrollbar-track,.dsh-plugin-results::-webkit-scrollbar-track{background:transparent;}" +
        ".dsh-toggle{position:relative;display:inline-block;width:36px;height:20px;border-radius:10px;background:rgba(128,128,128,.45);cursor:pointer;transition:background .2s;flex:none;border:none;outline:none;vertical-align:middle;}" +
        ".dsh-toggle::after{content:'';position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.3);transition:left .2s;}" +
        ".dsh-toggle.on{background:#34d399;}" +
        ".dsh-toggle.on::after{left:18px;}" +
        ".dsh140-progress{height:8px;border-radius:4px;background:rgba(128,128,128,.2);margin-top:6px;overflow:hidden;}" +
        ".dsh140-progress-fill{height:100%;border-radius:4px;background:linear-gradient(90deg,#4f8cff,#34d399);transition:width .3s ease;}" +
        ".dsh140-progress-text{font-size:12px;color:var(--dsh-update-checker-progress-text,#9ca3af);margin-top:3px;}";
      document.head.appendChild(tag);
    }

    // ── 常量 ──────────────────────────────────────────────────────────
    const STATUS_URL = "/dsh-update-checker/status.json";
    const UPDATE_URL = "/dsh-update-checker/update";
    const RESTART_URL = "/dsh-update-checker/restart";
    const SUPPRESS_URL = "/dsh-update-checker/suppress";
    const PLUGIN_STATUS_URL = "/dsh-update-checker/plugins.json";
    const PLUGIN_UPDATE_URL = "/dsh-update-checker/plugin-update";
    const PLUGIN_SUPPRESS_URL = "/dsh-update-checker/plugin-suppress";
    const SETTINGS_URL = "/dsh-update-checker/settings";
    const SETTINGS_JSON_URL = "/dsh-update-checker/settings.json";
    const UPDATE_PROGRESS_URL = "/dsh-update-checker/update-progress.json";
    const ROLLBACK_URL = "/dsh-update-checker/rollback";
    const PLUGIN_ROLLBACK_URL = "/dsh-update-checker/plugin-rollback";
    const BACKUPS_URL = "/dsh-update-checker/backups.json";
    const BACKUP_SETTINGS_URL = "/dsh-update-checker/backup-settings.json";
    const BACKUP_ROOT_URL = "/dsh-update-checker/backup-root";
    const BACKUPS_CLEAR_URL = "/dsh-update-checker/backups-clear";
    const BACKUP_FOLDER_PICK_URL = "/dsh-update-checker/backup-folder-pick";
    const BACKUP_FOLDER_OPEN_URL = "/dsh-update-checker/backup-folder-open";
    const CHECK_INTERVAL = 6 * 60 * 60 * 1000; // 6 小时自动复查

    // ── i18n：主程序 + 插件两套文案（同一命名空间）────────────────────────
    const NS = "dsh-update-checker";
    const ZH = {
      "banner.title": "DeepSeek Harness 有新版本可用",
      "banner.latest": "最新版本 {version}",
      "banner.current": "当前版本 {version}",
      "banner.hint":
        "更新方式：在部署目录执行 npm install @deepseek-ai/dsh@latest，然后重启 dsh web 服务",
      "banner.recheck": "重新检查",
      "banner.update": "立即更新",
      "banner.dismiss": "知道了",
      "banner.updating": "正在安装新版本…",
      "banner.restarting":
        "更新完成，正在重启服务…页面将短暂断开并自动重新连接，请稍候",
      "banner.updated": "更新完成（v{version}）",
      "banner.reloading": "正在刷新页面以加载新版本…",
      "banner.updateFailed": "更新失败：{error}",
      "banner.confirmUpdate":
        "将安装 @deepseek-ai/dsh 最新版并重启 dsh web 服务（页面会短暂断开），确定继续？",
      "banner.upToDate.title": "DeepSeek Harness 已是最新版本",
      "banner.upToDate.detail": "当前版本 {version}",
      "banner.ok": "确定",
      "banner.never": "不再提示",
      "banner.checkFailed.title": "检查更新失败",
      "banner.checkFailed.detail": "原因：{error}",
      "banner.retry": "重试",
      "banner.reload": "刷新页面",
      "banner.restartTimeout": "服务未在 {seconds} 秒内恢复，请手动刷新页面",
      "plugin.title": "有 {count} 个插件可更新",
      "plugin.vers": "{installed} → {latest}",
      "plugin.update": "更新",
      "plugin.updateAll": "全部更新",
      "plugin.recheck": "重新检查",
      "plugin.updating": "正在更新 {name}…",
      "plugin.updatingProgress": "正在更新 {name}…（{current}/{total}）",
      "plugin.updateOk": "{name} 更新成功（{version}）",
      "plugin.updateFail": "{name} 更新失败：{error}",
      "plugin.persistWarn": "⚠ 本次更新未写入清单/锁文件，重装后可能回退旧版并再次提醒",
      "plugin.allDone": "全部插件已更新到最新版",
      "plugin.oneDone": "{name} 已更新到 v{version}",
      "plugin.someFailed": "{ok} 个成功，{fail} 个失败",
      "plugin.confirmAll": "将把 {count} 个插件更新到最新版，确定继续？",
      "plugin.confirmOne": "将把 {name} 更新到最新版，确定继续？",
      "plugin.checkFailed.title": "插件更新检查失败",
      "plugin.checkFailed.detail": "原因：{error}",
      "plugin.retry": "重试",
      "plugin.dismiss": "知道了",
      "plugin.cancelUpdate": "取消更新",
      "plugin.never": "不再提示",
      "plugin.upToDate.title": "所有插件已是最新版本",
      "plugin.upToDate.detail": "已安装 {count} 个第三方插件",
      "plugin.ok": "确定",
      "settings.label": "检查更新",
      "settings.core": "DeepSeek Harness 主程序",
      "settings.plugins": "第三方插件",
      "settings.controls": "显示与控制",
      "settings.restartService": "重启服务",
      "settings.restartServiceConfirm": "将重启 dsh web 服务（页面会短暂断开并自动重连），确定继续？",
      "settings.restartOk": "重启已调度，服务恢复中…（页面将自动重连）",
      "settings.restartFail": "重启调度失败：{error}",
      "settings.floating": "显示悬浮窗",
      "settings.notify": "横幅提示",
      "settings.on": "开",
      "settings.off": "关",
      "settings.suppressed": "横幅已被“不再提示”关闭",
      "settings.reEnable": "重新启用提示",
      "settings.refresh": "重新检查",
      "settings.updating": "检查中…",
      "settings.hasUpdate": "有更新",
      "settings.upToDate": "已是最新",
      "settings.rollbackState": "本机版本高于发布源（作者可能回退了版本）",
      "settings.errorState": "无法查询到发布源（库可能已被删除）",
      "settings.updatedTo": "已更新到 v{v}",
      "settings.updateFailed": "更新失败",
      "settings.restartHint": "（重启 dsh web 后生效）",
      "settings.autoRestarted": "（更新完成，服务已自动重启）",
      "settings.queued": "（还有 {n} 个排队）",
      "settings.updatingShort": "更新中…",
      "settings.queuedBtn": "已排队",
      "settings.rollback": "回滚",
      "settings.rollbackConfirm": "将把主程序回滚到备份中的 v{v}（先做现场快照），确定继续？",
      "settings.rollbackOk": "已回滚到 v{v}",
      "settings.rollbackFail": "回滚失败：{error}",
      "settings.pluginRollbackConfirm": "将把 {name} 回滚到备份版本，确定继续？",
      "settings.noBackup": "（无备份）",
      "settings.backupSection": "恢复与备份",
      "settings.backupFolder": "备份文件夹",
      "settings.backupFolderHint": "主程序与插件备份统一存放于此；删除备份缓存后将无法回滚",
      "settings.backupSave": "保存",
      "settings.backupBrowse": "浏览…",
      "settings.backupOpen": "打开文件夹",
      "settings.backupSaved": "备份文件夹已更新",
      "settings.backupSaveFail": "保存失败：{error}",
      "settings.backupCounts": "备份：主程序 {main} 个 / 插件 {plugin} 个",
      "settings.clearBackups": "删除备份文件缓存",
      "settings.clearBackupsConfirm": "将删除全部备份缓存（主程序与插件），确定继续？",
      "settings.clearBackupsOk": "已删除 {n} 个备份",
      "settings.clearBackupsFail": "删除失败：{error}",
      "settings.downloadSource": "默认下载源",
      "settings.downloadSourceHint": "在 npm 与 GitHub 版本一致时，首选下载地址",
      "settings.sourceGithub": "GitHub（默认）",
      "settings.sourceNpm": "npm",
      "settings.sourceSmart": "智能选择（先 GitHub，失败再 npm）",
      "banner.brief": "v{from} → v{to}（{risk}）",
      "banner.briefNotes": "更新要点：{notes}",
      "risk.major": "大版本（可能有破坏性变更）",
      "risk.minor": "新功能",
      "risk.patch": "修复",
      "risk.pre": "预发布",
      "risk.same": "同版本",
      "risk.unknown": "未知",
    };
    const EN = {
      "banner.title": "A new DeepSeek Harness version is available",
      "banner.latest": "Latest {version}",
      "banner.current": "Installed {version}",
      "banner.hint":
        "To update: run `npm install @deepseek-ai/dsh@latest` in the deployment directory, then restart the dsh web service",
      "banner.recheck": "Re-check",
      "banner.update": "Update now",
      "banner.dismiss": "Dismiss",
      "banner.updating": "Installing the new version…",
      "banner.restarting":
        "Update complete — restarting the service… the page will disconnect briefly and reconnect, please wait",
      "banner.updated": "Update complete (v{version})",
      "banner.reloading": "Refreshing the page to load the new version…",
      "banner.updateFailed": "Update failed: {error}",
      "banner.confirmUpdate":
        "Install the latest @deepseek-ai/dsh and restart the dsh web service? The page will disconnect briefly.",
      "banner.upToDate.title": "DeepSeek Harness is up to date",
      "banner.upToDate.detail": "Current version {version}",
      "banner.ok": "OK",
      "banner.never": "Don't remind again",
      "banner.checkFailed.title": "Update check failed",
      "banner.checkFailed.detail": "Reason: {error}",
      "banner.retry": "Retry",
      "banner.reload": "Reload page",
      "banner.restartTimeout": "The service did not recover within {seconds}s, please reload manually",
      "plugin.title": "{count} plugins can be updated",
      "plugin.vers": "{installed} → {latest}",
      "plugin.update": "Update",
      "plugin.updateAll": "Update all",
      "plugin.recheck": "Re-check",
      "plugin.updating": "Updating {name}…",
      "plugin.updatingProgress": "Updating {name}… ({current}/{total})",
      "plugin.updateOk": "{name} updated ({version})",
      "plugin.updateFail": "{name} update failed: {error}",
      "plugin.persistWarn": "⚠ Update was not persisted to the manifest/lockfile and may revert (and re-alert) after a reinstall",
      "plugin.allDone": "All plugins are up to date now",
      "plugin.oneDone": "{name} updated to v{version}",
      "plugin.someFailed": "{ok} succeeded, {fail} failed",
      "plugin.confirmAll": "Update {count} plugins to latest?",
      "plugin.confirmOne": "Update {name} to latest?",
      "plugin.checkFailed.title": "Plugin check failed",
      "plugin.checkFailed.detail": "Reason: {error}",
      "plugin.retry": "Retry",
      "plugin.dismiss": "Dismiss",
      "plugin.cancelUpdate": "Cancel update",
      "plugin.never": "Don't remind again",
      "plugin.upToDate.title": "All plugins are up to date",
      "plugin.upToDate.detail": "{count} third-party plugins installed",
      "plugin.ok": "OK",
      "settings.label": "Update Check",
      "settings.core": "DeepSeek Harness",
      "settings.plugins": "Third-party plugins",
      "settings.controls": "Display & control",
      "settings.restartService": "Restart service",
      "settings.restartServiceConfirm": "Restart the dsh web service? The page will disconnect briefly and reconnect automatically.",
      "settings.restartOk": "Restart scheduled, service is recovering… (the page will reconnect)",
      "settings.restartFail": "Restart scheduling failed: {error}",
      "settings.floating": "Show floating banners",
      "settings.notify": "Banner notifications",
      "settings.on": "On",
      "settings.off": "Off",
      "settings.suppressed": "Banners suppressed via \"Don't remind\"",
      "settings.reEnable": "Re-enable notifications",
      "settings.refresh": "Re-check",
      "settings.updating": "Checking…",
      "settings.hasUpdate": "Update available",
      "settings.upToDate": "Up to date",
      "settings.rollbackState": "Local version is higher than the publish source (the author may have rolled back)",
      "settings.errorState": "No publish source found (the repo may have been deleted)",
      "settings.updatedTo": "Updated to v{v}",
      "settings.updateFailed": "Update failed",
      "settings.restartHint": " (restart dsh web to take effect)",
      "settings.autoRestarted": " (update complete, service auto-restarted)",
      "settings.queued": "({n} queued)",
      "settings.updatingShort": "Updating…",
      "settings.queuedBtn": "Queued",
      "settings.rollback": "Rollback",
      "settings.rollbackConfirm": "Roll the main program back to v{v} from the backup (a safety snapshot is taken first)?",
      "settings.rollbackOk": "Rolled back to v{v}",
      "settings.rollbackFail": "Rollback failed: {error}",
      "settings.pluginRollbackConfirm": "Roll {name} back to the backed-up version?",
      "settings.noBackup": "(no backup)",
      "settings.backupSection": "Backup & Restore",
      "settings.backupFolder": "Backup folder",
      "settings.backupFolderHint": "Main-program and plugin backups live here; clearing the backup cache makes rollback impossible",
      "settings.backupSave": "Save",
      "settings.backupBrowse": "Browse…",
      "settings.backupOpen": "Open folder",
      "settings.backupSaved": "Backup folder updated",
      "settings.backupSaveFail": "Save failed: {error}",
      "settings.backupCounts": "Backups: main {main} / plugins {plugin}",
      "settings.clearBackups": "Clear backup cache",
      "settings.clearBackupsConfirm": "This deletes ALL backups (main program and plugins). Continue?",
      "settings.clearBackupsOk": "Removed {n} backups",
      "settings.clearBackupsFail": "Clear failed: {error}",
      "settings.downloadSource": "Preferred download source",
      "settings.downloadSourceHint": "When npm and GitHub have the same version, prefer this source",
      "settings.sourceGithub": "GitHub (default)",
      "settings.sourceNpm": "npm",
      "settings.sourceSmart": "Smart (try GitHub first, then npm)",
      "banner.brief": "v{from} → v{to} ({risk})",
      "banner.briefNotes": "Notes: {notes}",
      "risk.major": "major (may break)",
      "risk.minor": "minor",
      "risk.patch": "patch",
      "risk.pre": "pre-release",
      "risk.same": "same",
      "risk.unknown": "unknown",
    };

    // locale 服务缺席时的回退翻译：命中中文词典，{name} 插值规则同官方 t。
    function fallbackT(key, params) {
      let text = ZH[key] !== undefined ? ZH[key] : key;
      if (params) {
        text = text.replace(/\{(\w+)\}/g, (m, name) =>
          name in params ? String(params[name]) : m
        );
      }
      return text;
    }

    function fetchStatus(url, force) {
      const u = force ? `${url}?fresh=1` : url;
      return fetch(u, { cache: "no-store" }).then((res) => {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      });
    }

    function postJson(url, extra) {
      return fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(Object.assign({ confirm: true }, extra || {})),
      }).then((res) => res.json());
    }

    // 模块级忙碌标记：更新/重启期间暂停定时复查（主程序与插件共用，避免并发写操作）
    let busy = false;

    // 跨组件共享"更新进行中"状态（1.4.1 修复）：
    // 此前 updating 是各组件局部 state → 设置页关闭再开丢失"正在更新"、横幅与设置互不同步。
    // 用模块级订阅器共享：UpdateBanner / PluginBanner / SettingsSection 读写同一状态源，
    // 组件重挂载时读取当前值即可恢复显示。
    const updater = {
      current: null, // { kind: 'main' | 'plugin', name }
      listeners: new Set(),
      set(kind, name) {
        this.current = kind ? { kind, name } : null;
        this.emit();
      },
      emit() {
        this.listeners.forEach((fn) => fn(this.current));
      },
      subscribe(fn) {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
      },
    };
    // React hook：订阅共享更新状态（组件卸载时自动退订）
    function useSharedUpdate() {
      const [shared, setShared] = react.useState(updater.current);
      react.useEffect(() => updater.subscribe(setShared), []);
      return shared;
    }

    // ═══════════════ v1.4.11 双检查完成门控 + 主程序更新完成等待 ═══════════════
    // 横幅只在「主程序 + 插件」都检查完才显示（避免主程序横幅先弹、插件横幅后到，
    // 或反之——两段式弹出）。两个检查组件各自在请求成功/失败后 markCheckDone(kind)。
    const checkCoord = { main: false, plugin: false, listeners: new Set() };
    function markCheckDone(kind) {
      checkCoord[kind] = true;
      checkCoord.listeners.forEach((fn) => fn());
    }
    function useBothChecked() {
      const [both, setBoth] = react.useState(checkCoord.main && checkCoord.plugin);
      react.useEffect(() => {
        const fn = () => setBoth(checkCoord.main && checkCoord.plugin);
        checkCoord.listeners.add(fn);
        fn();
        return () => checkCoord.listeners.delete(fn);
      }, []);
      return both;
    }

    // 等待主程序更新 worker 真实完成：/update 现在只是"已启动后台 worker"
    // （停服务→安装→校验→重启 都由独立子进程完成，见 lib/index.js /update 路由），
    // 客户端必须轮询 /update-progress.json 直到 phase=done（成功）/error（失败）。
    // 服务重启期间轮询会暂时失败，继续重试；超时（默认 15 分钟）判失败。
    function waitMainUpdateFinish(timeoutMs) {
      const limit = timeoutMs || 15 * 60 * 1000;
      return new Promise((resolve) => {
        const startedAt = Date.now();
        const timer = setInterval(() => {
          fetch(UPDATE_PROGRESS_URL, { cache: "no-store" })
            .then((r) => (r.ok ? r.json() : null))
            .then((p) => {
              if (!p) return;
              if (p.phase === "done") {
                clearInterval(timer);
                resolve({ ok: true, result: p.result || null });
              } else if (p.phase === "error") {
                clearInterval(timer);
                resolve({ ok: false, error: p.error || "update failed", code: p.code || null });
              } else if (Date.now() - startedAt > limit) {
                clearInterval(timer);
                resolve({ ok: false, error: "update worker timeout" });
              }
            })
            .catch(() => { /* 服务重启期间轮询失败 → 继续等 */ });
        }, 1000);
      });
    }

    // ═══════════════ 主程序横幅 ═══════════════
    function UpdateBanner(props) {
      const t = props.t || fallbackT;
      const [state, setState] = react.useState({
        status: "checking",
        data: null,
        error: null,
      });
      const [dismissed, setDismissed] = react.useState(false);
      const sharedUp = useSharedUpdate(); // 跨组件共享更新状态（设置页触发的更新这里也能看到）
      const sharedMainUpdating = !!(sharedUp && sharedUp.kind === "main");
      // v1.4.11：双检查完成门控（主程序与插件都检查完才显示横幅）
      const bothChecked = useBothChecked();
      // 本次更新会话标记：进度轮询只在"本横幅发起过更新"时才处理 done/error（防止误读旧进度文件）
      const updateSessionRef = react.useRef(false);
      // 主程序更新进度（轮询 /update-progress.json；POST /update 挂着期间实时刷新）
      const [progress, setProgress] = react.useState(null);
      const pollRef = react.useRef(null);
      const stopPoll = () => {
        if (pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
        }
      };
      const startPoll = () => {
        stopPoll();
        setProgress(null);
        pollRef.current = setInterval(() => {
          fetch(UPDATE_PROGRESS_URL, { cache: "no-store" })
            .then((r) => (r.ok ? r.json() : null))
            .then((p) => {
              if (p) setProgress(p);
            })
            .catch(() => {});
        }, 600);
      };

      const runCheck = (force) => {
        if (busy) return;
        setState({ status: "checking", data: null, error: null });
        fetchStatus(STATUS_URL, force)
          .then((data) => {
            setState({ status: "done", data, error: null });
            markCheckDone("main");
          })
          .catch((err) => {
            console.error("[dsh-update-checker] check failed", err);
            setState({ status: "error", data: null, error: String(err && err.message ? err.message : err) });
            markCheckDone("main");
          });
      };

      const startUpdate = () => {
        if (typeof window !== "undefined" && !window.confirm(t("banner.confirmUpdate"))) return;
        busy = true;
        updateSessionRef.current = true;
        updater.set("main", "@deepseek-ai/dsh");
        startPoll();
        setState({ status: "updating", data: state.data, error: null });
        postJson(UPDATE_URL)
          .then((res) => {
            if (!res || !res.ok) throw new Error((res && res.error) || "update failed");
            // v1.4.11：/update 只是启动了后台 worker（停服务→安装→校验→重启 全由
            // 独立子进程完成）。此前这里立即再 POST /restart，会与 worker 的安装并发
            // （文件占用）导致安装失败回滚、服务却以旧版本被拉起——"点更新→立即显示
            // 更新完成→重启后还是旧版本"的根因。现在改等 worker 真实完成（phase done/error）。
            waitMainUpdateFinish().then((done) => {
              if (done.ok) {
                busy = false;
                updateSessionRef.current = false;
                stopPoll();
                updater.set(null);
                setState({ status: "updated", data: state.data, result: done.result || null });
                // 服务已由 worker 重启并健康检查通过；刷新页面加载新前端
                setTimeout(() => {
                  if (typeof window !== "undefined") window.location.reload();
                }, 1500);
              } else {
                busy = false;
                updateSessionRef.current = false;
                stopPoll();
                updater.set(null);
                setState({
                  status: "updateFailed",
                  data: state.data,
                  error: done.error || "update failed",
                });
              }
            });
          })
          .catch((err) => {
            busy = false;
            updateSessionRef.current = false;
            stopPoll();
            updater.set(null);
            setState({
              status: "updateFailed",
              data: state.data,
              error: String(err && err.message ? err.message : err),
            });
          });
      };

      react.useEffect(() => {
        runCheck();
        const timer = setInterval(runCheck, CHECK_INTERVAL);
        return () => {
          clearInterval(timer);
          stopPoll(); // 组件卸载时清理进度轮询
        };
      }, []);

      // 重启后轮询 status.json，确认服务恢复；60 秒未恢复则提示手动刷新。
      react.useEffect(() => {
        if (state.status !== "restarting") return;
        let alive = true;
        let attempts = 0;
        const timer = setInterval(() => {
          attempts += 1;
          fetchStatus(STATUS_URL)
            .then(() => {
              if (!alive) return;
              clearInterval(timer);
              runCheck(true);
            })
            .catch(() => {
              if (!alive) return;
              if (attempts >= 30) {
                clearInterval(timer);
                setState({ status: "restartTimedOut", data: null, error: null });
              }
            });
        }, 2000);
        return () => {
          alive = false;
          clearInterval(timer);
        };
      }, [state.status]);

      // 主程序横幅"已处理完"或"本轮不显示"时，通知插件横幅可以显示（串行：先主程序后插件）。
      // 触发点：用户 dismiss（确定/不再提示/知道了/取消更新），或 status done 且已持久化抑制（主程序不显示）。
      react.useEffect(() => {
        const coreSettled =
          dismissed ||
          (state.status === "done" && state.data && state.data.suppressUpToDate);
        if (coreSettled && typeof window !== "undefined") {
          window.dispatchEvent(new Event("dsh-update-core-done"));
        }
      }, [
        dismissed,
        state.status,
        state.data ? state.data.suppressUpToDate : false,
      ]);

      const d = state.data;

      // 悬浮窗/提示开关关闭时，主程序横幅不显示（可在设置页重新打开）
      if (d && (d.floatingEnabled === false || d.notifyEnabled === false)) return null;

      // 点过"知道了/确定"后：本轮横幅直接关闭（无论是否有更新）。
      // （原逻辑在有更新时忽略 dismissed 导致"知道了"点了没反应，已修。）
      if (dismissed) return null;

      // 更新中 / 重启中：显示进度横幅（无按钮）；sharedMainUpdating = 设置页等其它入口触发的更新
      if (state.status === "updating" || state.status === "restarting" || sharedMainUpdating) {
        const isUpdating = state.status === "updating" || sharedMainUpdating;
        return react.createElement(
          "div",
          { className: "dsh-update-banner" },
          react.createElement(
            "div",
            { className: "dsh-update-body" },
            react.createElement("div", { className: "dsh-update-title" }, t("banner.title")),
            react.createElement(
              "div",
              { className: "dsh-update-status" },
              isUpdating ? t("banner.updating") : t("banner.restarting")
            ),
            isUpdating && progress && progress.percent !== null && progress.percent !== undefined
              ? react.createElement(
                  "div",
                  { className: "dsh140-progress" },
                  react.createElement("div", { className: "dsh140-progress-fill", style: { width: Math.max(2, Math.min(100, progress.percent)) + "%" } })
                )
              : null,
            isUpdating && progress
              ? react.createElement(
                  "div",
                  { className: "dsh140-progress-text" },
                  String(progress.label || "更新中…") +
                    (progress.percent !== null && progress.percent !== undefined ? " " + progress.percent + "%" : "") +
                    (progress.detail ? " · " + progress.detail : "")
                )
              : null
          )
        );
      }

      // 更新完成（v1.4.11：worker 完成安装 + 重启 + 健康检查后才进入此态；随后自动刷新页面）
      if (state.status === "updated") {
        const ver =
          (state.result && state.result.installed) ||
          (state.data && state.data.latest) ||
          "?";
        return react.createElement(
          "div",
          { className: "dsh-update-banner" },
          react.createElement(
            "div",
            { className: "dsh-update-body" },
            react.createElement(
              "div",
              { className: "dsh-update-title dsh-plugin-ok" },
              t("banner.updated", { version: String(ver) })
            ),
            react.createElement(
              "div",
              { className: "dsh-update-detail" },
              t("banner.reloading")
            )
          )
        );
      }

      // 更新失败：显示错误与重试入口
      if (state.status === "updateFailed") {
        return react.createElement(
          "div",
          { className: "dsh-update-banner" },
          react.createElement(
            "div",
            { className: "dsh-update-body" },
            react.createElement("div", { className: "dsh-update-title" }, t("banner.title")),
            react.createElement(
              "div",
              { className: "dsh-update-detail" },
              t("banner.updateFailed", { error: state.error || "?" })
            ),
            react.createElement(
              "div",
              { className: "dsh-update-actions" },
              react.createElement(
                "button",
                { className: "dsh-update-btn", onClick: startUpdate },
                t("banner.update")
              ),
              react.createElement(
                "button",
                { className: "dsh-update-btn", onClick: () => setDismissed(true) },
                t("banner.dismiss")
              )
            )
          )
        );
      }

      // 重启超时：服务未在 60 秒内恢复，提示手动刷新。
      if (state.status === "restartTimedOut") {
        return react.createElement(
          "div",
          { className: "dsh-update-banner" },
          react.createElement(
            "div",
            { className: "dsh-update-body" },
            react.createElement("div", { className: "dsh-update-title" }, t("banner.title")),
            react.createElement(
              "div",
              { className: "dsh-update-detail" },
              t("banner.restartTimeout", { seconds: "60" })
            ),
            react.createElement(
              "div",
              { className: "dsh-update-actions" },
              react.createElement(
                "button",
                { className: "dsh-update-btn dsh-update-btn-primary", onClick: () => (typeof window !== "undefined" ? window.location.reload() : null) },
                t("banner.reload")
              )
            )
          )
        );
      }

      // v1.4.11 双检查完成门控：主程序与插件都检查完才显示普通结果横幅
      // （更新中/失败等交互态不受此限制）。避免主程序横幅先弹、插件横幅后到的两段式弹出。
      if (!bothChecked) return null;

      // 检查失败（请求整体失败，或 latest/installed 有错误）：显示失败横幅，避免误报"已是最新"。
      const checkError =
        state.status === "error"
          ? state.error || "network error"
          : d && (d.latestError || d.installedError)
          ? d.latestError || d.installedError
          : null;
      if (checkError) {
        return react.createElement(
          "div",
          { className: "dsh-update-banner" },
          react.createElement(
            "div",
            { className: "dsh-update-body" },
            react.createElement("div", { className: "dsh-update-title" }, t("banner.checkFailed.title")),
            react.createElement(
              "div",
              { className: "dsh-update-detail" },
              t("banner.checkFailed.detail", { error: checkError })
            ),
            react.createElement(
              "div",
              { className: "dsh-update-actions" },
              react.createElement(
                "button",
                { className: "dsh-update-btn dsh-update-btn-primary", onClick: () => runCheck(true) },
                t("banner.retry")
              ),
              react.createElement(
                "button",
                { className: "dsh-update-btn", onClick: () => setDismissed(true) },
                t("banner.dismiss")
              )
            )
          )
        );
      }

      // 常规状态：每次启动都显示横幅——
      //   有新版本 → 更新横幅（立即更新/重新检查/知道了）
      //   无新版本且未点过"不再提示" → "已是最新版本"横幅（确定/不再提示）
      //   无新版本且已点过"不再提示" → 静默
      if (state.status !== "done" || !d) return null;

      if (d.hasUpdate) {
        const currentPart = d.installed
          ? " · " + t("banner.current", { version: String(d.installed) })
          : "";
        return react.createElement(
          "div",
          { className: "dsh-update-banner" },
          react.createElement(
            "div",
            { className: "dsh-update-body" },
            react.createElement("div", { className: "dsh-update-title" }, t("banner.title")),
            react.createElement(
              "div",
              { className: "dsh-update-detail" },
              t("banner.latest", { version: String(d.latest || "?") }),
              currentPart
            ),
            d.brief
              ? react.createElement(
                  "div",
                  { className: "dsh-update-detail" },
                  t("banner.brief", {
                    from: String(d.brief.from),
                    to: String(d.brief.to),
                    risk: t("risk." + (d.brief.risk || "unknown")),
                  }),
                  d.brief.notes && d.brief.notes.length
                    ? " · " + t("banner.briefNotes", { notes: String(d.brief.notes[0]) })
                    : null
                )
              : null,
            react.createElement("div", { className: "dsh-update-hint" }, t("banner.hint")),
            react.createElement(
              "div",
              { className: "dsh-update-actions" },
              react.createElement(
                "button",
                { className: "dsh-update-btn", onClick: () => runCheck(true) },
                t("banner.recheck")
              ),
              react.createElement(
                "button",
                { className: "dsh-update-btn dsh-update-btn-primary", onClick: startUpdate },
                t("banner.update")
              ),
              react.createElement(
                "button",
                { className: "dsh-update-btn", onClick: () => setDismissed(true) },
                t("banner.dismiss")
              )
            )
          )
        );
      }

      // 已是最新版本：未抑制时显示"确定 / 不再提示"
      if (d.suppressUpToDate) return null;

      // "不再提示"统一抑制主程序与插件两类横幅（设置页"横幅提示"滑块可一键恢复）
      const suppressNow = () => {
        postJson(SETTINGS_URL, { suppressUpToDate: true, suppressPluginBanner: true })
          .then((res) => {
            if (!res || !res.ok) throw new Error((res && res.error) || "suppress failed");
            setDismissed(true);
          })
          .catch((err) => {
            console.error("[dsh-update-checker] suppress failed", err);
            setDismissed(true); // 写失败也先关闭本次；下次启动仍会显示
          });
      };

      return react.createElement(
        "div",
        { className: "dsh-update-banner" },
        react.createElement(
          "div",
          { className: "dsh-update-body" },
          react.createElement("div", { className: "dsh-update-title" }, t("banner.upToDate.title")),
          react.createElement(
            "div",
            { className: "dsh-update-detail" },
            t("banner.upToDate.detail", { version: String(d.installed || d.latest || "?") })
          ),
          react.createElement(
            "div",
            { className: "dsh-update-actions" },
            react.createElement(
              "button",
              { className: "dsh-update-btn dsh-update-btn-primary", onClick: () => setDismissed(true) },
              t("banner.ok")
            ),
            react.createElement(
              "button",
              { className: "dsh-update-btn", onClick: suppressNow },
              t("banner.never")
            )
          )
        )
      );
    }

    // ═══════════════ 插件横幅（合并自 dsh-plugin-checker）═══════════════
    function PluginBanner(props) {
      const t = props.t || fallbackT;
      const [state, setState] = react.useState({ status: "checking", data: null, error: null });
      const [dismissed, setDismissed] = react.useState(false);
      const [updatingName, setUpdatingName] = react.useState(null);
      const [results, setResults] = react.useState([]); // {name, ok, version|error}
      const [progress, setProgress] = react.useState(null); // {current, total} 批量更新进度
      const [lastBatchTotal, setLastBatchTotal] = react.useState(0); // 更新前的可更新总数，用于判断"是否全部完成"
      // 串行：主程序横幅处理完（dismiss）或本轮不显示（已抑制）后，才允许显示插件横幅
      const [coreDone, setCoreDone] = react.useState(false);
      const sharedUp = useSharedUpdate(); // 跨组件共享更新状态（设置页触发的插件更新这里也能看到）
      const sharedPluginUpdating = !!(sharedUp && sharedUp.kind === "plugin" && !updatingName);

      const runCheck = (force) => {
        if (busy) return;
        setState({ status: "checking", data: null, error: null });
        fetchStatus(PLUGIN_STATUS_URL, force)
          .then((data) => {
            setState({ status: "done", data, error: null });
            markCheckDone("plugin");
          })
          .catch((err) => {
            console.error("[dsh-update-checker] plugin check failed", err);
            setState({ status: "error", data: null, error: String(err && err.message ? err.message : err) });
            markCheckDone("plugin");
          });
      };

      react.useEffect(() => {
        runCheck();
        const timer = setInterval(() => runCheck(), CHECK_INTERVAL);
        return () => clearInterval(timer);
      }, []);

      // 监听主程序横幅"处理完"事件
      react.useEffect(() => {
        const handler = () => setCoreDone(true);
        if (typeof window !== "undefined") window.addEventListener("dsh-update-core-done", handler);
        return () => {
          if (typeof window !== "undefined") window.removeEventListener("dsh-update-core-done", handler);
        };
      }, []);

      const doUpdate = (name) => {
        if (busy) return;
        if (typeof window !== "undefined" && !window.confirm(t("plugin.confirmOne", { name }))) return;
        busy = true;
        updater.set("plugin", name);
        setUpdatingName(name);
        setProgress(null);
        setLastBatchTotal((state.data && state.data.plugins || []).filter((p) => p.hasUpdate).length);
        setResults([]);
        postJson(PLUGIN_UPDATE_URL, { name })
          .then((res) => {
            if (res && res.ok) {
              setResults([{ name, ok: true, version: res.installed || "?" }]);
            } else {
              setResults([{ name, ok: false, error: (res && res.error) || "update failed" }]);
            }
          })
          .catch((err) => {
            setResults([{ name, ok: false, error: String(err && err.message ? err.message : err) }]);
          })
          .finally(() => {
            busy = false;
            updater.set(null);
            setUpdatingName(null);
            runCheck(true);
          });
      };

      const doUpdateAll = () => {
        if (busy) return;
        const updatable = (state.data && state.data.plugins || []).filter((p) => p.hasUpdate);
        if (updatable.length === 0) return;
        if (typeof window !== "undefined" && !window.confirm(t("plugin.confirmAll", { count: updatable.length }))) return;
        busy = true;
        setLastBatchTotal(updatable.length);
        setResults([]);
        const results = [];
        const run = (i) => {
          if (i >= updatable.length) {
            busy = false;
            updater.set(null);
            setUpdatingName(null);
            setProgress(null);
            setResults(results);
            runCheck(true);
            return;
          }
          const p = updatable[i];
          updater.set("plugin", p.name);
          setUpdatingName(p.name);
          setProgress({ current: i + 1, total: updatable.length });
          postJson(PLUGIN_UPDATE_URL, { name: p.name })
            .then((res) => {
              if (res && res.ok) results.push({ name: p.name, ok: true, version: res.installed || "?" });
              else results.push({ name: p.name, ok: false, error: (res && res.error) || "update failed" });
            })
            .catch((err) => {
              results.push({ name: p.name, ok: false, error: String(err && err.message ? err.message : err) });
            })
            .then(() => run(i + 1));
        };
        run(0);
      };

      const suppressPlugin = () => {
        postJson(SETTINGS_URL, { suppressUpToDate: true, suppressPluginBanner: true })
          .then((res) => {
            if (!res || !res.ok) throw new Error((res && res.error) || "suppress failed");
            setDismissed(true);
          })
          .catch((err) => {
            console.error("[dsh-update-checker] plugin suppress failed", err);
            setDismissed(true);
          });
      };

      // 串行：主程序横幅处理完前，插件横幅不显示
      if (!coreDone) return null;
      if (dismissed && results.length === 0 && !updatingName) return null;
      const d = state.data;
      // 悬浮窗/提示开关关闭时，插件横幅不显示（可在设置页重新打开）
      if (d && (d.floatingEnabled === false || d.notifyEnabled === false)) return null;

      // 更新中（批量时显示进度 current/total）
      if (updatingName) {
        const progTitle = progress && progress.total > 1
          ? t("plugin.updatingProgress", { current: progress.current, total: progress.total, name: updatingName })
          : t("plugin.updating", { name: updatingName });
        return react.createElement(
          "div",
          { className: "dsh-plugin-banner" },
          react.createElement(
            "div",
            { className: "dsh-plugin-body" },
            react.createElement("div", { className: "dsh-plugin-title" }, progTitle)
          )
        );
      }

      // 更新结果反馈
      if (results.length > 0) {
        const okCount = results.filter((r) => r.ok).length;
        const failCount = results.length - okCount;
        // 标题区分"单个更新完成" / "全部更新完成" / "部分失败"，避免单插件更新时误显"全部已更新"
        const title =
          failCount > 0
            ? t("plugin.someFailed", { ok: okCount, fail: failCount })
            : results.length === 1
              ? t("plugin.oneDone", { name: results[0].name, version: results[0].version })
              : t("plugin.allDone");
        return react.createElement(
          "div",
          { className: "dsh-plugin-banner" },
          react.createElement(
            "div",
            { className: "dsh-plugin-body" },
            react.createElement(
              "div",
              { className: "dsh-plugin-title " + (failCount > 0 ? "dsh-plugin-fail" : "dsh-plugin-ok") },
              title
            ),
            react.createElement(
              "div",
              { className: "dsh-plugin-results" },
              results.map((r) => {
                // v1.4.6：更新成功但未持久化到清单/锁文件时显著提示（否则重装后可能回退旧版，
                // 同一插件又会反复提醒更新）。
                const p = r.persisted;
                const warnPersist =
                  r.ok &&
                  p &&
                  (p.error ||
                    (Array.isArray(p.manifest) &&
                      p.manifest.length > 0 &&
                      (!p.manifest.some((m) => m.changed) ||
                        !(Array.isArray(p.lockfile) && p.lockfile.every((l) => l.ok)))));
                return react.createElement(
                  "div",
                  { key: r.name },
                  react.createElement(
                    "div",
                    { className: "dsh-plugin-detail " + (r.ok ? "dsh-plugin-ok" : "dsh-plugin-fail") },
                    r.ok ? t("plugin.updateOk", { name: r.name, version: r.version }) : t("plugin.updateFail", { name: r.name, error: r.error })
                  ),
                  warnPersist
                    ? react.createElement(
                        "div",
                        { className: "dsh-plugin-detail dsh-plugin-warn" },
                        t("plugin.persistWarn")
                      )
                    : null
                );
              })
            ),
            react.createElement(
              "div",
              { className: "dsh-plugin-actions" },
              react.createElement(
                "button",
                { className: "dsh-plugin-btn", onClick: () => {
                    // 本轮已把全部可更新插件处理完 → 直接关闭横幅（不再弹"所有插件已是最新"）；
                    // 否则只清结果，回到剩余可更新列表
                    if (lastBatchTotal > 0 && results.length >= lastBatchTotal) {
                      setResults([]);
                      setDismissed(true);
                    } else {
                      setResults([]);
                    }
                  } },
                t("plugin.dismiss")
              )
            )
          )
        );
      }

      // 检查失败
      if (state.status === "error" || (d && d.error)) {
        const err = state.status === "error" ? (state.error || "?") : (d && d.error);
        return react.createElement(
          "div",
          { className: "dsh-plugin-banner" },
          react.createElement(
            "div",
            { className: "dsh-plugin-body" },
            react.createElement("div", { className: "dsh-plugin-title" }, t("plugin.checkFailed.title")),
            react.createElement("div", { className: "dsh-plugin-detail" }, t("plugin.checkFailed.detail", { error: err })),
            react.createElement(
              "div",
              { className: "dsh-plugin-actions" },
              react.createElement(
                "button",
                { className: "dsh-plugin-btn dsh-plugin-btn-primary", onClick: () => runCheck(true) },
                t("plugin.retry")
              ),
              react.createElement(
                "button",
                { className: "dsh-plugin-btn", onClick: () => setDismissed(true) },
                t("plugin.dismiss")
              )
            )
          )
        );
      }

      // 其它入口（设置页）触发的插件更新进行中：这里也显示进度横幅（跨组件同步）
      if (sharedPluginUpdating) {
        return react.createElement(
          "div",
          { className: "dsh-plugin-banner" },
          react.createElement(
            "div",
            { className: "dsh-plugin-body" },
            react.createElement("div", { className: "dsh-plugin-title" }, t("plugin.title", { count: 1 })),
            react.createElement(
              "div",
              { className: "dsh-plugin-detail" },
              t("plugin.updating", { name: sharedUp.name })
            )
          )
        );
      }

      // 检查中
      if (state.status !== "done" || !d) return null;

      const updatable = (d.plugins || []).filter((p) => p.hasUpdate);

      // 无更新：显示"全部最新"小横幅（确定/不再提示；持久化抑制时静默）
      if (updatable.length === 0) {
        if (d.suppressPluginBanner) return null;
        return react.createElement(
          "div",
          { className: "dsh-plugin-banner" },
          react.createElement(
            "div",
            { className: "dsh-plugin-body" },
            react.createElement("div", { className: "dsh-plugin-title" }, t("plugin.upToDate.title")),
            react.createElement(
              "div",
              { className: "dsh-plugin-detail" },
              t("plugin.upToDate.detail", { count: (d.plugins || []).length })
            ),
            react.createElement(
              "div",
              { className: "dsh-plugin-actions" },
              react.createElement(
                "button",
                { className: "dsh-plugin-btn dsh-plugin-btn-primary", onClick: () => setDismissed(true) },
                t("plugin.ok")
              ),
              react.createElement(
                "button",
                { className: "dsh-plugin-btn", onClick: suppressPlugin },
                t("plugin.never")
              )
            )
          )
        );
      }
      // "不再提示插件更新"已持久化：即使有更新也不显示横幅（与主程序对称）
      if (d.suppressPluginBanner) return null;

      return react.createElement(
        "div",
        { className: "dsh-plugin-banner" },
        react.createElement(
          "div",
          { className: "dsh-plugin-body" },
          react.createElement("div", { className: "dsh-plugin-title" }, t("plugin.title", { count: updatable.length })),
          react.createElement(
            "div",
            { className: "dsh-plugin-list" },
            updatable.map((p) =>
              react.createElement(
                "div",
                { key: p.name, className: "dsh-plugin-row" },
                react.createElement("div", { className: "dsh-plugin-name" }, p.name),
                react.createElement("div", { className: "dsh-plugin-vers" }, t("plugin.vers", { installed: p.installed || "?", latest: p.latest || "?" })),
                react.createElement("div", { className: "dsh-plugin-spacer" }),
                react.createElement(
                  "button",
                  { className: "dsh-plugin-btn", onClick: () => doUpdate(p.name) },
                  t("plugin.update")
                )
              )
            )
          ),
          react.createElement(
            "div",
            { className: "dsh-plugin-actions" },
            react.createElement(
              "button",
              { className: "dsh-plugin-btn dsh-plugin-btn-primary", onClick: doUpdateAll },
              t("plugin.updateAll")
            ),
            react.createElement(
              "button",
              { className: "dsh-plugin-btn", onClick: () => runCheck(true) },
              t("plugin.recheck")
            ),
            react.createElement(
              "button",
              { className: "dsh-plugin-btn", onClick: () => setDismissed(true) },
              t("plugin.cancelUpdate")
            ),
            react.createElement(
              "button",
              { className: "dsh-plugin-btn", onClick: suppressPlugin },
              t("plugin.never")
            )
          )
        )
      );
    }

    // ═══════════════ 设置页「检查更新」═══════════════
    // 主程序版本对比 + 第三方插件版本对比（黄灯=有更新/绿灯=最新）+ 悬浮窗/提示开关 + 恢复"不再提示"
    function SettingsSection(props) {
      const t = props.t || fallbackT;
      const [core, setCore] = react.useState(null);
      const [plugs, setPlugs] = react.useState(null);
      const [settings, setSettings] = react.useState(null);
      const [err, setErr] = react.useState(null);
      const [busy, setBusy] = react.useState(false);
      const queueRef = react.useRef([]); // 待更新队列 {type:'main'|'plugin', name}
      const updatingRef = react.useRef(null); // 当前执行中（ref 防闭包过期）
      const [updating, setUpdating] = react.useState(null); // 当前执行中（UI 用）
      const [results, setResults] = react.useState([]); // 已完成记录 {name, ok, text}
      const [total, setTotal] = react.useState(0); // 本轮队列总数（进度显示用）
      const [queuedNames, setQueuedNames] = react.useState([]); // 已入队未执行的插件名（行内"已排队"标记）
      const [queuedCount, setQueuedCount] = react.useState(0); // 排队数（state 实时刷新；queueRef 是 ref 不触发渲染）
      const [backups, setBackups] = react.useState(null); // /backups.json（主程序 + 插件备份清单，回滚入口）
      const [backupCfg, setBackupCfg] = react.useState(null); // /backup-settings.json（备份文件夹 + 计数）
      const [backupPath, setBackupPath] = react.useState(""); // 备份文件夹编辑框
      const [backupBusy, setBackupBusy] = react.useState(false);
      const sharedUp = useSharedUpdate(); // 跨组件共享更新状态（横幅触发的更新，关闭设置再打开也能看到）
      const sharedBusy = sharedUp !== null; // 其它入口正在更新（本地 updating 为 null 时显示共享状态）
      // 主程序更新进度（轮询 update-progress.json；主程序任务执行期间开启）
      const [progress, setProgress] = react.useState(null);
      const pollRef = react.useRef(null);
      const stopPoll = () => {
        if (pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
        }
      };
      const startPoll = () => {
        stopPoll();
        setProgress(null);
        pollRef.current = setInterval(() => {
          fetch(UPDATE_PROGRESS_URL, { cache: "no-store" })
            .then((r) => (r.ok ? r.json() : null))
            .then((p) => {
              if (p) setProgress(p);
            })
            .catch(() => {});
        }, 600);
      };
      react.useEffect(() => () => stopPoll(), []);

      const syncQueueState = () => {
        setQueuedNames(queueRef.current.map((t) => t.name));
        setQueuedCount(queueRef.current.length);
      };

      // 串行队列：连续点击多个"更新"会排队（点击即入队，无确认弹窗打断）；前一个完成才执行下一个
      // v1.4.11：主程序任务不再把 /update 的 200 当作"已更新"——它只是启动了后台 worker，
      // 改等 /update-progress.json 的 done/error（真实安装+重启+健康检查完成）再上报结果。
      const processNext = async () => {
        const task = queueRef.current.shift();
        syncQueueState();
        if (!task) {
          updatingRef.current = null;
          setUpdating(null);
          updater.set(null);
          setTotal(0);
          stopPoll();
          load();
          return;
        }
        updater.set(task.type === "main" ? "main" : "plugin", task.name);
        if (task.type === "main") startPoll(); else stopPoll();
        updatingRef.current = task.name;
        setUpdating(task.name);
        try {
          if (task.type === "main") {
            const r = await postJson(UPDATE_URL);
            if (r && r.ok) {
              const done = await waitMainUpdateFinish();
              if (done.ok) {
                const installed = (done.result && done.result.installed) || "?";
                setResults((prev) => [
                  ...prev,
                  { name: task.name, ok: true, text: t("settings.updatedTo", { v: installed }) + t("settings.autoRestarted") },
                ]);
                setCore((prev) => (prev ? { ...prev, installed, hasUpdate: false } : prev));
              } else {
                setResults((prev) => [
                  ...prev,
                  { name: task.name, ok: false, text: t("settings.updateFailed") + "：" + (done.error || "?") },
                ]);
              }
            } else {
              setResults((prev) => [
                ...prev,
                { name: task.name, ok: false, text: (r && r.error) || t("settings.updateFailed") },
              ]);
            }
          } else {
            const r = await postJson(PLUGIN_UPDATE_URL, { name: task.name });
            if (r && r.ok) {
              setResults((prev) => [...prev, { name: task.name, ok: true, text: t("settings.updatedTo", { v: r.installed || "?" }) }]);
              // 单个完成立即刷新行内状态（绿灯/按钮消失），不等全部完成
              setPlugs((prev) =>
                prev
                  ? {
                      ...prev,
                      plugins: (prev.plugins || []).map((p) =>
                        p.name === task.name ? { ...p, installed: r.installed || p.installed, hasUpdate: false } : p
                      ),
                    }
                  : prev
              );
            } else {
              setResults((prev) => [...prev, { name: task.name, ok: false, text: (r && r.error) || t("settings.updateFailed") }]);
            }
          }
        } catch (e) {
          setResults((prev) => [...prev, { name: task.name, ok: false, text: String((e && e.message) || e) }]);
        } finally {
          stopPoll();
          updatingRef.current = null;
          setUpdating(null);
          processNext();
        }
      };
      // 入队（去重：已在队列/进行中的忽略）；插件更新点击即入队，无 confirm 打断
      const enqueue = (task) => {
        if (queueRef.current.some((t) => t.name === task.name) || updatingRef.current === task.name) return;
        queueRef.current.push(task);
        setTotal((prev) => prev + 1);
        syncQueueState();
        if (updatingRef.current === null) processNext();
      };
      const runMainUpdate = () => {
        // 主程序更新改全局部署（npm -g），保留确认
        if (typeof window !== "undefined" && !window.confirm(t("banner.confirmUpdate"))) return;
        enqueue({ type: "main", name: "@deepseek-ai/dsh" });
      };
      const runPluginUpdate = (name) => {
        // 插件更新有备份可回滚，点击即入队（连续点击不弹确认框）
        enqueue({ type: "plugin", name });
      };
      // 一键更新全部有更新插件（逐个入队，串行执行；已在队列/进行中的跳过）
      const runUpdateAll = () => {
        const updatable = plugs && plugs.plugins ? plugs.plugins.filter((p) => p.hasUpdate) : [];
        if (!updatable.length) return;
        if (typeof window !== "undefined" && !window.confirm(t("plugin.confirmAll", { count: updatable.length }))) return;
        const fresh = updatable.filter((p) => !queueRef.current.some((t) => t.name === p.name) && updatingRef.current !== p.name);
        if (!fresh.length) return;
        fresh.forEach((p) => queueRef.current.push({ type: "plugin", name: p.name }));
        setTotal((prev) => prev + fresh.length);
        syncQueueState();
        if (updatingRef.current === null) processNext();
      };

      const load = () => {
        setErr(null);
        Promise.all([
          fetchStatus(STATUS_URL, true),
          fetchStatus(PLUGIN_STATUS_URL, true),
          fetch("/dsh-update-checker/settings.json", { cache: "no-store" }).then((r) => r.json()),
          fetch(BACKUPS_URL, { cache: "no-store" }).then((r) => r.json()).catch(() => null),
          fetch(BACKUP_SETTINGS_URL, { cache: "no-store" }).then((r) => r.json()).catch(() => null),
        ])
          .then(([c, p, s, b, bc]) => { setCore(c); setPlugs(p); setSettings(s); setBackups(b); setBackupCfg(bc); setBackupPath((bc && bc.backupRoot) || ""); })
          .catch((e) => setErr(String((e && e.message) || e)));
      };
      react.useEffect(() => { load(); }, []);

      // 单独重新检查：主程序 / 插件互不影响
      const refreshCore = () => {
        setErr(null);
        fetchStatus(STATUS_URL, true).then(setCore).catch((e) => setErr(String((e && e.message) || e)));
      };
      const refreshPlugs = () => {
        setErr(null);
        fetchStatus(PLUGIN_STATUS_URL, true).then(setPlugs).catch((e) => setErr(String((e && e.message) || e)));
      };

      const saveSetting = (patch) => {
        if (busy) return;
        setBusy(true);
        postJson("/dsh-update-checker/settings", patch)
          .then((res) => { if (res && res.settings) setSettings(res.settings); })
          .catch(() => { /* 静默，保留旧值 */ })
          .finally(() => setBusy(false));
      };

      // ── 回滚：主程序（最新备份）与插件（按 pkgName 匹配备份）──
      const mainRollbackTarget = () => {
        const list = (backups && backups.main) || [];
        return list[0] || null;
      };
      const runMainRollback = () => {
        const tgt = mainRollbackTarget();
        if (!tgt) return;
        if (typeof window !== "undefined" && !window.confirm(t("settings.rollbackConfirm", { v: tgt.installed || "?" }))) return;
        setBusy(true);
        postJson(ROLLBACK_URL)
          .then((r) => {
            if (r && r.ok) {
              setResults((prev) => [...prev, { name: "@deepseek-ai/dsh", ok: true, text: t("settings.rollbackOk", { v: r.installed || "?" }) + t("settings.restartHint") }]);
            } else {
              setResults((prev) => [...prev, { name: "@deepseek-ai/dsh", ok: false, text: (r && r.error) || t("settings.rollbackFail", { error: "?" }) }]);
            }
            load();
          })
          .catch((e) => {
            setResults((prev) => [...prev, { name: "@deepseek-ai/dsh", ok: false, text: t("settings.rollbackFail", { error: String((e && e.message) || e) }) }]);
            load();
          })
          .finally(() => setBusy(false));
      };
      const pluginBackupFor = (p) => {
        const list = (backups && backups.plugins) || [];
        return list.find((b) => b.kind === "plugin" && (b.pkgName === p.name || b.name === p.name)) || null;
      };
      const runPluginRollback = (p) => {
        const b = pluginBackupFor(p);
        if (!b) return;
        if (typeof window !== "undefined" && !window.confirm(t("settings.pluginRollbackConfirm", { name: p.name }))) return;
        setBusy(true);
        postJson(PLUGIN_ROLLBACK_URL, { id: b.id })
          .then((r) => {
            if (r && r.ok) {
              setResults((prev) => [...prev, { name: p.name, ok: true, text: t("settings.rollbackOk", { v: r.installed || "?" }) }]);
            } else {
              setResults((prev) => [...prev, { name: p.name, ok: false, text: (r && r.error) || t("settings.rollbackFail", { error: "?" }) }]);
            }
            load();
          })
          .catch((e) => {
            setResults((prev) => [...prev, { name: p.name, ok: false, text: t("settings.rollbackFail", { error: String((e && e.message) || e) }) }]);
            load();
          })
          .finally(() => setBusy(false));
      };

      const el = react.createElement;

      // ── 恢复与备份：备份文件夹修改 + 删除备份缓存 ──
      const saveBackupRoot = () => {
        if (backupBusy) return;
        const p = (backupPath || "").trim();
        if (!p || (backupCfg && p === backupCfg.backupRoot)) return;
        setBackupBusy(true);
        postJson(BACKUP_ROOT_URL, { path: p })
          .then((r) => {
            if (r && r.ok) {
              setResults((prev) => [...prev, { name: t("settings.backupFolder"), ok: true, text: t("settings.backupSaved") }]);
              load();
            } else {
              setResults((prev) => [...prev, { name: t("settings.backupFolder"), ok: false, text: t("settings.backupSaveFail", { error: (r && r.error) || "?" }) }]);
            }
          })
          .catch((e) => setResults((prev) => [...prev, { name: t("settings.backupFolder"), ok: false, text: t("settings.backupSaveFail", { error: String((e && e.message) || e) }) }]))
          .finally(() => setBackupBusy(false));
      };
      const clearBackups = () => {
        if (backupBusy) return;
        if (typeof window !== "undefined" && !window.confirm(t("settings.clearBackupsConfirm"))) return;
        setBackupBusy(true);
        postJson(BACKUPS_CLEAR_URL)
          .then((r) => {
            if (r && r.ok) {
              setResults((prev) => [...prev, { name: t("settings.clearBackups"), ok: true, text: t("settings.clearBackupsOk", { n: r.removed || 0 }) }]);
              load();
            } else {
              setResults((prev) => [...prev, { name: t("settings.clearBackups"), ok: false, text: t("settings.clearBackupsFail", { error: (r && r.error) || "?" }) }]);
            }
          })
          .catch((e) => setResults((prev) => [...prev, { name: t("settings.clearBackups"), ok: false, text: t("settings.clearBackupsFail", { error: String((e && e.message) || e) }) }]))
          .finally(() => setBackupBusy(false));
      };
      // 浏览…：弹出 Windows 原生文件夹选择对话框，选中后直接应用为新备份文件夹
      const browseBackupRoot = () => {
        if (backupBusy) return;
        setBackupBusy(true);
        fetch(BACKUP_FOLDER_PICK_URL, { cache: "no-store" })
          .then((r) => r.json())
          .then((r) => {
            if (r && r.ok && r.picked && r.path) {
              setBackupPath(r.path);
              return postJson(BACKUP_ROOT_URL, { path: r.path }).then((res) => {
                if (res && res.ok) {
                  setResults((prev) => [...prev, { name: t("settings.backupFolder"), ok: true, text: t("settings.backupSaved") }]);
                } else {
                  setResults((prev) => [...prev, { name: t("settings.backupFolder"), ok: false, text: t("settings.backupSaveFail", { error: (res && res.error) || "?" }) }]);
                }
                load();
              });
            }
          })
          .catch((e) => setResults((prev) => [...prev, { name: t("settings.backupFolder"), ok: false, text: t("settings.backupSaveFail", { error: String((e && e.message) || e) }) }]))
          .finally(() => setBackupBusy(false));
      };
      // 打开：用资源管理器打开当前备份文件夹
      const openBackupFolder = () => {
        if (backupBusy) return;
        setBackupBusy(true);
        fetch(BACKUP_FOLDER_OPEN_URL, { cache: "no-store" })
          .catch(() => {})
          .finally(() => setBackupBusy(false));
      };
      // v1.4.12：手动重启服务（独立于主程序更新——更新流程由后台 worker 自行重启）。
      // 重启后页面会短暂断开并自动重连；结果写入 /restart-status.json。
      const [restartMsg, setRestartMsg] = react.useState(null);
      const runRestartService = () => {
        if (busy) return;
        if (typeof window !== "undefined" && !window.confirm(t("settings.restartServiceConfirm"))) return;
        setBusy(true);
        setRestartMsg(null);
        postJson(RESTART_URL)
          .then((r) => {
            if (r && r.ok) setRestartMsg({ ok: true, text: t("settings.restartOk") });
            else setRestartMsg({ ok: false, text: t("settings.restartFail", { error: (r && r.error) || "?" }) });
          })
          .catch((e) => setRestartMsg({ ok: false, text: t("settings.restartFail", { error: String((e && e.message) || e) }) }))
          .finally(() => setBusy(false));
      };
      const st = {
        card: { display: "flex", flexDirection: "column", gap: 10, maxWidth: 640 },
        box: { border: "1px solid rgba(128,128,128,.3)", borderRadius: 8, padding: "10px 12px" },
        h: { fontWeight: 600, marginBottom: 6 },
        row: { display: "flex", alignItems: "center", gap: 8, padding: "2px 0" },
        name: { fontWeight: 500, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 },
        vers: { color: "#9ca3af", fontSize: 12, whiteSpace: "nowrap" },
        dot: { width: 10, height: 10, borderRadius: "50%", flex: "none", display: "inline-block" },
        list: { maxHeight: 300, overflowY: "auto", scrollbarWidth: "thin", paddingRight: 4 },
        btn: { background: "transparent", border: "1px solid rgba(128,128,128,.5)", borderRadius: 6, padding: "3px 12px", fontSize: 12, cursor: "pointer" },
        btnOn: { background: "rgba(52,211,153,.18)", borderColor: "#34d399", color: "#34d399", fontWeight: 600 },
        btnOff: { background: "transparent", borderColor: "rgba(128,128,128,.5)", color: "#9ca3af" },
        btnUpd: { background: "transparent", border: "1px solid rgba(128,128,128,.5)", borderRadius: 6, padding: "3px 12px", fontSize: 12, cursor: "pointer", flex: "none" },
        btnUpdDisabled: { background: "transparent", border: "1px solid rgba(128,128,128,.35)", color: "#6b7280", borderRadius: 6, padding: "3px 12px", fontSize: 12, cursor: "default", flex: "none" },
        headRow: { display: "flex", alignItems: "center", gap: 8, marginBottom: 6 },
        muted: { color: "#9ca3af", fontSize: 12 },
        err: { color: "#f87171", fontSize: 12 },
      };
      // 状态灯（v1.4.5）：黄=有更新 / 绿=最新 / 红=作者回退版本或无法查询到（库被删）。
      // 兼容旧数据：无 status 字段时回退到 hasUpdate 判断。
      const lamp = (p) => {
        const status = (p && p.status) || (p && p.hasUpdate ? "update" : "latest");
        const bg = status === "update" ? "#eab308" : status === "latest" ? "#34d399" : "#ef4444";
        const title =
          status === "update"
            ? t("settings.hasUpdate")
            : status === "latest"
              ? t("settings.upToDate")
              : status === "rollback"
                ? t("settings.rollbackState")
                : t("settings.errorState");
        return el("span", { style: { ...st.dot, background: bg }, title });
      };

      // 云 + 向下箭头图标（线条风格，跟随文字颜色）
      const CloudDownIcon = () =>
        el("svg", { width: 13, height: 13, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", style: { verticalAlign: "-2px", marginRight: 4, flex: "none" } },
          el("path", { d: "M20 16.58A5 5 0 0 0 18 7h-1.26A8 8 0 1 0 4 15.25" }),
          el("line", { x1: "12", y1: "11", x2: "12", y2: "21" }),
          el("polyline", { points: "9 18 12 21 15 18" }));

      const updBtn = (disabled, onClick, label, showIcon) =>
        el("button", { style: disabled ? st.btnUpdDisabled : st.btnUpd, disabled: !!disabled, onClick: onClick },
          showIcon ? CloudDownIcon() : null,
          label);

      const coreBusy = updating === "main" || queuedNames.includes("@deepseek-ai/dsh");
      const coreRow = core
        ? el("div", { style: st.row },
            lamp(core),
            el("span", { style: st.name }, "@deepseek-ai/dsh"),
            el("span", { style: st.vers }, (core.installed || "?") + " → " + (core.latest || "?")),
            core.hasUpdate ? updBtn(coreBusy, runMainUpdate, coreBusy ? (updating === "main" ? t("settings.updatingShort") : t("settings.queuedBtn")) : t("plugin.update"), !coreBusy) : null,
            mainRollbackTarget() ? updBtn(busy || !!updating, runMainRollback, t("settings.rollback"), false) : null)
        : el("div", { style: st.muted }, t("settings.updating"));

      const pluginRows = plugs && plugs.plugins
        ? plugs.plugins.map((p) => {
            const pBusy = updating === p.name || queuedNames.includes(p.name);
            const pRb = pluginBackupFor(p);
            return el("div", { key: p.name, style: st.row },
              lamp(p),
              el("span", { style: st.name }, p.name),
              el("span", { style: { ...st.vers, color: p.latest ? undefined : "#f87171" } }, p.latest
                ? (p.installed || "?") + " → " + p.latest + (p.source === "github" || p.source === "both" ? "  [GH" + (p.source === "both" ? "/npm]" : "]") : "")
                : (p.error || "获取失败")),
              p.hasUpdate ? updBtn(pBusy, () => runPluginUpdate(p.name), pBusy ? (updating === p.name ? t("settings.updatingShort") : t("settings.queuedBtn")) : t("plugin.update"), !pBusy) : null,
              pRb ? updBtn(busy || !!updating, () => runPluginRollback(p), t("settings.rollback"), false) : null);
          })
        : [];

      // 滑块开关（.dsh-toggle 样式由注入 CSS 提供）
      const toggleSwitch = (label, on, onClick) =>
        el("div", { style: st.row },
          el("span", { style: st.name }, label),
          el("span", { className: "dsh-toggle" + (on ? " on" : ""), onClick: onClick, title: on ? t("settings.on") : t("settings.off") }));

      // "横幅提示" = notifyEnabled 且未被"不再提示"抑制；关闭时点一下即恢复（清 suppress）
      // v1.4.11：settings 未加载时按默认值（开）渲染，保证进入设置页「显示与控制」立即显示，
      // 不依赖 settings.json 网络往返（此前 settings 为 null 时整个开关区是空的）。
      const notifyOn = !!(
        settings
          ? settings.notifyEnabled !== false && !(settings.suppressUpToDate || settings.suppressPluginBanner)
          : true
      );
      const floatingOn = settings ? settings.floatingEnabled !== false : true;
      const toggles = [
        toggleSwitch(t("settings.floating"), floatingOn, () => saveSetting({ floatingEnabled: !floatingOn })),
        toggleSwitch(t("settings.notify"), notifyOn, () => {
          if (notifyOn) saveSetting({ notifyEnabled: false });
          else saveSetting({ notifyEnabled: true, suppressUpToDate: false, suppressPluginBanner: false });
        }),
      ];

      const srcOptions = [
        { value: "github", label: t("settings.sourceGithub") },
        { value: "npm", label: t("settings.sourceNpm") },
        { value: "smart", label: t("settings.sourceSmart") },
      ];
      // v1.4.11：下拉框同样立即渲染（settings 未加载时按默认 github 显示）
      const sourceRow = el("div", { style: { ...st.row, flexWrap: "wrap" } },
        el("span", { style: st.name }, t("settings.downloadSource")),
        el("select", {
          value: (settings && settings.downloadSource) || "github",
          onChange: (e) => saveSetting({ downloadSource: e.target.value }),
          style: { background: "transparent", border: "1px solid rgba(128,128,128,.5)", borderRadius: 6, padding: "3px 8px", fontSize: 12, color: "inherit" },
        },
          srcOptions.map((o) => el("option", { key: o.value, value: o.value }, o.label))),
        el("div", { className: "dsh140-mut", style: { width: "100%" } }, t("settings.downloadSourceHint")));

      const coreHead = el("div", { style: st.headRow },
        el("span", { style: { fontWeight: 600 } }, t("settings.core")),
        el("span", { style: { flex: 1 } }),
        el("button", { style: st.btn, onClick: refreshCore, disabled: !!updating }, t("settings.refresh")));
      const updatableCount = plugs && plugs.plugins ? plugs.plugins.filter((p) => p.hasUpdate).length : 0;
      const plugsHead = el("div", { style: st.headRow },
        el("span", { style: { fontWeight: 600 } }, t("settings.plugins") + (plugs && plugs.plugins ? "（" + plugs.plugins.length + "）" : "")),
        el("span", { style: { flex: 1 } }),
        updatableCount > 0 ? el("button", { style: st.btnUpd, onClick: runUpdateAll, disabled: !!updating }, CloudDownIcon(), t("plugin.updateAll")) : null,
        el("button", { style: st.btn, onClick: refreshPlugs, disabled: !!updating }, t("settings.refresh")));

      const activeUpdating = updating || (sharedUp ? sharedUp.name : null); // 本地或其它入口（横幅）触发的更新
      const mainUpdating = activeUpdating === "@deepseek-ai/dsh"; // 主程序更新中（显示进度条）
      const msgBox = results.length > 0 || updating || sharedBusy
        ? el("div", { style: { marginTop: 4, border: activeUpdating ? "1px solid rgba(79,140,255,.45)" : "1px solid rgba(128,128,128,.25)", borderRadius: 6, padding: "8px 10px", background: activeUpdating ? "rgba(79,140,255,.07)" : "transparent", display: "flex", flexDirection: "column", gap: 2 } },
            activeUpdating
              ? el("div", { style: { color: "#4f8cff", fontSize: 12, fontWeight: 600 } },
                  t("plugin.updating", { name: activeUpdating }) +
                  (total > 1 ? "（" + results.length + "/" + total + "）" : "") +
                  (queuedCount > 0 ? " " + t("settings.queued", { n: queuedCount }) : ""))
              : null,
            mainUpdating && progress && progress.percent !== null && progress.percent !== undefined
              ? el("div", { className: "dsh140-progress", style: { width: "100%" } },
                  el("div", { className: "dsh140-progress-fill", style: { width: Math.max(2, Math.min(100, progress.percent)) + "%" } }))
              : null,
            mainUpdating && progress
              ? el("div", { className: "dsh140-progress-text" },
                  String(progress.label || "更新中…") +
                    (progress.percent !== null && progress.percent !== undefined ? " " + progress.percent + "%" : "") +
                    (progress.detail ? " · " + progress.detail : ""))
              : null,
            results.map((r) =>
              el("div", { key: r.name + ":" + r.text, style: { color: r.ok ? "#34d399" : "#f87171", fontSize: 12 } },
                (r.ok ? "✓ " : "✗ ") + r.name + "：" + r.text)))
        : null;

      return el("div", { style: st.card },
        el("div", { style: st.box }, coreHead, coreRow),
        el("div", { style: st.box }, plugsHead, el("div", { style: st.list }, pluginRows.length ? pluginRows : el("div", { style: st.muted }, t("settings.updating")))),
        msgBox,
        el("div", { style: st.box },
          el("div", { style: st.h }, t("settings.controls")),
          toggles,
          sourceRow,
          el("div", { style: st.row },
            el("span", { style: st.name }, t("settings.restartService")),
            el("button", { className: "dsh140-btn", onClick: runRestartService, disabled: busy, style: st.btnUpd }, t("settings.restartService"))),
          restartMsg
            ? el("div", { style: { color: restartMsg.ok ? "#34d399" : "#f87171", fontSize: 12 } }, (restartMsg.ok ? "✓ " : "✗ ") + restartMsg.text)
            : null,
          err ? el("div", { style: st.err }, "错误：" + err) : null),
        el("div", { style: st.box },
          el("div", { style: st.h }, t("settings.backupSection")),
          backupCfg
            ? el("div", { style: { display: "flex", flexDirection: "column", gap: 6 } },
                el("div", { style: st.row },
                  el("span", { style: st.name }, t("settings.backupFolder")),
                  el("span", { className: "dsh140-mono", style: { fontSize: 11, wordBreak: "break-all" } }, String(backupCfg.backupRoot || ""))),
                el("div", { className: "dsh140-mut" }, t("settings.backupFolderHint")),
                el("div", { style: st.row },
                  el("input", { style: { flex: 1, minWidth: 0, background: "transparent", border: "1px solid rgba(128,128,128,.4)", borderRadius: 6, padding: "4px 8px", fontSize: 12, color: "inherit" }, value: backupPath, onChange: (e) => setBackupPath(e.target.value), onKeyDown: (e) => { if (e.key === "Enter") saveBackupRoot(); }, placeholder: String(backupCfg.backupRoot || "") }),
                  el("button", { className: "dsh140-btn", onClick: browseBackupRoot, disabled: backupBusy }, backupBusy ? t("settings.updatingShort") : t("settings.backupBrowse")),
                  el("button", { className: "dsh140-btn", onClick: openBackupFolder, disabled: backupBusy }, t("settings.backupOpen"))),
                el("div", { style: st.row },
                  el("span", { className: "dsh140-mut" }, t("settings.backupCounts", { main: backupCfg.mainCount || 0, plugin: backupCfg.pluginCount || 0 })),
                  el("span", { style: { flex: 1 } }),
                  el("button", { className: "dsh140-btn", onClick: clearBackups, disabled: backupBusy, style: { borderColor: "rgba(248,113,113,.5)", color: "#f87171" } }, t("settings.clearBackups"))))
            : el("div", { style: st.muted }, t("settings.updating"))));
    }

    // ── 横幅拖拽：按住标题/空白处拖动（按钮与滚动列表内不触发）──
    function startBannerDrag(el, e) {
      const startX = e.clientX;
      const startY = e.clientY;
      const r = el.getBoundingClientRect();
      const origLeft = r.left;
      const origTop = r.top;
      const onMove = (ev) => {
        el.style.left = Math.max(0, origLeft + (ev.clientX - startX)) + "px";
        el.style.top = Math.max(0, origTop + (ev.clientY - startY)) + "px";
        el.style.transform = "none";
        ev.preventDefault();
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      e.preventDefault();
    }

    function onBannerMouseDown(e) {
      const banner = e.target && e.target.closest ? e.target.closest(".dsh-update-banner, .dsh-plugin-banner") : null;
      if (!banner) return;
      if (e.target.closest && e.target.closest("button, a, input, textarea, .dsh-plugin-list, .dsh-plugin-results")) return;
      startBannerDrag(banner, e);
    }

    function apply(ctx) {
      ctx.effect(() => {
        if (typeof document === "undefined") return;
        document.addEventListener("mousedown", onBannerMouseDown);
        return () => document.removeEventListener("mousedown", onBannerMouseDown);
      });
      ctx.inject(["slots"], (scope) => {
        const locale = ctx.get("locale");
        if (locale !== undefined) {
          ctx.effect(
            () => locale.register(NS, { zh: ZH, en: EN }),
            "dsh-update-checker: dictionaries"
          );
        }
        // 侧边栏标签必须用 locale.bind(NS) 翻译函数（调用时读活跃 locale），
        // 不能用 fallbackT（永远命中中文词典）——否则「检查更新」不随界面语言切换。
        const sectionT = locale !== undefined ? locale.bind(NS) : fallbackT;
        // 主程序横幅（top:64px）
        const optsMain = { name: "shell.overlay", id: "dsh-update-checker", order: 1000 };
        if (locale !== undefined) optsMain.locale = NS;
        scope.slots.inject("shell.overlay", () =>
          scope.slots.register(optsMain, UpdateBanner)
        );
        // 插件横幅（top:64px，与主程序横幅同位）
        const optsPlugin = { name: "shell.overlay", id: "dsh-update-checker-plugins", order: 1001 };
        if (locale !== undefined) optsPlugin.locale = NS;
        scope.slots.inject("shell.overlay", () =>
          scope.slots.register(optsPlugin, PluginBanner)
        );
        // 设置页「检查更新」
        const optsSection = { name: "settings.section", id: "dsh-update-checker", order: 40, label: () => sectionT("settings.label") };
        if (locale !== undefined) optsSection.locale = NS;
        scope.slots.inject("settings.section", () =>
          scope.slots.register(optsSection, SettingsSection)
        );
      });
    }
    exports.apply = apply;
    exports.inject = ["slots"];
    return module.exports;
  },
});
