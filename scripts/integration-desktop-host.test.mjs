import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FEED = `version: 0.2.1-alpha.1
files:
  - url: >-
      http://127.0.0.1/deepseek-harness-0.2.1-alpha.1-win-x64.exe
    sha512: >-
      ZiLxMQd9ESXgktmViW7QwVLcjBR5JIsrNOu+SpelY8kskdSr2H51/f+ey1EqFI/eIIrKQCuRANMeb5SptRZcg==
    size: 289313640
path: >-
  http://127.0.0.1/deepseek-harness-0.2.1-alpha.1-win-x64.exe
sha512: >-
  ZiLxMQd9ESXgktmViW7QwVLcjBR5JIsrNOu+SpelY8kskdSr2H51/f+ey1EqFI/eIIrKQCuRANMeb5SptRZcg==
releaseDate: '2026-10-05T08:00:00.000Z'
`;

const DESKTOP_VERSION = "0.2.0-rc.2";

let base;
let resourcesDir;
let home;
let profileNodeModules;
let server;
let feedHits = 0;
let plugin;

function makeReq(url, body) {
  const req =
    body === undefined
      ? Readable.from([])
      : Readable.from([Buffer.from(JSON.stringify(body), "utf8")]);
  req.url = url;
  req.method = body === undefined ? "GET" : "POST";
  req.socket = { remoteAddress: "127.0.0.1" };
  return req;
}

function makeRes() {
  return {
    statusCode: 0,
    headers: null,
    body: "",
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(chunk) {
      this.body += chunk === undefined ? "" : String(chunk);
    },
  };
}

async function call(registrations, path, body) {
  const route = registrations.find((r) => r.path === path);
  assert.ok(route, "route registered: " + path);
  const res = makeRes();
  await route.handler(makeReq(path, body), res);
  return { status: res.statusCode, headers: res.headers, json: JSON.parse(res.body || "{}") };
}

