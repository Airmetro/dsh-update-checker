import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const clientUrl = new URL("../lib/client.js", import.meta.url);
const source = readFileSync(clientUrl, "utf8");

let captured = null;
const styleTag = { dataset: {}, style: {}, textContent: "" };

globalThis.window = {
  __ModuleLoader__: { load(def) { captured = def; } },
  location: { protocol: "http:", reload() {} },
  dshDesktop: null,
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
    useRef(v) { return { current: v }; },
    createElement(type, props, ...children) { return { type, props: props || {}, children: children.flat() }; },
    Fragment: "Fragment",
  };
}

function collectStrings(node, out = []) {
  if (typeof node === "string") { out.push(node); return out; }
  if (node === null || node === undefined || typeof node !== "object") return out;
  for (const child of Array.isArray(node.children) ? node.children : []) collectStrings(child, out);
  return out;
}

function pluginPayload(runtime) {
  return {
    checkedAt: Date.now(),
    plugins: [
      { name: "dshmarket", installed: "1.66.44", latest: "1.66.44", hasUpdate: false, dir: "C:\\Users\\x\\.dsh\\profiles\\web\\node_modules\\dshmarket" },
      { name: "dsh-cost-meter", installed: "1.9.15", latest: "1.9.16", hasUpdate: true, dir: "C:\\Users\\x\\.dsh\\profiles\\web\\node_modules\\dsh-cost-meter" },
    ],
    excluded: [],
    ignored: [],
    platform: "web",
    runtime,
  };
}

function renderSettings(payload) {
  let section = null;
  const slots = {
    inject(_slot, fn) { return fn(); },
    register(opts, component) {
      if (opts.name === "settings.section" && opts.id === "dsh-update-checker") section = component;
      return () => {};
    },
  };
  const ctx = {
    get: () => undefined,
    effect: () => () => {},
    inject(names, cb) {
      if (names.includes("slots")) cb({ slots, get: () => undefined });
      return () => {};
    },
  };
  const states = [null, payload, null, null, false, null, [], 0, [], 0, null, null, "", false, null];
  const exportsObj = captured.factory((id) => (id === "react" ? makeReact(states) : {}));
  exportsObj.apply(ctx);
  assert.ok(section, "settings section registered");
  return collectStrings(section({ t: (key, params) => (params ? `${key} ${JSON.stringify(params)}` : key) }));
}

test("isolated 布局：设置面板显示 profile 布局提示，插件行照常渲染", () => {
  const texts = renderSettings(pluginPayload({ platform: "web", managedBy: "npm", profileLinker: "isolated", warnings: [{ code: "profile-isolated-linker" }] }));
  assert.ok(texts.includes("settings.profileLinkerHint"), JSON.stringify(texts));
  assert.ok(texts.includes("dshmarket"), "插件行仍然渲染");
  assert.ok(texts.includes("dsh-cost-meter"), "插件行仍然渲染");
});

test("hoisted 布局：不显示布局提示", () => {
  const texts = renderSettings(pluginPayload({ platform: "web", managedBy: "npm", profileLinker: "hoisted", warnings: [] }));
  assert.equal(texts.some((s) => s.includes("profileLinkerHint")), false, JSON.stringify(texts));
  assert.ok(texts.includes("dshmarket"));
});

test("旧版宿主没有 runtime 块：不报错也不显示提示", () => {
  const texts = renderSettings(pluginPayload(undefined));
  assert.equal(texts.some((s) => s.includes("profileLinkerHint")), false);
  assert.ok(texts.includes("dshmarket"));
});

test("两份语言字典都带上了该提示文案", () => {
  assert.match(source, /"settings\.profileLinkerHint":\s*"[^"]*isolated/);
  const occurrences = [...source.matchAll(/^\s*"settings\.profileLinkerHint":/gm)].length;
  assert.equal(occurrences, 2, "zh 与 en 各一条");
});
