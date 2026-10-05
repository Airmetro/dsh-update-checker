import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, lstat, realpath, readdir, cp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const SELF = "dsh-update-checker";

async function makePkg(dir, name, version = "1.0.0") {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "package.json"), JSON.stringify({ name, version }), "utf8");
  await writeFile(join(dir, "index.js"), `// ${name}`, "utf8");
}

async function readJson(p) {
  try {
    return JSON.parse(await readFile(p, "utf8"));
  } catch {
    return null;
  }
}

async function exists(p) {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

let importSeq = 0;
async function scaffold(opts = {}) {
  const { pluginVersion = "1.6.0", profiles = ["web", "other"] } = opts;
  const base = await mkdtemp(join(tmpdir(), "duc-mount-"));
  const home = join(base, ".dsh");
  const profilesRoot = join(home, "profiles");
  const profileNm = join(profilesRoot, "node_modules");
  const pluginDir = join(profileNm, SELF);
  await makePkg(pluginDir, SELF, pluginVersion);

  for (const p of profiles) {
    const dir = join(profilesRoot, p);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify(
        {
          name: `dsh-profile-${p}`,
          private: true,
          dependencies: {},
          dsh: { profile: { bundles: ["@deepseek-ai/dsh-base"], patchReload: "live" } },
        },
        null,
        2
      ) + "\n",
      "utf8"
    );
  }

  process.env.DSH_UC_PROFILE_NODE_MODULES = profileNm;
  process.env.DSH_HOME = home;
  process.env.DSH_UC_UPDATE_PROFILE_NM = profileNm;
  const mod = await import(`../lib/index.js?mount=${importSeq++}`);
  return { base, home, profilesRoot, profileNm, pluginDir, mod };
}

async function isLinkedTo(dst, target) {
  const st = await lstat(dst).catch(() => null);
  if (!st || !st.isSymbolicLink()) return false;
  const [a, b] = await Promise.all([realpath(dst).catch(() => null), realpath(target).catch(() => null)]);
  return Boolean(a && b && a === b);
}

test("场景1：缺失的 profile 链接被建立，且声明写入 profile package.json", async () => {
  const s = await scaffold();
  try {
    const linkPath = join(s.profilesRoot, "web", "node_modules", SELF);
    assert.equal(await exists(linkPath), false, "前置条件：初始没有链接");

    const report = await s.mod.ensurePluginMount();

    assert.equal(report.ok, true, JSON.stringify(report.errors));
    assert.ok(
      await isLinkedTo(linkPath, s.pluginDir),
      "必须在 profiles/web/node_modules 下建立指向真实包的链接"
    );
    assert.equal(
      await realpath(linkPath),
      await realpath(s.pluginDir),
      "链接必须解析回 profiles/node_modules 下的真实包"
    );

    const pkg = await readJson(join(s.profilesRoot, "web", "package.json"));
    assert.equal(pkg.dependencies[SELF], "^1.6.0", "profile 应声明本插件依赖");

    const other = await readJson(join(s.profilesRoot, "other", "package.json"));
    assert.equal(other.dependencies[SELF], "^1.6.0", "每个 harness profile 都应被挂载");
  } finally {
    await rm(s.base, { recursive: true, force: true });
  }
});

test("场景2：实体副本被回收为链接（v1.4.23 缺陷形态）", async () => {
  const s = await scaffold();
  try {
    const linkPath = join(s.profilesRoot, "web", "node_modules", SELF);
    await makePkg(linkPath, SELF, "1.5.0");
    const st0 = await lstat(linkPath);
    assert.ok(st0.isDirectory() && !st0.isSymbolicLink(), "前置条件：应为实体目录");

    const report = await s.mod.ensurePluginMount();

    assert.equal(report.ok, true, JSON.stringify(report.errors));
    assert.ok(await isLinkedTo(linkPath, s.pluginDir), "实体副本应被替换为链接");
    assert.equal(
      report.linked.find((l) => l.profile === "web")?.replaced,
      "real-directory-copy",
      "报告应说明回收的是实体副本"
    );
  } finally {
    await rm(s.base, { recursive: true, force: true });
  }
});

