/**
 * syncProfilesToDeploy 回归测试（v1.5.0）。
 *
 * 刻意从 main-update-worker.mjs 里"提取"函数源码来执行，而不是复制粘贴一份实现——
 * 否则测试会与被测代码漂移，而漂移正是本缺陷得以发布的土壤：integration-junction.test.mjs
 * 测的是 lib/index.js 的 runSync（输出 skipped: 'same-file (junction)'），主程序更新实际
 * 执行的却是 worker 里的 syncProfilesToDeploy（输出 skipped: "junction"），后者新建路径
 * 没有任何用例覆盖。同一套用例对 1.4.23 的 worker 4/6 失败，对本版 6/6 通过。
 *
 * 覆盖场景：A 全新包建链接而非实体复制；B 残留实体副本被回收；C 同名外来目录绝不被删除；
 * D 悬空链接被重建；E 非 dsh 前缀包被忽略；F deploy 树不可读时安全退出。
 *
 * 注入的依赖包含 `cp`：上一版正是用 `cp(..., { force: true })` 写入的，把它接进沙箱才能让
 * 旧实现的复制路径被真正执行（而不是抛 `cp is not defined`），从而证明这套用例抓的是缺陷
 * 本身，而不是缺少绑定。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, mkdir, writeFile, rm, lstat, realpath, symlink, readdir, cp } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

const WORKER = new URL(process.env.DSH_TEST_WORKER || "./main-update-worker.mjs", import.meta.url);
const source = await readFile(WORKER, "utf8");

const lines = source.split("\n");
const startIdx = lines.findIndex((l) => l.startsWith("async function syncProfilesToDeploy()"));
assert.ok(startIdx >= 0, "在 worker 中找不到 syncProfilesToDeploy");
let endIdx = -1;
for (let i = startIdx + 1; i < lines.length; i++) {
  if (lines[i] === "}") { endIdx = i; break; }
}
assert.ok(endIdx > startIdx, "无法确定函数结束位置");
const fnSource = lines.slice(startIdx, endIdx + 1).join("\n");

const isWin = process.platform === "win32";
const linkType = isWin ? "junction" : "dir";
const opsLogs = [];

async function exists(p) { try { await lstat(p); return true; } catch { return false; } }
async function readJson(p) { try { return JSON.parse(await readFile(p, "utf8")); } catch { return null; } }
async function opsLog(entry) { opsLogs.push(entry); }

/** 用被测源码构造一个绑定到指定 ROOT 的 syncProfilesToDeploy */
function makeSync(root) {
  const factory = new Function(
    "ROOT", "join", "dirname", "readdir", "exists", "realpath", "lstat",
    "readJson", "rm", "mkdir", "symlink", "cp", "opsLog",
    `${fnSource}\nreturn syncProfilesToDeploy;`
  );
  return factory(root, join, dirname, readdir, exists, realpath, lstat, readJson, rm, mkdir, symlink, cp, opsLog);
}

async function makePkg(dir, name, version = "1.0.0") {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "package.json"), JSON.stringify({ name, version }), "utf8");
  await writeFile(join(dir, "index.js"), `// ${name}`, "utf8");
}

/** 布置一个 deploy + profile 环境 */
async function scaffold(pkgs) {
  const base = await mkdtemp(join(tmpdir(), "duc-fix-"));
  const root = join(base, "deploy");
  const profileNm = join(base, "profile", "node_modules");
  await mkdir(join(root, "node_modules", "@deepseek-ai"), { recursive: true });
  await mkdir(join(profileNm, "@deepseek-ai"), { recursive: true });
  for (const p of pkgs) {
    await makePkg(join(root, "node_modules", "@deepseek-ai", p), `@deepseek-ai/${p}`);
  }
  return { base, root, profileNm };
}

async function isLinkedTo(dst, src) {
  const st = await lstat(dst).catch(() => null);
  if (!st || !st.isSymbolicLink()) return false;
  const [a, b] = await Promise.all([realpath(dst).catch(() => null), realpath(src).catch(() => null)]);
  return Boolean(a && b && a === b);
}

