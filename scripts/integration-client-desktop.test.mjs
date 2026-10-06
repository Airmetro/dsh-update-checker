import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const clientUrl = new URL("../lib/client.js", import.meta.url);
const source = readFileSync(clientUrl, "utf8");

let captured = null;
const styleTag = { dataset: {}, style: {}, textContent: "" };

function installDom(protocol, bridge) {
  globalThis.window = {
    __ModuleLoader__: {
      load(def) {
        captured = def;
      },
    },
    location: { protocol, reload() {} },
    dshDesktop: bridge,
    confirm: () => true,
    alert() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
    sessionStorage: { getItem: () => null, setItem() {} },
  };
  globalThis.document = {
    querySelector: () => styleTag,
    createElement: () => ({ dataset: {}, style: {} }),
    head: { appendChild() {} },
    documentElement: { dataset: {} },
    addEventListener() {},
    removeEventListener() {},
  };
}

installDom("http:", { protocolVersion: 1 });
await import(clientUrl.href);
assert.ok(captured, "client bundle registered with the module loader");

function makeReact(initialStates) {
  let index = 0;
  return {
    useState(init) {
      const i = index++;
      const value = i < initialStates.length ? initialStates[i] : typeof init === "function" ? init() : init;
      return [value, () => {}];
    },
    useEffect() {},
    useRef(v) {
      return { current: v };
    },
    createElement(type, props, ...children) {
      return { type, props: props || {}, children: children.flat() };
    },
    Fragment: "Fragment",
  };
}

function renderClient(initialStates, requireImpl) {
  return captured.factory(requireImpl || ((id) => (id === "react" ? makeReact(initialStates) : {})));
}

function collect(node, out = []) {
  if (node === null || node === undefined || typeof node !== "object") return out;
  out.push(node);
  const kids = Array.isArray(node.children) ? node.children : [];
  for (const child of kids) collect(child, out);
  return out;
}

function buttonLabels(tree) {
  return collect(tree)
    .filter((n) => n.type === "button")
    .map((n) => n.children.filter((c) => typeof c === "string"));
}

function collectStrings(node, out = []) {
  if (typeof node === "string") {
    out.push(node);
    return out;
  }
  if (node === null || node === undefined || typeof node !== "object") return out;
  for (const child of Array.isArray(node.children) ? node.children : []) collectStrings(child, out);
  return out;
}

const DESKTOP_STATUS = {
  checkedAt: Date.now(),
  platform: "desktop",
  installed: "0.2.0-rc.2",
  latest: "0.2.1-alpha.1",
  hasUpdate: true,
  status: "update",
  source: "desktop",
  sourceNote: "desktop nightly feed 0.2.1-alpha.1",
  desktop: {
    channel: "nightly",
    provider: "generic",
    feedUrl: "https://download.deepseek.com/dsh-desk/feeds/win-x64/nightly.yml",
    managedBy: "electron",
  },
  runtime: { platform: "desktop", managedBy: "electron", updateChannel: "nightly" },
  floatingEnabled: true,
  notifyEnabled: true,
  suppressUpToDate: false,
};

const WEB_STATUS = {
  checkedAt: Date.now(),
  platform: "web",
  installed: "0.1.6-alpha.1",
  latest: "0.1.7-alpha.1",
  hasUpdate: true,
  status: "update",
  source: "npm",
  sourceNote: "npm 0.1.7-alpha.1",
  floatingEnabled: true,
  notifyEnabled: true,
  suppressUpToDate: false,
};

function bannerInitialStates(status, nativeState) {
  return [{ status: "done", data: status, error: null }, false, null, nativeState, true, null];
}

before(() => {
  assert.match(source, /function desktopBridge\(\)/);
  assert.match(source, /banner\.openUpdateWindow/);
});

