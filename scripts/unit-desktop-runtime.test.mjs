import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { existsSync } from "node:fs";

import {
  detectDesktopRuntime,
  parseDesktopUpdateSource,
  parseDesktopFeed,
  desktopFeedUrl,
  buildPnpmStageAddArgs,
  buildPnpmStageInstallArgs,
  mainUpdatePlatformError,
} from "../lib/index.js";

const APP_UPDATE_YML = `provider: generic
url: https://download.deepseek.com/dsh-desk/feeds/win-x64/
channel: nightly
updaterCacheDirName: '@deepseek-aidsh-desktop-updater'
publisherName:
  - CN=Hangzhou\\20DeepSeek\\20Artificial\\20Intelligence\\20Co.\\2c\\20Ltd.,O=Hangzhou,C=CN
`;

const FEED_YML = `version: 0.2.0-rc.2
files:
  - url: >-
      https://download.deepseek.com/dsh-desk/bin/win-x64/deepseek-harness-0.2.0-rc.2-win-x64.exe
    sha512: >-
      raIlxMQd9ESXgktmViW7QwVLcjBR5JIsrNOu+SpelY8kskdSr2H51/f+ey1EqFI/eIIrKQCuRANMeb5SptRZcg==
    size: 289313640
path: >-
  https://download.deepseek.com/dsh-desk/bin/win-x64/deepseek-harness-0.2.0-rc.2-win-x64.exe
sha512: >-
  raIlxMQd9ESXgktmViW7QwVLcjBR5JIsrNOu+SpelY8kskdSr2H51/f+ey1EqFI/eIIrKQCuRANMeb5SptRZcg==
releaseDate: '2026-09-29T10:35:27.666Z'
`;

test("detectDesktopRuntime: plain node is web", () => {
  const facts = detectDesktopRuntime({
    env: {},
    versions: { node: "22.0.0" },
    argv: ["C:\\Program Files\\nodejs\\node.exe", "C:\\Users\\x\\.dsh\\profiles\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js", "web"],
    resourcesPath: undefined,
    exists: () => false,
  });
  assert.equal(facts.platform, "web");
  assert.equal(facts.desktop, false);
  assert.equal(facts.electron, null);
  assert.equal(facts.updateSourceAvailable, false);
});

test("detectDesktopRuntime: Electron node mode with desktop host argv is desktop", () => {
  const exists = (p) => String(p).endsWith("app-update.yml");
  const facts = detectDesktopRuntime({
    env: { ELECTRON_RUN_AS_NODE: "1" },
    versions: { node: "24.18.1", electron: "44.0.0" },
    argv: [
      "D:\\deepseek harness\\DeepSeek Harness.exe",
      "D:\\deepseek harness\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\index.js",
      "D:\\deepseek harness\\resources\\app.asar\\dsh",
      "C:\\Users\\Admin\\.dsh\\profiles\\desktop",
      "D:\\deepseek harness\\resources\\runtime\\primary-runtime",
      "D:\\deepseek harness\\resources\\runtime\\pnpm\\bin\\pnpm.mjs",
      "D:\\deepseek harness\\resources\\runtime\\bin",
    ],
    resourcesPath: "D:\\deepseek harness\\resources",
    exists,
  });
  assert.equal(facts.platform, "desktop");
  assert.equal(facts.desktop, true);
  assert.equal(facts.electron, "44.0.0");
  assert.equal(facts.runAsNode, true);
  assert.equal(facts.desktopHost, true);
  assert.equal(facts.runtimeDir, "D:\\deepseek harness\\resources\\app.asar\\dsh");
  assert.equal(facts.resourcesDir, "D:\\deepseek harness\\resources");
  assert.equal(facts.appRoot, "D:\\deepseek harness");
  assert.equal(facts.appUpdateFile, join("D:\\deepseek harness\\resources", "app-update.yml"));
  assert.equal(facts.updateSourceAvailable, true);
  assert.equal(
    facts.appPackageFiles[0],
    join("D:\\deepseek harness\\resources", "app.asar", "package.json")
  );
  assert.ok(facts.appPackageFiles.includes(join("D:\\deepseek harness\\resources\\app.asar\\dsh", "package.json")));
});

