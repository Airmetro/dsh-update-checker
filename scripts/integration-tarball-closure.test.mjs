import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";

const TARGET = "2.0.0";

const PACKAGES = {
  "@deepseek-ai/dsh": {
    "2.0.0": {
      dependencies: {
        "@deepseek-ai/aaa": "2.0.0",
        "@deepseek-ai/newpkg": "2.0.0",
        "third-x": "^1.2.0",
        "third-y": "~2.0.1",
        "native-build": "2.0.0",
      },
    },
  },
  "@deepseek-ai/aaa": {
    "2.0.0": { dependencies: { "@deepseek-ai/bbb": "2.0.0", "@deepseek-ai/newpkg2": "2.0.0" } },
  },
  "@deepseek-ai/bbb": { "2.0.0": { dependencies: { "third-y": "~2.0.1" } } },
  "@deepseek-ai/newpkg": { "2.0.0": { dependencies: { "jsbi-like": "4.3.2", "@deepseek-ai/newpkg3": "2.0.0" } } },
  "@deepseek-ai/newpkg2": { "2.0.0": {} },
  "@deepseek-ai/newpkg3": {
    "2.0.0": { dependencies: { "@scope/deep": "1.0.0" }, optionalDependencies: { "@scope/mips-only": "1.0.0" } },
  },
  "@scope/deep": { "1.0.0": {} },
  "@scope/mips-only": { "1.0.0": { cpu: ["mips"] } },
  "jsbi-like": { "4.3.2": {} },
  "third-x": { "1.2.0": {}, "1.2.5": {}, "1.3.0": {} },
  "third-y": { "2.0.0": {}, "2.0.1": {} },
  "native-build": { "1.0.0": {}, "2.0.0": { scripts: { postinstall: "node build.js" } } },
};

const INSTALLED = [
  ["@deepseek-ai/dsh", "1.0.0"],
  ["@deepseek-ai/aaa", "1.0.0"],
  ["@deepseek-ai/bbb", "1.0.0"],
  ["third-x", "1.2.5"],
  ["third-y", "2.0.0"],
  ["native-build", "1.0.0"],
];

function tarEntry(name, data) {
  const buf = Buffer.alloc(512);
  buf.write(name.slice(0, 100), 0, "utf8");
  buf.write("0000644\0", 100, "utf8");
  buf.write("0000000\0", 108, "utf8");
  buf.write("0000000\0", 116, "utf8");
  buf.write((data ? data.length : 0).toString(8).padStart(11, "0") + "\0", 124, "utf8");
  buf.write("00000000000\0", 136, "utf8");
  buf[156] = 48;
  buf.fill(0x20, 148, 156);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += buf[i];
  buf.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "utf8");
  const out = [buf];
  if (data) {
    const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512);
    data.copy(padded);
    out.push(padded);
  }
  return Buffer.concat(out);
}

function tarballFor(name, version) {
  if (!PACKAGES[name] || !PACKAGES[name][version]) return null;
  return gzipSync(
    Buffer.concat([
      tarEntry("package/package.json", Buffer.from(JSON.stringify({ name, version }), "utf8")),
      tarEntry("package/index.js", Buffer.from("export default 1;", "utf8")),
      Buffer.alloc(1024),
    ])
  );
}