before(async () => {
  base = await mkdtemp(join(tmpdir(), "duc-desktop-"));
  resourcesDir = join(base, "app", "resources");
  home = base;
  profileNodeModules = join(base, "profiles", "desktop", "node_modules");
  await mkdir(join(resourcesDir, "app.asar", "dsh"), { recursive: true });
  await mkdir(profileNodeModules, { recursive: true });

  await writeFile(
    join(resourcesDir, "app.asar", "package.json"),
    JSON.stringify({ name: "@deepseek-ai/dsh-desktop", version: DESKTOP_VERSION }, null, 2),
    "utf8"
  );
  await writeFile(
    join(resourcesDir, "app.asar", "dsh", "package.json"),
    JSON.stringify({ name: "@deepseek-ai/dsh-desktop-runtime", version: DESKTOP_VERSION }, null, 2),
    "utf8"
  );

  server = createServer((req, res) => {
    if (String(req.url).endsWith("/nightly.yml")) {
      feedHits += 1;
      res.writeHead(200, { "content-type": "text/yaml" });
      res.end(FEED);
      return;
    }
    res.writeHead(404);
    res.end("nope");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  await writeFile(
    join(resourcesDir, "app-update.yml"),
    `provider: generic\nurl: http://127.0.0.1:${port}/feeds/win-x64/\nchannel: nightly\nupdaterCacheDirName: '@deepseek-aidsh-desktop-updater'\n`,
    "utf8"
  );

  process.env.DSH_UC_FORCE_PLATFORM = "desktop";
  process.env.DSH_UC_RESOURCES_DIR = resourcesDir;
  process.env.DSH_UC_PROFILE_NODE_MODULES = profileNodeModules;
  process.env.DSH_HOME = home;
  delete process.env.DSH_UC_FEED_URL;
  delete process.env.DSH_UC_APP_VERSION;

  plugin = (await import("../lib/index.js")).default;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  delete process.env.DSH_UC_FORCE_PLATFORM;
  delete process.env.DSH_UC_RESOURCES_DIR;
  delete process.env.DSH_UC_PROFILE_NODE_MODULES;
  delete process.env.DSH_HOME;
  await rm(base, { recursive: true, force: true }).catch(() => {});
});

function drive() {
  const registrations = [];
  const ctx = {
    inject(names, cb) {
      if (names.includes("webServer")) {
        cb({
          webServer: {
            port: 19387,
            register(route) {
              registrations.push(route);
              return () => {};
            },
          },
        });
      }
      return () => {};
    },
    get() {
      return undefined;
    },
  };
  plugin.apply(ctx);
  return registrations;
}

test("desktop host: status.json reports the desktop feed and the installed app version", async () => {
  const registrations = drive();
  await new Promise((resolve) => setTimeout(resolve, 60));
  const status = await call(registrations, "/dsh-update-checker/status.json", undefined);
  assert.equal(status.status, 200);
  assert.equal(status.json.platform, "desktop");
  assert.equal(status.json.installed, DESKTOP_VERSION);
  assert.equal(status.json.latest, "0.2.1-alpha.1");
  assert.equal(status.json.hasUpdate, true);
  assert.equal(status.json.source, "desktop");
  assert.equal(status.json.desktop.channel, "nightly");
  assert.equal(status.json.desktop.provider, "generic");
  assert.equal(status.json.desktop.managedBy, "electron");
  assert.equal(status.json.desktop.appVersion, DESKTOP_VERSION);
  assert.match(status.json.desktop.feedUrl, /\/feeds\/win-x64\/nightly\.yml$/);
  assert.equal(status.json.runtime.platform, "desktop");
  assert.equal(status.json.runtime.managedBy, "electron");
  assert.equal(status.json.runtime.updateSourceAvailable, true);
  assert.equal(status.json.runtime.profileNodeModules, profileNodeModules);
  assert.match(status.json.sourceNote, /桌面端 nightly 通道/);
  assert.ok(feedHits >= 1, "the desktop feed was fetched over HTTP");
});

test("desktop host: /update never installs, it delegates to the application updater", async () => {
  const registrations = drive();
  await new Promise((resolve) => setTimeout(resolve, 60));
  const res = await call(registrations, "/dsh-update-checker/update", { confirm: true });
  assert.equal(res.status, 409);
  assert.equal(res.json.ok, false);
  assert.equal(res.json.code, "E_DESKTOP_OWNED");
  assert.equal(res.json.action, "open-native-update");
  assert.equal(res.json.version, "0.2.1-alpha.1");
  assert.equal(res.json.installed, DESKTOP_VERSION);
  assert.equal(res.json.channel, "nightly");
  assert.equal(existsSync(join(home, "dsh-update-checker-update.lock")), false);
  assert.equal(existsSync(join(home, "dsh-update-checker-update-progress.json")), false);
  const ops = existsSync(join(home, "dsh-update-checker-ops.log"))
    ? await readFile(join(home, "dsh-update-checker-ops.log"), "utf8")
    : "";
  assert.match(ops, /main-update-desktop-delegated/);
});

test("desktop host: /restart returns the manual restart guide instead of killing the host", async () => {
  const registrations = drive();
  await new Promise((resolve) => setTimeout(resolve, 60));
  const res = await call(registrations, "/dsh-update-checker/restart", { confirm: true });
  assert.equal(res.status, 409);
  assert.equal(res.json.ok, false);
  assert.equal(res.json.code, "E_DESKTOP_RESTART_MANUAL");
  assert.equal(res.json.manual, true);
  assert.match(res.json.guide, /DeepSeek Harness/);
});

test("desktop host: /rollback refuses because the bundled runtime has no backups", async () => {
  const registrations = drive();
  await new Promise((resolve) => setTimeout(resolve, 60));
  const res = await call(registrations, "/dsh-update-checker/rollback", { confirm: true });
  assert.equal(res.status, 409);
  assert.equal(res.json.code, "E_DESKTOP_OWNED");
  assert.equal(res.json.installed, DESKTOP_VERSION);
});

test("desktop host: plugins.json carries the platform so the banner can adapt", async () => {
  const registrations = drive();
  await new Promise((resolve) => setTimeout(resolve, 60));
  const res = await call(registrations, "/dsh-update-checker/plugins.json", undefined);
  assert.equal(res.status, 200);
  assert.equal(res.json.platform, "desktop");
  assert.equal(res.json.runtime.platform, "desktop");
  assert.ok(Array.isArray(res.json.plugins));
});