test("detectDesktopRuntime: runtimeDir/resourcesDir derive from the host entry without process facts", () => {
  const facts = detectDesktopRuntime({
    env: {},
    versions: { electron: "44.0.0" },
    argv: ["/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness", "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js"],
    exists: () => false,
  });
  assert.equal(facts.platform, "desktop");
  assert.equal(facts.resourcesDir, "/Applications/DeepSeek Harness.app/Contents/Resources");
  assert.equal(facts.updateSourceAvailable, false);
});

test("detectDesktopRuntime: DSH_UC_FORCE_PLATFORM overrides both ways", () => {
  const forcedWeb = detectDesktopRuntime({
    env: { DSH_UC_FORCE_PLATFORM: "web" },
    versions: { electron: "44.0.0" },
    argv: ["D:\\app\\DeepSeek Harness.exe", "entry.js"],
    exists: () => true,
  });
  assert.equal(forcedWeb.platform, "web");
  const forcedDesktop = detectDesktopRuntime({
    env: { DSH_UC_FORCE_PLATFORM: "desktop", DSH_UC_RESOURCES_DIR: "C:\\fixture\\resources" },
    versions: { node: "22.0.0" },
    argv: ["C:\\Program Files\\nodejs\\node.exe", "bin.js"],
    exists: (p) => String(p).includes("fixture"),
  });
  assert.equal(forcedDesktop.platform, "desktop");
  assert.equal(forcedDesktop.updateSourceAvailable, true);
});

test("parseDesktopUpdateSource: reads the packaged app-update.yml", () => {
  const src = parseDesktopUpdateSource(APP_UPDATE_YML);
  assert.equal(src.provider, "generic");
  assert.equal(src.url, "https://download.deepseek.com/dsh-desk/feeds/win-x64/");
  assert.equal(src.channel, "nightly");
});

test("parseDesktopUpdateSource: quoted values and missing keys", () => {
  const src = parseDesktopUpdateSource("provider: generic\nurl: \"https://example.test/feed\"\n");
  assert.equal(src.url, "https://example.test/feed");
  assert.equal(src.channel, null);
});

test("parseDesktopFeed: folded url blocks plus a quoted releaseDate", () => {
  const feed = parseDesktopFeed(FEED_YML);
  assert.equal(feed.version, "0.2.0-rc.2");
  assert.equal(feed.releaseDate, "2026-09-29T10:35:27.666Z");
  assert.equal(
    feed.url,
    "https://download.deepseek.com/dsh-desk/bin/win-x64/deepseek-harness-0.2.0-rc.2-win-x64.exe"
  );
  assert.match(feed.sha512, /^raIlxMQd/);
});

test("parseDesktopFeed: literal block scalars and empty input", () => {
  assert.equal(parseDesktopFeed("version: |\n  1.2.3\n").version, "1.2.3");
  assert.equal(parseDesktopFeed("").version, null);
});

test("desktopFeedUrl: channel file under a trailing-slash base", () => {
  assert.equal(
    desktopFeedUrl("https://download.deepseek.com/dsh-desk/feeds/win-x64/", "nightly"),
    "https://download.deepseek.com/dsh-desk/feeds/win-x64/nightly.yml"
  );
  assert.equal(
    desktopFeedUrl("https://download.deepseek.com/dsh-desk/feeds/win-x64", "nightly"),
    "https://download.deepseek.com/dsh-desk/feeds/win-x64/nightly.yml"
  );
  assert.equal(desktopFeedUrl("https://example.test/f/", null), "https://example.test/f/latest.yml");
  assert.equal(desktopFeedUrl("", "nightly"), null);
});

test("pnpm staging arguments exist for the bundled desktop package manager", () => {
  const add = buildPnpmStageAddArgs("C:\\tmp\\stage", "dsh-market@1.66.9");
  assert.deepEqual(add.slice(0, 2), ["add", "dsh-market@1.66.9"]);
  assert.ok(add.includes("--dir"));
  assert.ok(add.includes("C:\\tmp\\stage"));
  assert.ok(add.includes("--registry"));
  const install = buildPnpmStageInstallArgs("C:\\tmp\\stage");
  assert.equal(install[0], "install");
  assert.ok(install.includes("--prod"));
  assert.ok(install.includes("--dir"));
});

test("mainUpdatePlatformError stays web-scoped (desktop is gated earlier)", () => {
  assert.equal(mainUpdatePlatformError("win32"), null);
  assert.equal(typeof existsSync, "function");
});