function reply(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

const requests = [];
const server = http.createServer((req, res) => {
  const raw = new URL(req.url, "http://registry.invalid").pathname.replace(/^\/+/, "");
  const parts = raw.split("/").map((s) => decodeURIComponent(s));
  requests.push(parts.join("/"));
  if (parts.length === 3 && parts[1] === "-") {
    const name = parts[0];
    const short = name.split("/").pop();
    const m = new RegExp(`^${short.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-(.+)\\.tgz$`).exec(parts[2]);
    const buf = m ? tarballFor(name, m[1]) : null;
    if (!buf) return reply(res, 404, "no tarball");
    res.writeHead(200, { "content-type": "application/octet-stream" });
    res.end(buf);
    return;
  }
  if (parts.length === 2) {
    const manifest = PACKAGES[parts[0]] && PACKAGES[parts[0]][parts[1]];
    if (!manifest) return reply(res, 404, "no manifest");
    return reply(res, 200, { name: parts[0], version: parts[1], ...manifest });
  }
  if (parts.length === 1) {
    const versions = PACKAGES[parts[0]];
    if (!versions) return reply(res, 404, "no packument");
    const out = {};
    for (const v of Object.keys(versions)) out[v] = { name: parts[0], version: v, ...versions[v] };
    return reply(res, 200, { versions: out });
  }
  return reply(res, 404, "unknown");
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const base = await mkdtemp(join(tmpdir(), "duc-closure-"));
const root = join(base, "deploy");
const cacheRoot = await mkdtemp(join(tmpdir(), "duc-closure-cache-"));

async function writePkg(name, version, extra = {}) {
  const dir = join(root, "node_modules", name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "package.json"), JSON.stringify({ name, version, ...extra }, null, 2), "utf8");
  await writeFile(join(dir, "index.js"), "export default 1;", "utf8");
}

await mkdir(join(root, "node_modules", "@deepseek-ai"), { recursive: true });
await writeFile(
  join(root, "package.json"),
  JSON.stringify({ name: "app", version: "1.0.0", dependencies: { "@deepseek-ai/dsh": TARGET } }, null, 2),
  "utf8"
);
for (const [name, version] of INSTALLED) await writePkg(name, version);
await writePkg("@deepseek-ai/dsh-web-frontend", TARGET);
await mkdir(join(root, "node_modules", "@deepseek-ai", "dsh-web-frontend", "dist", "assets"), { recursive: true });
await writeFile(
  join(root, "node_modules", "@deepseek-ai", "dsh-web-frontend", "dist", "index.html"),
  '<!doctype html><script src="/assets/app.js"></script>',
  "utf8"
);
await writeFile(join(root, "node_modules", "@deepseek-ai", "dsh-web-frontend", "dist", "assets", "app.js"), "1;", "utf8");

process.env.DSH_UC_UPDATE_ROOT = root;
process.env.DSH_UC_UPDATE_TARGET = TARGET;
process.env.DSH_UC_UPDATE_BACKUP = join(base, "backup");
process.env.DSH_UC_UPDATE_PROGRESS = join(base, "progress.json");
process.env.DSH_UC_UPDATE_OPS = join(base, "ops.log");
process.env.DSH_UC_UPDATE_DSH_HOME = base;
process.env.DSH_UC_UPDATE_NO_RUN = "1";
process.env.DSH_UC_UPDATE_REGISTRY = `http://127.0.0.1:${port}`;

async function versionOf(name) {
  try {
    const pj = JSON.parse(await readFile(join(root, "node_modules", name, "package.json"), "utf8"));
    return pj.version;
  } catch {
    return null;
  }
}

let planned;

test("planTarballUpdate: 注册表不可达时退回本地基线、标记不完整且不抛错", async () => {
  const dead = http.createServer(() => {});
  await new Promise((r) => dead.listen(0, "127.0.0.1", r));
  const deadPort = dead.address().port;
  await new Promise((r) => dead.close(r));
  process.env.DSH_UC_UPDATE_REGISTRY = `http://127.0.0.1:${deadPort}`;
  try {
    const fresh = await import(new URL("./main-update-worker.mjs", import.meta.url).href + `?dead=${deadPort}`);
    const out = await fresh.planTarballUpdate();
    const names = out.items.map((i) => i.name);
    assert.ok(names.includes("@deepseek-ai/dsh"), `基线计划应保留老行为：${names.join(",")}`);
    assert.ok(out.summary.failed.length > 0, JSON.stringify(out.summary));
    assert.equal(out.summary.incomplete, true);
    assert.equal(out.summary.scanned, 1);
  } finally {
    process.env.DSH_UC_UPDATE_REGISTRY = `http://127.0.0.1:${port}`;
  }
});

test("planTarballUpdate: 目标版本的依赖闭包驱动计划（缺失包 + 版本变更）", async () => {
  const worker = await import(new URL("./main-update-worker.mjs", import.meta.url).href + `?plan=${port}`);
  planned = await worker.planTarballUpdate();
  const byName = Object.fromEntries(planned.items.map((i) => [i.name, i]));

  assert.equal(byName["@deepseek-ai/dsh"].version, "2.0.0");
  assert.equal(byName["@deepseek-ai/dsh"].action, "update");
  assert.equal(byName["@deepseek-ai/aaa"].action, "update");
  assert.equal(byName["@deepseek-ai/bbb"].action, "update");

  assert.equal(byName["@deepseek-ai/newpkg"].action, "install");
  assert.equal(byName["@deepseek-ai/newpkg2"].action, "install");
  assert.equal(byName["@deepseek-ai/newpkg3"].action, "install");
  assert.equal(byName["@scope/deep"].action, "install");
  assert.equal(byName["jsbi-like"].version, "4.3.2");
  assert.equal(byName["third-y"].version, "2.0.1");
  assert.equal(byName["third-x"], undefined);

  assert.equal(byName["native-build"], undefined);
  assert.ok(planned.summary.skippedBuild.includes("native-build"), JSON.stringify(planned.summary));
  assert.ok(planned.summary.skippedPlatform.includes("@scope/mips-only"), JSON.stringify(planned.summary));
  assert.deepEqual(planned.summary.failed, []);
  assert.equal(planned.summary.incomplete, false);
  assert.equal(planned.summary.planned, 9);

  const cacheDir = join(cacheRoot, `run-${Date.now()}`);
  await mkdir(cacheDir, { recursive: true });
  const dl = await worker.downloadTarballsToCache(planned.items, cacheDir, null);
  assert.deepEqual(dl.failed, []);
  assert.equal(dl.skipped.length, 0);

  const ex = await worker.extractTreeFromCache(cacheDir, null);
  assert.deepEqual(ex.failed, []);

  assert.equal(await versionOf("@deepseek-ai/dsh"), "2.0.0");
  assert.equal(await versionOf("@deepseek-ai/aaa"), "2.0.0");
  assert.equal(await versionOf("@deepseek-ai/bbb"), "2.0.0");
  assert.equal(await versionOf("@deepseek-ai/newpkg"), "2.0.0");
  assert.equal(await versionOf("@deepseek-ai/newpkg2"), "2.0.0");
  assert.equal(await versionOf("@deepseek-ai/newpkg3"), "2.0.0");
  assert.equal(await versionOf("@scope/deep"), "1.0.0");
  assert.equal(await versionOf("jsbi-like"), "4.3.2");
  assert.equal(await versionOf("third-y"), "2.0.1");
  assert.equal(await versionOf("third-x"), "1.2.5");
  assert.equal(await versionOf("native-build"), "1.0.0");
  assert.equal(await versionOf("@scope/mips-only"), null);

  assert.ok(!requests.some((p) => p.startsWith("third-x/-/")), "满足范围的包不应下载 tarball");
  assert.ok(!requests.some((p) => p.startsWith("native-build/-/")), "被跳过的包不应下载 tarball");
  assert.ok(requests.some((p) => p.includes("newpkg/-/")), "新增包必须被下载");
});

test("verifyTree: 闭包完整性校验捕获漏装，恢复后通过", async () => {
  const worker = await import(new URL("./main-update-worker.mjs", import.meta.url).href + `?verify=${port}`);
  const expectations = worker.closureExpectations(planned.closure);
  const good = await worker.verifyTree(expectations);
  assert.equal(good.ok, true, JSON.stringify(good.problems));

  const victim = join(root, "node_modules", "@deepseek-ai", "newpkg");
  const saved = await readFile(join(victim, "package.json"), "utf8");
  await rm(victim, { recursive: true, force: true });

  const bad = await worker.verifyTree(expectations);
  assert.equal(bad.ok, false);
  assert.ok(
    bad.problems.some((p) => p.includes("@deepseek-ai/newpkg") && p.includes("missing")),
    JSON.stringify(bad.problems)
  );

  await mkdir(victim, { recursive: true });
  await writeFile(join(victim, "package.json"), saved, "utf8");
  const restored = await worker.verifyTree(expectations);
  assert.equal(restored.ok, true, JSON.stringify(restored.problems));
});

test("registryTarballUrl / planFileName: scoped 与 unscoped 形态正确", async () => {
  const worker = await import(new URL("./main-update-worker.mjs", import.meta.url).href + `?urls=${port}`);
  assert.equal(
    worker.registryTarballUrl("@deepseek-ai/dsh", "0.1.7-rc.2"),
    `http://127.0.0.1:${port}/@deepseek-ai%2Fdsh/-/dsh-0.1.7-rc.2.tgz`
  );
  assert.equal(worker.registryTarballUrl("jsbi", "4.3.2"), `http://127.0.0.1:${port}/jsbi/-/jsbi-4.3.2.tgz`);
  assert.equal(worker.planFileName("@scope/pkg", "1.0.0"), "_scope_pkg-1.0.0.tgz");
  assert.equal(worker.fixedVersion("0.1.7-rc.2"), "0.1.7-rc.2");
  assert.equal(worker.fixedVersion("^1.2.3"), null);
  assert.equal(worker.highestSatisfying(["1.2.0", "1.2.5", "1.3.0"], "^1.2.0"), "1.3.0");
  assert.equal(worker.highestSatisfying(["1.2.0", "1.2.5", "1.3.0"], "~1.2.1"), "1.2.5");
  assert.equal(worker.highestSatisfying(["1.2.0", "1.3.0", "2.0.0"], "^1.2.0"), "1.3.0");
  assert.equal(worker.highestSatisfying(["0.1.7-rc.1", "0.1.7-rc.2"], "^0.1.7-rc.1"), "0.1.7-rc.2");
});

test.after(async () => {
  await new Promise((r) => server.close(r));
  await rm(base, { recursive: true, force: true });
  await rm(cacheRoot, { recursive: true, force: true });
});