test("场景A：全新包建为链接，而非实体复制（原 bug 的核心）", async () => {
  const { base, root, profileNm } = await scaffold(["dsh-aaa", "dsh-bbb", "dsh-ccc"]);
  try {
    // dsh-aaa 已是指向 deploy 的链接；bbb / ccc 在 profile 中不存在
    await symlink(
      join(root, "node_modules", "@deepseek-ai", "dsh-aaa"),
      join(profileNm, "@deepseek-ai", "dsh-aaa"),
      linkType
    );
    process.env.DSH_UC_UPDATE_PROFILE_NM = profileNm;
    const results = await makeSync(root)();

    const byName = Object.fromEntries(results.map((r) => [r.name, r]));
    assert.equal(byName["dsh-aaa"].skipped, "junction", "已存在的链接应跳过");
    assert.ok(byName["dsh-bbb"].ok && byName["dsh-ccc"].ok);

    for (const n of ["dsh-bbb", "dsh-ccc"]) {
      const dst = join(profileNm, "@deepseek-ai", n);
      assert.ok(
        await isLinkedTo(dst, join(root, "node_modules", "@deepseek-ai", n)),
        `${n} 应是指向 deploy 的链接，而不是实体副本`
      );
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("场景B：残留的实体副本被回收为链接（你机器上的实际故障）", async () => {
  const { base, root, profileNm } = await scaffold(["dsh-workflow-ptc"]);
  const dst = join(profileNm, "@deepseek-ai", "dsh-workflow-ptc");
  try {
    // 模拟 bug 的产物：一份实体目录副本，而非链接
    await makePkg(dst, "@deepseek-ai/dsh-workflow-ptc", "0.1.6-alpha.1");
    const st0 = await lstat(dst);
    assert.ok(st0.isDirectory() && !st0.isSymbolicLink(), "前置条件：应为实体目录");

    process.env.DSH_UC_UPDATE_PROFILE_NM = profileNm;
    const results = await makeSync(root)();
    assert.equal(results[0].ok, true);

    assert.ok(
      await isLinkedTo(dst, join(root, "node_modules", "@deepseek-ai", "dsh-workflow-ptc")),
      "实体副本应被替换为链接"
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("场景C：同名但不同来源的目录绝不被删除", async () => {
  const { base, root, profileNm } = await scaffold(["dsh-foreign"]);
  const dst = join(profileNm, "@deepseek-ai", "dsh-foreign");
  try {
    // 用户在 profile 里装的、与 deploy 无关的同名包
    await makePkg(dst, "@somebody-else/not-this-package", "9.9.9");
    process.env.DSH_UC_UPDATE_PROFILE_NM = profileNm;
    const results = await makeSync(root)();

    assert.equal(results[0].ok, false, "应报告失败而非静默处理");
    assert.match(results[0].error, /refusing to replace/);
    const after = await readJson(join(dst, "package.json"));
    assert.equal(after.name, "@somebody-else/not-this-package", "外来目录必须原封不动");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("场景D：悬空链接被重建", async () => {
  const { base, root, profileNm } = await scaffold(["dsh-dangling"]);
  const dst = join(profileNm, "@deepseek-ai", "dsh-dangling");
  try {
    // 指向一个不存在的旧 deploy 根
    await symlink(join(base, "gone", "dsh-dangling"), dst, linkType);
    process.env.DSH_UC_UPDATE_PROFILE_NM = profileNm;
    const results = await makeSync(root)();
    assert.equal(results[0].ok, true);
    assert.ok(
      await isLinkedTo(dst, join(root, "node_modules", "@deepseek-ai", "dsh-dangling")),
      "悬空链接应重建为指向当前 deploy"
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("场景E：非 dsh 前缀的包被忽略", async () => {
  const { base, root, profileNm } = await scaffold(["cordis", "dsh-real"]);
  try {
    process.env.DSH_UC_UPDATE_PROFILE_NM = profileNm;
    const results = await makeSync(root)();
    const names = results.map((r) => r.name);
    assert.deepEqual(names, ["dsh-real"], "只处理 dsh / dsh-* 前缀的包");
    assert.equal(await exists(join(profileNm, "@deepseek-ai", "cordis")), false);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("场景F：deploy 目录不可读时安全退出", async () => {
  const base = await mkdtemp(join(tmpdir(), "duc-fix-"));
  try {
    process.env.DSH_UC_UPDATE_PROFILE_NM = join(base, "profile", "node_modules");
    const out = await makeSync(join(base, "nonexistent"))();
    assert.equal(out.skipped, true);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
