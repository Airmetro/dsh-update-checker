import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, lstat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

let base;
let mod;

async function makePackage(dir, version) {
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name: "dsh-update-checker", version, main: "lib/index.js" }, null, 2),
    "utf8"
  );
  await mkdir(join(dir, "lib"), { recursive: true });
  await writeFile(join(dir, "lib", "index.js"), "export default {}\n", "utf8");
}

before(async () => {
  base = await mkdtemp(join(tmpdir(), "duc-mount-guard-"));
  process.env.DSH_UC_PROFILE_NODE_MODULES = join(base, "profiles", "desktop", "node_modules");
  process.env.DSH_HOME = base;
  await mkdir(process.env.DSH_UC_PROFILE_NODE_MODULES, { recursive: true });
  mod = await import("../lib/index.js");
});

after(async () => {
  await rm(base, { recursive: true, force: true });
  delete process.env.DSH_UC_PROFILE_NODE_MODULES;
  delete process.env.DSH_HOME;
});

test("a mount never replaces a real copy with an older source (no silent downgrade)", async () => {
  const src = join(base, "shared", "dsh-update-checker");
  const dst = join(base, "profiles", "desktop", "node_modules", "dsh-update-checker");
  await makePackage(src, "1.4.23");
  await makePackage(dst, "1.7.0");

  const result = await mod.linkPackageIntoProfile(src, dst, "dsh-update-checker", {
    expectedName: "dsh-update-checker",
  });

  assert.equal(result.ok, false);
  assert.equal(result.conflict, "downgrade");
  assert.equal(result.installed, "1.7.0");
  assert.equal(result.source, "1.4.23");
  assert.match(result.error, /newer real copy/);

  const st = await lstat(dst);
  assert.equal(st.isSymbolicLink(), false, "the newer real directory stays a real directory");
  const pkg = JSON.parse(await readFile(join(dst, "package.json"), "utf8"));
  assert.equal(pkg.version, "1.7.0");
});

test("an equal or newer source still replaces the real copy with the shared link", async () => {
  const src = join(base, "shared2", "dsh-update-checker");
  const dst = join(base, "profiles", "other", "node_modules", "dsh-update-checker");
  await makePackage(src, "1.7.1");
  await makePackage(dst, "1.7.0");

  const result = await mod.linkPackageIntoProfile(src, dst, "dsh-update-checker", {
    expectedName: "dsh-update-checker",
  });

  assert.equal(result.ok, true);
  assert.equal(result.replaced, "real-directory-copy");
  const st = await lstat(dst);
  assert.equal(st.isSymbolicLink(), true, "the stale copy is now a link to the newer source");
});

test("a pre-release destination still counts as newer", async () => {
  const src = join(base, "shared3", "dsh-update-checker");
  const dst = join(base, "profiles", "third", "node_modules", "dsh-update-checker");
  await makePackage(src, "1.7.0");
  await makePackage(dst, "1.7.1-beta.1");

  const result = await mod.linkPackageIntoProfile(src, dst, "dsh-update-checker", {
    expectedName: "dsh-update-checker",
  });

  assert.equal(result.ok, false);
  assert.equal(result.conflict, "downgrade");
  assert.equal(result.installed, "1.7.1-beta.1");
});
