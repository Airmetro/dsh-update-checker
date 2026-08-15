// dsh-update-checker — Client half (web module bundle, ModuleLoader format).
// 每次启动（页面加载）都轮询 Host 的 /dsh-update-checker/status.json 并显示横幅：
//   有新版本 → 更新横幅（立即更新/重新检查/知道了）；
//   无新版本 → "已是最新版本"横幅（确定 = 本次关闭下次启动再显示；
//              不再提示 = 持久化到 Host，下次启动无更新则不显示）。
// 之后每 6 小时自动复查。横幅文案通过 locale 服务跟随界面语言
// （zh → 中文，en → English，其余回退中文；locale 缺席回退中文词典）。
window.__ModuleLoader__.load({
  id: "dsh-update-checker",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let react = require("react");

    // 自包含样式注入（loader 约定：data-plugin-css 标识，幂等）
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
        ".dsh-update-status{color:var(--dsw-alias-label-secondary,#9ca3af);font-size:12px;}";
      document.head.appendChild(tag);
    }

    const STATUS_URL = "/dsh-update-checker/status.json";
    const UPDATE_URL = "/dsh-update-checker/update";
    const RESTART_URL = "/dsh-update-checker/restart";
    const SUPPRESS_URL = "/dsh-update-checker/suppress";
    const CHECK_INTERVAL = 6 * 60 * 60 * 1000; // 6 小时自动复查

    // ── i18n：词典命名空间与 zh/en 两套文案 ──────────────────────────────
    // 注册项带 locale: NS 时，渲染机制注入 props.t 并随语言切换自动重渲染。
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

    function fetchStatus(force) {
      const url = force ? `${STATUS_URL}?fresh=1` : STATUS_URL;
      return fetch(url, { cache: "no-store" }).then((res) => {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      });
    }

    function postJson(url) {
      return fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      }).then((res) => res.json());
    }

    // 模块级忙碌标记：更新/重启期间暂停定时复查
    let busy = false;

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
        fetchStatus(force)
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
          fetchStatus()
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

    const inject = ["slots"];
    function apply(ctx) {
      ctx.inject(["slots"], (scope) => {
        // 向 DSH locale 服务注册本插件命名空间词典（zh/en）；服务缺席则跳过，
        // 组件回退中文，注册项也不声明 locale（声明而无 locale face 属装配失败）。
        const locale = ctx.get("locale");
        const opts = { name: "shell.overlay", id: "dsh-update-checker", order: 1000 };
        if (locale !== undefined) {
          ctx.effect(
            () => locale.register(NS, { zh: ZH, en: EN }),
            "dsh-update-checker: dictionaries"
          );
          opts.locale = NS;
        }
        scope.slots.inject("shell.overlay", () =>
          scope.slots.register(opts, UpdateBanner)
        );
      });
    }
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