test("场景3：已正确的链接被跳过（幂等，不重建）", async () => {
  const s = await scaffold();
  try {
    await s.mod.ensurePluginMount();
    const linkPath = join(s.profilesRoot, "web", "node_modules", SELF);
    const before = await lstat(linkPath);

    const second = await s.mod.ensurePluginMount();

    assert.deepEqual(second.linked, [], "第二次不应报告任何重建");
    assert.deepEqual(second.declared, [], "第二次不应重复声明");
    assert.equal(second.profiles.find((p) => p.profile === "web").linked, true);
    const after = await lstat(linkPath);
    assert.equal(after.ino, before.ino, "链接本身不应被重建（Windows 上 ino 可比较）");
  } finally {
    await rm(s.base, { recursive: true, force: true });
  }
});

test("场景4：同名但不同来源的目录绝不被删除或替换", async () => {
  const s = await scaffold();
  try {
    const linkPath = join(s.profilesRoot, "web", "node_modules", SELF);
    await makePkg(linkPath, "@somebody-else/not-this-package", "9.9.9");

    const report = await s.mod.ensurePluginMount();

    assert.equal(report.ok, false, "应报告失败而非静默处理");
    assert.match(
      report.errors.find((e) => e.step === "link").error,
      /refusing to replace/
    );
    const after = await readJson(join(linkPath, "package.json"));
    assert.equal(after.name, "@somebody-else/not-this-package", "外来目录必须原封不动");
    assert.equal(await isLinkedTo(linkPath, s.pluginDir), false);
  } finally {
    await rm(s.base, { recursive: true, force: true });
  }
});

test("场景5：悬空链接（指向已消失的旧位置）被重建", async () => {
  const s = await scaffold();
  try {
    const linkPath = join(s.profilesRoot, "web", "node_modules", SELF);
    await mkdir(join(s.profilesRoot, "web", "node_modules"), { recursive: true });
    const { symlink } = await import("node:fs/promises");
    await symlink(join(s.base, "gone", SELF), linkPath, process.platform === "win32" ? "junction" : "dir");

    const report = await s.mod.ensurePluginMount();

    assert.equal(report.ok, true, JSON.stringify(report.errors));
    assert.ok(await isLinkedTo(linkPath, s.pluginDir), "悬空链接应指向当前真实包");
    assert.equal(report.linked.find((l) => l.profile === "web")?.replaced, "stale-link");
  } finally {
    await rm(s.base, { recursive: true, force: true });
  }
});

