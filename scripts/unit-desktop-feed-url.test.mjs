import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAC_FEED = `version: 0.2.0-rc.2
path: >-
  https://download.deepseek.com/dsh-desk/bin/mac-arm64/deepseek-harness-0.2.0-rc.2-mac-arm64.zip
sha512: >-
  BIC7PMWuEEzM7OuK8tMXQR0AdtVlYrSP1usHGWSAOhbxeXOzq2s1i71jZphMQSoQ/8tUQr55a158JW8xScseuA==
releaseDate: '2026-09-29T10:18:12.232Z'
`;

const home = await mkdtemp(join(tmpdir(), "duc-feed-url-"));
const resourcesDir = join(home, "resources");
await mkdir(resourcesDir, { recursive: true });
await writeFile(
  join(resourcesDir, "app-update.yml"),
  "provider: generic\nurl: https://download.deepseek.com/dsh-desk/feeds/mac-arm64/\nchannel: nightly\n",
  "utf8"
);

process.env.DSH_UC_FORCE_PLATFORM = "desktop";
process.env.DSH_UC_RESOURCES_DIR = resourcesDir;
process.env.DSH_UC_PROFILE_NODE_MODULES = join(home, "profiles", "desktop", "node_modules");
process.env.DSH_HOME = home;
delete process.env.DSH_UC_FEED_URL;
delete process.env.DSH_UC_APP_VERSION;

const { desktopFeedName, desktopFeedUrl, desktopFeedUrlCandidates, readDesktopFeed } = await import("../lib/index.js");

after(async () => {
  delete process.env.DSH_UC_FORCE_PLATFORM;
  delete process.env.DSH_UC_RESOURCES_DIR;
  delete process.env.DSH_UC_PROFILE_NODE_MODULES;
  delete process.env.DSH_HOME;
  await rm(home, { recursive: true, force: true }).catch(() => {});
});

const MAC_BASE = "https://download.deepseek.com/dsh-desk/feeds/mac-arm64/";
const WIN_BASE = "https://download.deepseek.com/dsh-desk/feeds/win-x64/";

function feedServer(routes) {
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(url);
    const route = routes[url];
    if (!route) return { ok: false, status: 404, text: async () => "not found" };
    if (route.status && route.status !== 200) return { ok: false, status: route.status, text: async () => "err" };
    return { ok: true, status: 200, text: async () => route.body };
  };
  return { requested, fetchImpl };
}

function updateSource() {
  return async () => "provider: generic\nurl: " + MAC_BASE + "\nchannel: nightly\n";
}

test("desktopFeedName: electron-builder names the manifest per platform", () => {
  assert.equal(desktopFeedName("nightly", "darwin"), "nightly-mac");
  assert.equal(desktopFeedName("nightly", "linux"), "nightly-linux");
  assert.equal(desktopFeedName("nightly", "win32"), "nightly");
  assert.equal(desktopFeedName("nightly", "freebsd"), "nightly");
});

test("desktopFeedName: a missing or blank channel falls back to latest", () => {
  assert.equal(desktopFeedName(null, "darwin"), "latest-mac");
  assert.equal(desktopFeedName(undefined, "linux"), "latest-linux");
  assert.equal(desktopFeedName("   ", "win32"), "latest");
  assert.equal(desktopFeedName(" nightly ", "darwin"), "nightly-mac");
});

test("desktopFeedUrl: the macOS feed carries the -mac suffix (issue #38)", () => {
  assert.equal(desktopFeedUrl(MAC_BASE, "nightly", "darwin"), MAC_BASE + "nightly-mac.yml");
  assert.equal(desktopFeedUrl(MAC_BASE, null, "darwin"), MAC_BASE + "latest-mac.yml");
  assert.equal(desktopFeedUrl("https://download.deepseek.com/dsh-desk/feeds/mac-arm64", "nightly", "darwin"), MAC_BASE + "nightly-mac.yml");
});

test("desktopFeedUrl: Linux uses -linux and Windows keeps the bare name", () => {
  assert.equal(desktopFeedUrl("https://example.test/feeds/linux-x64/", "nightly", "linux"), "https://example.test/feeds/linux-x64/nightly-linux.yml");
  assert.equal(desktopFeedUrl(WIN_BASE, "nightly", "win32"), WIN_BASE + "nightly.yml");
  assert.equal(desktopFeedUrl(WIN_BASE, "nightly", "freebsd"), WIN_BASE + "nightly.yml");
  assert.equal(desktopFeedUrl("", "nightly", "darwin"), null);
});

test("desktopFeedUrlCandidates: the platform name is tried first, the bare name stays as a fallback", () => {
  assert.deepEqual(desktopFeedUrlCandidates(MAC_BASE, "nightly", "darwin"), [MAC_BASE + "nightly-mac.yml", MAC_BASE + "nightly.yml"]);
  assert.deepEqual(desktopFeedUrlCandidates(MAC_BASE, "nightly", "linux"), [MAC_BASE + "nightly-linux.yml", MAC_BASE + "nightly.yml"]);
  assert.deepEqual(desktopFeedUrlCandidates(MAC_BASE, "nightly", "win32"), [MAC_BASE + "nightly.yml"]);
  assert.deepEqual(desktopFeedUrlCandidates("", "nightly", "darwin"), []);
});

