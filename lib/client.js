// dsh-update-checker — Client half (web module bundle, ModuleLoader format). v1.1.0
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
        ".dsh-update-title{font-weight:600;margin-bottom:2px;}" +
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
        ".dsh-plugin-title{font-weight:600;margin-bottom:4px;}" +
        ".dsh-plugin-list{margin:4px 0 8px;max-height:180px;overflow:auto;}" +
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
        ".dsh-plugin-spacer{flex:1;}";
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
      "plugin.updateOk": "{name} 更新成功（{version}）",
      "plugin.updateFail": "{name} 更新失败：{error}",
      "plugin.allDone": "全部插件已更新到最新版",
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
      "plugin.updateOk": "{name} updated ({version})",
      "plugin.updateFail": "{name} update failed: {error}",
      "plugin.allDone": "All plugins are up to date now",
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

      const suppressNow = () => {
        postJson(SUPPRESS_URL)
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
        setResults([]);
        const results = [];
        const run = (i) => {
          if (i >= updatable.length) {
            busy = false;
            setUpdatingName(null);
            setResults(results);
            runCheck(true);
            return;
          }
          const p = updatable[i];
          setUpdatingName(p.name);
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
        postJson(PLUGIN_SUPPRESS_URL)
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

      // 更新中
      if (updatingName) {
        return react.createElement(
          "div",
          { className: "dsh-plugin-banner" },
          react.createElement(
            "div",
            { className: "dsh-plugin-body" },
            react.createElement("div", { className: "dsh-plugin-title" }, t("plugin.updating", { name: updatingName }))
          )
        );
      }

      // 更新结果反馈
      if (results.length > 0) {
        const okCount = results.filter((r) => r.ok).length;
        const failCount = results.length - okCount;
        return react.createElement(
          "div",
          { className: "dsh-plugin-banner" },
          react.createElement(
            "div",
            { className: "dsh-plugin-body" },
            react.createElement(
              "div",
              { className: "dsh-plugin-title " + (failCount > 0 ? "dsh-plugin-fail" : "dsh-plugin-ok") },
              failCount > 0 ? t("plugin.someFailed", { ok: okCount, fail: failCount }) : t("plugin.allDone")
            ),
            results.map((r) =>
              react.createElement(
                "div",
                { key: r.name, className: "dsh-plugin-detail " + (r.ok ? "dsh-plugin-ok" : "dsh-plugin-fail") },
                r.ok ? t("plugin.updateOk", { name: r.name, version: r.version }) : t("plugin.updateFail", { name: r.name, error: r.error })
              )
            ),
            react.createElement(
              "div",
              { className: "dsh-plugin-actions" },
              react.createElement(
                "button",
                { className: "dsh-plugin-btn", onClick: () => { setResults([]); setDismissed(true); } },
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

    function apply(ctx) {
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
      });
    }
    exports.apply = apply;
    exports.inject = ["slots"];
    return module.exports;
  },
});