test("场景6：已有的依赖声明不被覆盖，外来 spec 被标注而非静默改写", async () => {
  const s = await scaffold();
  try {
    const manifestPath = join(s.profilesRoot, "web", "package.json");
    const pkg = await readJson(manifestPath);
    pkg.dependencies[SELF] = "file:../node_modules/dsh-update-checker";
    await writeFile(manifestPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");

    const report = await s.mod.ensurePluginMount();

    const after = await readJson(manifestPath);
    assert.equal(
      after.dependencies[SELF],
      "file:../node_modules/dsh-update-checker",
      "已有声明必须原样保留（用户可能故意用 file:）"
    );
    const entry = report.profiles.find((p) => p.profile === "web");
    assert.equal(entry.declared, true);
    assert.equal(entry.foreignDecl, "file:../node_modules/dsh-update-checker");
    assert.deepEqual(
      report.declared.filter((d) => d.profile === "web"),
      [],
      "web 已有声明，不应记为新增"
    );
    assert.deepEqual(
      report.declared.map((d) => d.profile),
      ["other"],
      "只有确实缺声明的 profile 才被写入"
    );
  } finally {
    await rm(s.base, { recursive: true, force: true });
  }
});

test("场景7：非 harness profile 只建链接，不写 dependencies", async () => {
  const s = await scaffold();
  try {
    const plain = join(s.profilesRoot, "plain");
    await mkdir(plain, { recursive: true });
    await writeFile(join(plain, "package.json"), JSON.stringify({ name: "plain", private: true }), "utf8");

    await s.mod.ensurePluginMount();

    assert.ok(
      await isLinkedTo(join(plain, "node_modules", SELF), s.pluginDir),
      "没有 dsh 标记的目录同样需要链接才能解析"
    );
    const after = await readJson(join(plain, "package.json"));
    assert.deepEqual(after.dependencies, undefined, "不应擅自给非 harness 目录加依赖");
  } finally {
    await rm(s.base, { recursive: true, force: true });
  }
});

test("场景7b：声明在 devDependencies 时不重复写入 dependencies", async () => {
  const s = await scaffold();
  try {
    
    
    const manifestPath = join(s.profilesRoot, "web", "package.json");
    const pkg = await readJson(manifestPath);
    pkg.devDependencies = { [SELF]: "^1.6.0" };
    await writeFile(manifestPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");

    const report = await s.mod.ensurePluginMount();

    const after = await readJson(manifestPath);
    assert.equal(after.devDependencies[SELF], "^1.6.0", "devDependencies 里的声明必须原样保留");
    assert.deepEqual(
      after.dependencies,
      {},
      "不得因为只看 dependencies 而写入第二条重复声明"
    );
    const entry = report.profiles.find((p) => p.profile === "web");
    assert.equal(entry.declared, true);
    assert.equal(entry.section, "devDependencies", "应报告实际生效的依赖段");
  } finally {
    await rm(s.base, { recursive: true, force: true });
  }
});

test("场景7c：只有 dsh 键（无 dsh.profile）的清单也算 harness profile", async () => {
  const s = await scaffold();
  try {
    const odd = join(s.profilesRoot, "odd");
    await mkdir(odd, { recursive: true });
    
    
    await writeFile(
      join(odd, "package.json"),
      JSON.stringify({ name: "dsh-profile-odd", private: true, dependencies: {}, dsh: { profile: { patchReload: "live" } } }),
      "utf8"
    );
    const noProfileKey = join(s.profilesRoot, "nokey");
    await mkdir(noProfileKey, { recursive: true });
    await writeFile(
      join(noProfileKey, "package.json"),
      JSON.stringify({ name: "dsh-profile-nokey", private: true, dependencies: {}, dsh: { bundles: [] } }),
      "utf8"
    );

    await s.mod.ensurePluginMount();

    for (const name of ["odd", "nokey"]) {
      const pkg = await readJson(join(s.profilesRoot, name, "package.json"));
      assert.equal(
        pkg.dependencies[SELF],
        "^1.6.0",
        `${name}：带 dsh 键的清单应被写入依赖，否则插件会被认成"永远需要更新"`
      );
    }
  } finally {
    await rm(s.base, { recursive: true, force: true });
  }
});

test("场景8：插件不在 profiles/node_modules 下时安全退出（npm -g / 部署根安装）", async () => {
  const base = await mkdtemp(join(tmpdir(), "duc-mount-"));
  try {
    const home = join(base, ".dsh");
    const profileNm = join(home, "profiles", "node_modules");
    await mkdir(profileNm, { recursive: true });
    await mkdir(join(home, "profiles", "web"), { recursive: true });
    await writeFile(
      join(home, "profiles", "web", "package.json"),
      JSON.stringify({ name: "x", dsh: { profile: {} } }),
      "utf8"
    );
    process.env.DSH_UC_PROFILE_NODE_MODULES = profileNm;
    process.env.DSH_HOME = home;
    const mod = await import(`../lib/index.js?mount=${importSeq++}`);

    const report = await mod.ensurePluginMount();

    assert.ok(report.skipped, "应报告 skipped 而不是抛错");
    assert.equal(report.pluginDir, null);
    assert.deepEqual(await readdir(join(home, "profiles", "web")), ["package.json"], "不应产生任何副作用");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("场景9：runSync 写链接而非实体副本（profile 侧 @deepseek-ai 的同一类故障）", async () => {
  const s = await scaffold();
  try {
    const deployRoot = join(s.base, "deploy");
    await makePkg(join(deployRoot, "node_modules", "@deepseek-ai", "dsh"), "@deepseek-ai/dsh", "2.0.0");
    await makePkg(
      join(deployRoot, "node_modules", "@deepseek-ai", "dsh-base"),
      "@deepseek-ai/dsh-base",
      "2.0.0"
    );

    const results = await s.mod.runSync(deployRoot, [
      { name: "dsh", from: null, to: "2.0.0" },
      { name: "dsh-base", from: null, to: "2.0.0" },
    ]);

    assert.equal(results.filter((r) => !r.ok).length, 0, JSON.stringify(results));
    for (const n of ["dsh", "dsh-base"]) {
      assert.ok(
        await isLinkedTo(
          join(s.profileNm, "@deepseek-ai", n),
          join(deployRoot, "node_modules", "@deepseek-ai", n)
        ),
        `${n} 在 profile 侧必须是链接——实体目录会让 dsh 的 ensureSymlink 在服务绑定端口前抛错`
      );
    }
  } finally {
    await rm(s.base, { recursive: true, force: true });
  }
});

test("场景11：GET mount.json 只读；真正的重挂载走带写闸门的 POST /mount", async () => {
  const s = await scaffold();
  try {
    const src = await readFile(new URL("../lib/index.js", import.meta.url), "utf8");
    const start = src.indexOf('path: "/dsh-update-checker/mount.json"');
    const post = src.indexOf('path: "/dsh-update-checker/mount"');
    assert.ok(start > 0, "应存在 mount.json 路由");
    assert.ok(post > start, "应存在 POST /mount 路由");

    
    
    const getBlock = src.slice(start, post);
    assert.ok(
      !/ensurePluginMount\(\)/.test(getBlock),
      "GET mount.json 不得调用 ensurePluginMount——它会在无写闸门、无回环校验的情况下改磁盘"
    );
    assert.ok(/lastMountReport/.test(getBlock), "GET 应只返回最近一次挂载结果");

    
    
    const postBlock = src.slice(post, post + 900);
    assert.ok(
      /writeGate\(req, res\)/.test(postBlock),
      "POST /mount 必须过 writeGate（confirm + 回环来源），与其它写路由一致"
    );
    assert.ok(/ensurePluginMount\(\)/.test(postBlock), "POST /mount 才是执行重挂载的入口");
  } finally {
    await rm(s.base, { recursive: true, force: true });
  }
});

test("场景12：挂载已正确时，重挂载不产生任何写入（幂等且静默）", async () => {
  const s = await scaffold();
  try {
    await s.mod.ensurePluginMount();
    const manifestPath = join(s.profilesRoot, "web", "package.json");
    const before = await readFile(manifestPath, "utf8");
    const linkBefore = await lstat(join(s.profilesRoot, "web", "node_modules", SELF)).catch(() => null);

    const second = await s.mod.ensurePluginMount();

    assert.equal(await readFile(manifestPath, "utf8"), before, "package.json 不应被重写");
    const linkAfter = await lstat(join(s.profilesRoot, "web", "node_modules", SELF));
    assert.equal(linkAfter.ino, linkBefore.ino, "链接不应被重建");
    assert.equal(second.ok, true);
    assert.deepEqual(second.errors, []);
  } finally {
    await rm(s.base, { recursive: true, force: true });
  }
});

test("场景10：runSync 回收 profile 侧的实体副本，但拒绝外来同名目录", async () => {
  const s = await scaffold();
  try {
    const deployRoot = join(s.base, "deploy");
    await makePkg(
      join(deployRoot, "node_modules", "@deepseek-ai", "dsh-ptc-runtime"),
      "@deepseek-ai/dsh-ptc-runtime",
      "2.0.0"
    );
    await makePkg(
      join(deployRoot, "node_modules", "@deepseek-ai", "dsh-foreign"),
      "@deepseek-ai/dsh-foreign",
      "2.0.0"
    );
    await makePkg(
      join(s.profileNm, "@deepseek-ai", "dsh-ptc-runtime"),
      "@deepseek-ai/dsh-ptc-runtime",
      "1.0.0"
    );
    await makePkg(join(s.profileNm, "@deepseek-ai", "dsh-foreign"), "@someone/else", "9.9.9");

    const results = await s.mod.runSync(deployRoot, [
      { name: "dsh-ptc-runtime", from: "1.0.0", to: "2.0.0" },
      { name: "dsh-foreign", from: null, to: "2.0.0" },
    ]);
    const byName = Object.fromEntries(results.map((r) => [r.name, r]));

    assert.equal(byName["dsh-ptc-runtime"].ok, true);
    assert.equal(byName["dsh-ptc-runtime"].replaced, "real-directory-copy");
    assert.ok(
      await isLinkedTo(
        join(s.profileNm, "@deepseek-ai", "dsh-ptc-runtime"),
        join(deployRoot, "node_modules", "@deepseek-ai", "dsh-ptc-runtime")
      )
    );

    assert.equal(byName["dsh-foreign"].ok, false, "外来目录应报告失败");
    assert.match(byName["dsh-foreign"].error, /refusing to replace/);
    const kept = await readJson(join(s.profileNm, "@deepseek-ai", "dsh-foreign", "package.json"));
    assert.equal(kept.name, "@someone/else", "外来目录必须原封不动");
  } finally {
    await rm(s.base, { recursive: true, force: true });
  }
});