test("desktop page renders the native update action instead of the npm install button", () => {
  const opened = [];
  installDom("dsh-app:", {
    protocolVersion: 1,
    updates: {
      open: () => opened.push("open"),
      status: () => Promise.resolve(null),
      subscribe: () => () => {},
    },
  });

  let banner = null;
  const slots = {
    inject(_slot, fn) {
      return fn();
    },
    register(opts, component) {
      if (opts.name === "shell.overlay" && opts.id === "dsh-update-checker") banner = component;
      return () => {};
    },
  };
  const ctx = {
    effect() {
      return () => {};
    },
    inject(names, cb) {
      if (names.includes("slots")) cb({ slots, get: () => undefined });
      return () => {};
    },
    get: () => undefined,
  };
  const exportsObj = renderClient(bannerInitialStates(DESKTOP_STATUS, null));
  exportsObj.apply(ctx);
  assert.ok(banner, "the overlay banner component is registered");

  const tree = banner({ t: (key) => key });
  const labels = buttonLabels(tree);
  assert.ok(
    labels.some((l) => l.includes("banner.openUpdateWindow")),
    "desktop shows the open-update-window button: " + JSON.stringify(labels)
  );
  assert.ok(
    !labels.some((l) => l.includes("banner.update")),
    "desktop does not show the npm install button"
  );

  const primary = collect(tree).find(
    (n) => n.type === "button" && n.props.className === "dsh-update-btn dsh-update-btn-primary"
  );
  assert.ok(primary, "primary action exists");
  primary.props.onClick();
  assert.deepEqual(opened, ["open"], "clicking the primary action opens the native update window");
  assert.match(source, /banner\.desktopHint/);
});

test("desktop page reports download progress from the application updater", () => {
  installDom("dsh-app:", {
    protocolVersion: 1,
    updates: { open: () => {}, status: () => Promise.resolve(null), subscribe: () => () => {} },
  });
  let banner = null;
  const ctx = {
    effect: () => () => {},
    inject(names, cb) {
      if (names.includes("slots")) {
        cb({
          slots: {
            inject: (_s, fn) => fn(),
            register(opts, component) {
              if (opts.name === "shell.overlay" && opts.id === "dsh-update-checker") banner = component;
              return () => {};
            },
          },
          get: () => undefined,
        });
      }
      return () => {};
    },
    get: () => undefined,
  };
  const exportsObj = renderClient(
    bannerInitialStates(DESKTOP_STATUS, { phase: "downloading", percent: 42, version: "0.2.1-alpha.1" })
  );
  exportsObj.apply(ctx);
  const tree = banner({ t: (key) => key });
  const texts = collectStrings(tree);
  assert.ok(
    texts.some((s) => s.startsWith("banner.desktopDownloading")),
    "progress banner label: " + JSON.stringify(texts)
  );
  assert.ok(
    texts.some((s) => s.includes("0.2.1-alpha.1")),
    "progress banner reports the target version"
  );
  const fill = collect(tree).find((n) => n.props && n.props.className === "dsh140-progress-fill");
  assert.ok(fill, "progress fill rendered");
  assert.equal(fill.props.style.width, "42%");
});

test("web page keeps the npm update action and never calls the desktop bridge", () => {
  installDom("http:", { protocolVersion: 1 });
  const fetchCalls = [];
  globalThis.fetch = (url) => {
    fetchCalls.push(String(url));
    return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ ok: false, error: "stub" }) });
  };
  let banner = null;
  const ctx = {
    effect: () => () => {},
    inject(names, cb) {
      if (names.includes("slots")) {
        cb({
          slots: {
            inject: (_s, fn) => fn(),
            register(opts, component) {
              if (opts.name === "shell.overlay" && opts.id === "dsh-update-checker") banner = component;
              return () => {};
            },
          },
          get: () => undefined,
        });
      }
      return () => {};
    },
    get: () => undefined,
  };
  const exportsObj = renderClient(bannerInitialStates(WEB_STATUS, null));
  exportsObj.apply(ctx);
  const tree = banner({ t: (key) => key });
  const labels = buttonLabels(tree);
  assert.ok(labels.some((l) => l.includes("banner.update")), "web keeps the update button: " + JSON.stringify(labels));
  assert.ok(!labels.some((l) => l.includes("banner.openUpdateWindow")), "web shows no desktop button");

  const primary = collect(tree).find(
    (n) => n.type === "button" && n.props.className === "dsh-update-btn dsh-update-btn-primary"
  );
  assert.ok(primary);
  assert.equal(window.dshDesktop.updates, undefined, "a plain web page has no desktop update bridge");
  primary.props.onClick();
  assert.deepEqual(fetchCalls, ["/dsh-update-checker/update"], "web still posts to the plugin update endpoint");
});
