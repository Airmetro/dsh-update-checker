// dsh-update-checker — Client half (web module bundle, ModuleLoader format). v1.4.0
// 已合并 dsh-plugin-checker：页面加载同时检查
//   A) 主程序更新（/dsh-update-checker/status.json）→ 主程序横幅（顶部 top:16px）
//   B) 第三方插件更新（/dsh-update-checker/plugins.json）→ 插件横幅（top:96px，错开）
// 插件横幅列出可更新插件（单个更新/全部更新），逐条反馈"更新成功/更新失败"。
// 每 6 小时自动复查；重新检查走 ?fresh=1 强制刷新。i18n 跟随界面语言（zh/en，其余回退中文）。
window.__ModuleLoader__.load({
  id: "dsh-update-checker",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let react = require("react");

    // ── 样式注入（幂等；主程序横幅 top:16px，插件横幅 top:96px 避免重叠）──
    if (
      typeof document !== "undefined" &&
      document.querySelector('style[data-plugin-css="dsh-update-checker"]') === null
    ) {
      const tag = document.createElement("style");
      tag.dataset.plugin = "dsh-update-checker";
      tag.dataset.pluginCss = "dsh-update-checker";
      tag.textContent =
        ".dsh-update-banner{position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:9999;pointer-events:auto;max-width:min(560px,calc(100vw - 32px));background:var(--dsw-alias-bg-overlay,#1f2937);color:var(--dsw-alias-label-primary,#f3f4f6);border:1px solid var(--dsw-alias-border-l2,#374151);border-radius:10px;padding:12px 16px;box-shadow:0 8px 24px rgba(0,0,0,.35);font-size:13px;line-height:1.5;}" +
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
        ".dsh-plugin-banner{position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:9998;pointer-events:auto;max-width:min(560px,calc(100vw - 32px));background:var(--dsw-alias-bg-overlay,#1f2937);color:var(--dsw-alias-label-primary,#f3f4f6);border:1px solid var(--dsw-alias-border-l2,#374151);border-radius:10px;padding:12px 16px;box-shadow:0 8px 24px rgba(0,0,0,.35);font-size:13px;line-height:1.5;}" +
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
        ".dsh-plugin-spacer{flex:1;}" +
        ".dsh-plugin-results{margin:4px 0 8px;max-height:min(45vh,360px);overflow-y:auto;scrollbar-width:thin;scrollbar-color:rgba(148,163,184,.5) transparent;padding-right:4px;}" +
        ".dsh-plugin-list::-webkit-scrollbar,.dsh-plugin-results::-webkit-scrollbar{width:8px;}" +
        ".dsh-plugin-list::-webkit-scrollbar-thumb,.dsh-plugin-results::-webkit-scrollbar-thumb{background:rgba(148,163,184,.4);border-radius:4px;}" +
        ".dsh-plugin-list::-webkit-scrollbar-thumb:hover,.dsh-plugin-results::-webkit-scrollbar-thumb:hover{background:rgba(148,163,184,.7);}" +
        ".dsh-plugin-list::-webkit-scrollbar-track,.dsh-plugin-results::-webkit-scrollbar-track{background:transparent;}" +
        ".dsh-toggle{position:relative;display:inline-block;width:36px;height:20px;border-radius:10px;background:rgba(128,128,128,.45);cursor:pointer;transition:background .2s;flex:none;border:none;outline:none;vertical-align:middle;}" +
        ".dsh-toggle::after{content:'';position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.3);transition:left .2s;}" +
        ".dsh-toggle.on{background:#34d399;}" +
        ".dsh-toggle.on::after{left:18px;}";
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
    const ROLLBACK_URL = "/dsh-update-checker/rollback";
    const PLUGIN_ROLLBACK_URL = "/dsh-update-checker/plugin-rollback";
    const BACKUPS_URL = "/dsh-update-checker/backups.json";
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
      "settings.updatedTo": "已更新到 v{v}",
      "settings.updateFailed": "更新失败",
      "settings.restartHint": "（重启 dsh web 后生效）",
      "settings.queued": "（还有 {n} 个排队）",
      "settings.updatingShort": "更新中…",
      "settings.queuedBtn": "已排队",
      "settings.rollback": "回滚",
      "settings.rollbackConfirm": "将把主程序回滚到备份中的 v{v}（先做现场快照），确定继续？",
      "settings.rollbackOk": "已回滚到 v{v}",
      "settings.rollbackFail": "回滚失败：{error}",
      "settings.pluginRollbackConfirm": "将把 {name} 回滚到备份版本，确定继续？",
      "settings.noBackup": "（无备份）",
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
      "settings.updatedTo": "Updated to v{v}",
      "settings.updateFailed": "Update failed",
      "settings.restartHint": " (restart dsh web to take effect)",
      "settings.queued": "({n} queued)",
      "settings.updatingShort": "Updating…",
      "settings.queuedBtn": "Queued",
      "settings.rollback": "Rollback",
      "settings.rollbackConfirm": "Roll the main program back to v{v} from the backup (a safety snapshot is taken first)?",
      "settings.rollbackOk": "Rolled back to v{v}",
      "settings.rollbackFail": "Rollback failed: {error}",
      "settings.pluginRollbackConfirm": "Roll {name} back to the backed-up version?",
      "settings.noBackup": "(no backup)",
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

    // ═══════════════ 主程序横幅 ═══════════════
    function UpdateBanner(props) {
      const t = props.t || fallbackT;
      const [state, setState] = react.useState({
        status: "checking",
        data: null,
        error: null,
      });
      const [dismissed, setDismissed] = react.useState(false);

      const runCheck = (force) => {
        if (busy) return;
        setState({ status: "checking", data: null, error: null });
        fetchStatus(STATUS_URL, force)
          .then((data) => setState({ status: "done", data, error: null }))
          .catch((err) => {
            console.error("[dsh-update-checker] check failed", err);
            setState({ status: "error", data: null, error: String(err && err.message ? err.message : err) });
          });
      };

      const startUpdate = () => {
        if (typeof window !== "undefined" && !window.confirm(t("banner.confirmUpdate"))) return;
        busy = true;
        setState({ status: "updating", data: state.data, error: null });
        postJson(UPDATE_URL)
          .then((res) => {
            if (!res || !res.ok) throw new Error((res && res.error) || "update failed");
            return postJson(RESTART_URL);
          })
          .then((res) => {
            if (!res || !res.ok) throw new Error((res && res.error) || "restart failed");
            setState({ status: "restarting", data: null, error: null });
          })
          .catch((err) => {
            busy = false;
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
        return () => clearInterval(timer);
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

      // 点过"知道了/确定"后：若复查发现新版本仍要显示更新横幅；仅在无更新时保持关闭。
      if (dismissed && !(state.status === "done" && d && d.hasUpdate)) return null;

      // 更新中 / 重启中：显示进度横幅（无按钮）
      if (state.status === "updating" || state.status === "restarting") {
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
              state.status === "updating" ? t("banner.updating") : t("banner.restarting")
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

      const runCheck = (force) => {
        if (busy) return;
        setState({ status: "checking", data: null, error: null });
        fetchStatus(PLUGIN_STATUS_URL, force)
          .then((data) => setState({ status: "done", data, error: null }))
          .catch((err) => {
            console.error("[dsh-update-checker] plugin check failed", err);
            setState({ status: "error", data: null, error: String(err && err.message ? err.message : err) });
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
            setUpdatingName(null);
            setProgress(null);
            setResults(results);
            runCheck(true);
            return;
          }
          const p = updatable[i];
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
              results.map((r) =>
                react.createElement(
                  "div",
                  { key: r.name, className: "dsh-plugin-detail " + (r.ok ? "dsh-plugin-ok" : "dsh-plugin-fail") },
                  r.ok ? t("plugin.updateOk", { name: r.name, version: r.version }) : t("plugin.updateFail", { name: r.name, error: r.error })
                )
              )
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

      const syncQueueState = () => {
        setQueuedNames(queueRef.current.map((t) => t.name));
        setQueuedCount(queueRef.current.length);
      };

      // 串行队列：连续点击多个"更新"会排队（点击即入队，无确认弹窗打断）；前一个完成才执行下一个
      const processNext = () => {
        const task = queueRef.current.shift();
        syncQueueState();
        if (!task) { updatingRef.current = null; setUpdating(null); setTotal(0); load(); return; }
        updatingRef.current = task.name;
        setUpdating(task.name);
        postJson(task.type === "main" ? UPDATE_URL : PLUGIN_UPDATE_URL, task.type === "main" ? {} : { name: task.name })
          .then((r) => {
            if (r && r.ok) {
              const restartNote = task.type === "main" ? t("settings.restartHint") : "";
              setResults((prev) => [...prev, { name: task.name, ok: true, text: t("settings.updatedTo", { v: r.installed || "?" }) + restartNote }]);
              // 单个完成立即刷新行内状态（绿灯/按钮消失），不等全部完成
              if (task.type === "main") {
                setCore((prev) => (prev ? { ...prev, installed: r.installed || prev.installed, hasUpdate: false } : prev));
              } else {
                setPlugs((prev) => (prev ? { ...prev, plugins: (prev.plugins || []).map((p) => (p.name === task.name ? { ...p, installed: r.installed || p.installed, hasUpdate: false } : p)) } : prev));
              }
            } else {
              setResults((prev) => [...prev, { name: task.name, ok: false, text: (r && r.error) || t("settings.updateFailed") }]);
            }
          })
          .catch((e) => setResults((prev) => [...prev, { name: task.name, ok: false, text: String((e && e.message) || e) }]))
          .finally(() => { updatingRef.current = null; setUpdating(null); processNext(); });
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
        ])
          .then(([c, p, s, b]) => { setCore(c); setPlugs(p); setSettings(s); setBackups(b); })
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
      const lamp = (on) => el("span", { style: { ...st.dot, background: on ? "#eab308" : "#34d399" }, title: on ? t("settings.hasUpdate") : t("settings.upToDate") });

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
            lamp(core.hasUpdate),
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
              lamp(p.hasUpdate),
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
      const notifyOn = !!(settings && settings.notifyEnabled !== false && !(settings.suppressUpToDate || settings.suppressPluginBanner));
      const toggles = settings
        ? [
            toggleSwitch(t("settings.floating"), settings.floatingEnabled !== false, () => saveSetting({ floatingEnabled: !(settings.floatingEnabled !== false) })),
            toggleSwitch(t("settings.notify"), notifyOn, () => {
              if (notifyOn) saveSetting({ notifyEnabled: false });
              else saveSetting({ notifyEnabled: true, suppressUpToDate: false, suppressPluginBanner: false });
            }),
          ]
        : [];

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

      const msgBox = results.length > 0 || updating
        ? el("div", { style: { marginTop: 4, border: updating ? "1px solid rgba(79,140,255,.45)" : "1px solid rgba(128,128,128,.25)", borderRadius: 6, padding: "8px 10px", background: updating ? "rgba(79,140,255,.07)" : "transparent", display: "flex", flexDirection: "column", gap: 2 } },
            updating
              ? el("div", { style: { color: "#4f8cff", fontSize: 12, fontWeight: 600 } },
                  t("plugin.updating", { name: updating }) +
                  (total > 1 ? "（" + results.length + "/" + total + "）" : "") +
                  (queuedCount > 0 ? " " + t("settings.queued", { n: queuedCount }) : ""))
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
          err ? el("div", { style: st.err }, "错误：" + err) : null));
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
        // 主程序横幅（top:16px）
        const optsMain = { name: "shell.overlay", id: "dsh-update-checker", order: 1000 };
        if (locale !== undefined) optsMain.locale = NS;
        scope.slots.inject("shell.overlay", () =>
          scope.slots.register(optsMain, UpdateBanner)
        );
        // 插件横幅（top:96px，与主程序横幅错开）
        const optsPlugin = { name: "shell.overlay", id: "dsh-update-checker-plugins", order: 1001 };
        if (locale !== undefined) optsPlugin.locale = NS;
        scope.slots.inject("shell.overlay", () =>
          scope.slots.register(optsPlugin, PluginBanner)
        );
        // 设置页「检查更新」
        const optsSection = { name: "settings.section", id: "dsh-update-checker", order: 40, label: () => fallbackT("settings.label") };
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