test("readDesktopFeed: a macOS host reads <channel>-mac.yml and nothing else", async () => {
  const macUrl = MAC_BASE + "nightly-mac.yml";
  const server = feedServer({ [macUrl]: { body: MAC_FEED } });
  const feed = await readDesktopFeed(true, { fetchImpl: server.fetchImpl, readText: updateSource(), platform: "darwin" });
  assert.deepEqual(server.requested, [macUrl]);
  assert.equal(feed.feedUrl, macUrl);
  assert.equal(feed.channel, "nightly");
  assert.equal(feed.version, "0.2.0-rc.2");
  assert.equal(feed.releaseDate, "2026-09-29T10:18:12.232Z");
  assert.match(feed.downloadUrl, /deepseek-harness-0\.2\.0-rc\.2-mac-arm64\.zip$/);
});

test("readDesktopFeed: a 404 on the platform manifest falls back to the bare name and logs it", async () => {
  const macUrl = MAC_BASE + "nightly-mac.yml";
  const bareUrl = MAC_BASE + "nightly.yml";
  const server = feedServer({ [bareUrl]: { body: MAC_FEED } });
  const feed = await readDesktopFeed(true, { fetchImpl: server.fetchImpl, readText: updateSource(), platform: "darwin" });
  assert.deepEqual(server.requested, [macUrl, bareUrl]);
  assert.equal(feed.feedUrl, bareUrl);
  assert.equal(feed.version, "0.2.0-rc.2");
  const ops = await readFile(join(home, "dsh-update-checker-ops.log"), "utf8");
  const line = ops.trim().split(/\r?\n/).map((l) => JSON.parse(l)).find((e) => e.op === "main-update-desktop-feed-fallback");
  assert.ok(line, "the fallback is recorded in the ops log");
  assert.equal(line.status, 404);
  assert.equal(line.from, macUrl);
  assert.equal(line.to, bareUrl);
});

test("readDesktopFeed: a Windows host never falls back (one request, bare name)", async () => {
  const bareUrl = WIN_BASE + "nightly.yml";
  const server = feedServer({ [bareUrl]: { body: MAC_FEED } });
  const feed = await readDesktopFeed(true, {
    fetchImpl: server.fetchImpl,
    readText: async () => "provider: generic\nurl: " + WIN_BASE + "\nchannel: nightly\n",
    platform: "win32",
  });
  assert.deepEqual(server.requested, [bareUrl]);
  assert.equal(feed.feedUrl, bareUrl);
});

test("readDesktopFeed: both names missing reports the HTTP status instead of hanging", async () => {
  const server = feedServer({});
  await assert.rejects(
    () => readDesktopFeed(true, { fetchImpl: server.fetchImpl, readText: updateSource(), platform: "darwin" }),
    (err) => {
      assert.match(err.message, /desktop update feed HTTP 404/);
      assert.equal(err.feedUrl, MAC_BASE + "nightly-mac.yml");
      assert.deepEqual(err.attempts, [MAC_BASE + "nightly-mac.yml", MAC_BASE + "nightly.yml"]);
      return true;
    }
  );
  assert.deepEqual(server.requested, [MAC_BASE + "nightly-mac.yml", MAC_BASE + "nightly.yml"]);
});

test("readDesktopFeed: a server error is not treated as a missing file", async () => {
  const macUrl = MAC_BASE + "nightly-mac.yml";
  const bareUrl = MAC_BASE + "nightly.yml";
  const server = feedServer({ [macUrl]: { status: 500 }, [bareUrl]: { body: MAC_FEED } });
  await assert.rejects(
    () => readDesktopFeed(true, { fetchImpl: server.fetchImpl, readText: updateSource(), platform: "darwin" }),
    /desktop update feed HTTP 500/
  );
  assert.deepEqual(server.requested, [macUrl]);
});

test("readDesktopFeed: the primary name is what a double failure reports, the attempt list keeps the rest", async () => {
  const macUrl = MAC_BASE + "nightly-mac.yml";
  const bareUrl = MAC_BASE + "nightly.yml";
  const server = feedServer({ [macUrl]: { status: 404 }, [bareUrl]: { status: 503 } });
  await assert.rejects(
    () => readDesktopFeed(true, { fetchImpl: server.fetchImpl, readText: updateSource(), platform: "darwin" }),
    (err) => {
      assert.match(err.message, /desktop update feed HTTP 404/);
      assert.equal(err.feedUrl, macUrl);
      assert.deepEqual(err.attempts, [macUrl, bareUrl]);
      assert.match(err.lastError, /HTTP 503/);
      return true;
    }
  );
  assert.deepEqual(server.requested, [macUrl, bareUrl]);
});

test("readDesktopFeed: a manifest without a version is reported, not silently accepted", async () => {
  const macUrl = MAC_BASE + "nightly-mac.yml";
  const server = feedServer({ [macUrl]: { body: "releaseDate: '2026-09-29T10:18:12.232Z'\n" } });
  await assert.rejects(
    () => readDesktopFeed(true, { fetchImpl: server.fetchImpl, readText: updateSource(), platform: "darwin" }),
    /desktop update feed carries no version/
  );
  assert.deepEqual(server.requested, [macUrl]);
});

test("readDesktopFeed: DSH_UC_FEED_URL still wins and keeps its bare-name override", async () => {
  const override = "https://example.test/custom/nightly.yml";
  process.env.DSH_UC_FEED_URL = override;
  const server = feedServer({ [override]: { body: MAC_FEED } });
  try {
    const feed = await readDesktopFeed(true, { fetchImpl: server.fetchImpl, readText: updateSource(), platform: "darwin" });
    assert.deepEqual(server.requested, [override]);
    assert.equal(feed.provider, "override");
    assert.equal(feed.feedUrl, override);
  } finally {
    delete process.env.DSH_UC_FEED_URL;
  }
});
