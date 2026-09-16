
import { readFileSync } from "node:fs";

const clientUrl = new URL("../lib/client.js", import.meta.url);
const source = readFileSync(clientUrl, "utf8");

let captured = null;
globalThis.window = {
  __ModuleLoader__: {
    load(def) {
      captured = def;
    },
  },
  location: { reload() {} },
};
globalThis.document = {
  querySelector: () => ({}),
  createElement: () => ({ dataset: {}, style: {} }),
  head: { appendChild() {} },
  addEventListener() {},
  removeEventListener() {},
};

await import(clientUrl.href);
if (!captured) {
  console.error("FAIL the client bundle did not register itself with window.__ModuleLoader__");
  process.exit(1);
}

const NS = "dsh-update-checker";
const fakeReact = {
  useState: (v) => [typeof v === "function" ? v() : v, () => {}],
  useEffect: () => {},
  useRef: (v) => ({ current: v }),
  createElement: () => null,
  Fragment: {},
};
const exportsObj = captured.factory((id) => (id === "react" ? fakeReact : {}));

function drive(available) {
  const calls = { dictionaries: [], slots: [], effects: [] };
  const localeSvc = {
    register(ns, dict) {
      calls.dictionaries.push({ ns, langs: Object.keys(dict) });
      return () => {};
    },
    bind: () => (key) => key,
  };
  const ctx = {
    effect(fn, name) {
      calls.effects.push(name || "(anon)");
      const disposer = fn();
      return typeof disposer === "function" ? disposer : () => {};
    },
    inject(names, cb) {
      if (names.every((n) => available.includes(n))) {
        cb({
          slots: {
            inject(_slot, fn) {
              return fn();
            },
            register(opts) {
              calls.slots.push(`${opts.id}@${opts.name}#locale=${opts.locale || "-"}`);
              return () => {};
            },
          },
          get: (n) => (n === "locale" ? localeSvc : undefined),
        });
      }
      return () => {};
    },
    get: (n) => (n === "locale" && available.includes("locale") ? localeSvc : undefined),
  };
  exportsObj.apply(ctx);
  return calls;
}

let failed = 0;
const check = (name, cond, detail) => {
  if (cond) {
    console.log(`OK   ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL ${name}${detail ? " — " + detail : ""}`);
  }
};

const withLocale = drive(["slots", "locale"]);
check("apply registers the ZH/EN dictionaries once the locale service is present", withLocale.dictionaries.length === 1 && withLocale.dictionaries[0].langs.join(",") === "zh,en", JSON.stringify(withLocale.dictionaries));
check("apply binds all three slot registrations to the locale namespace", withLocale.slots.length === 3 && withLocale.slots.every((s) => s.includes("locale=dsh-update-checker")), JSON.stringify(withLocale.slots));

const slotsOnly = drive(["slots"]);
check("issue #22/#23: without the locale service the slots are NOT registered (no fallbackT() UI)", slotsOnly.slots.length === 0, JSON.stringify(slotsOnly.slots));

check("issue #20: the transient-failure reload probe is gone", !/\bgone\b/.test(source) && !source.includes("setInterval(probe, 1500)"));
check("issue #20: reload is driven by the server instance id", source.includes("useInstanceReloadProbe") && source.includes("data.instanceId"));
check("issue #21: the two suppress buttons no longer write each other's flag", source.includes("postJson(SETTINGS_URL, { suppressUpToDate: true })") && source.includes("postJson(SETTINGS_URL, { suppressPluginBanner: true })") && !source.includes("suppressUpToDate: true, suppressPluginBanner: true"));
check("issue #25: a stale progress record never resumes the banner", source.includes("function isLiveProgress") && source.includes("if (isLiveProgress(p))"));
check("issue #18: the updating banner tells users the page can be closed", source.includes("banner.safeNote") && source.includes("关闭此页面不会中断更新"));

const hostSource = readFileSync(new URL("../lib/index.js", import.meta.url), "utf8");
const workerSource = readFileSync(new URL("../scripts/main-update-worker.mjs", import.meta.url), "utf8");
check("progress: the old frozen ticker (cap at 8%) is gone from the worker", !workerSource.includes("Math.min(8, 4 + Math.floor(waited / 30))"));
check("progress: the worker now creeps through every phase", workerSource.includes("startProgressTicker"));
check("progress: the stop-service milestone follows the download creep instead of a 6%->64% jump", workerSource.includes("percent: 58") && !workerSource.includes("percent: 64 });"));
check("progress: npm install no longer counts against a hardcoded 587 packages", !workerSource.includes("const total = 587"));
check("issue #18: the worker observes the restart instead of failing immediately", workerSource.includes("restart-pending") && workerSource.includes("RESTART_EXTRA_WINDOW_MS"));
check("issue #25: the host reconciles stale progress and stale locks at startup", hostSource.includes("reconcileStaleUpdateState(") && hostSource.includes("reconcileStaleUpdateLock()"));
check("issue #21: plugin replacement stages first, then swaps by rename", hostSource.includes("swapDirectoryInPlace") && !/await rm\(dst, \{ recursive: true, force: true \}\);\n  \}\n  await mkdir\(dirname\(dst\)/.test(hostSource));
check("issue #24: POSIX one-click core updates fail fast", hostSource.includes("mainUpdatePlatformError"));

console.log(failed === 0 ? "\nCLIENT/HOST SOURCE VERIFY: PASS" : `\nCLIENT/HOST SOURCE VERIFY: ${failed} FAILURE(S)`);
process.exitCode = failed === 0 ? 0 : 1;
