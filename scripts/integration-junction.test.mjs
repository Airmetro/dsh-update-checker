// 集成测试：junction 布局 —— profile 侧 @deepseek-ai/dsh 是指向部署侧的链接
// 验证：realpath 反推部署根、读穿 junction、同步时跳过同文件。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const isWin = process.platform === 'win32';
let base;
let deploy;
let profile;
let mod;

test.before(async () => {
  base = await mkdtemp(join(tmpdir(), 'duc-jct-'));
  deploy = join(base, 'deploy');
  profile = join(base, 'profile');

  await mkdir(join(deploy, 'node_modules', '@deepseek-ai', 'dsh'), { recursive: true });
  await writeFile(
    join(deploy, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh', version: '1.2.0' })
  );

  // profile 侧 @deepseek-ai/dsh 是 junction（Windows）/ dir symlink（POSIX）
  await mkdir(join(profile, 'node_modules', '@deepseek-ai'), { recursive: true });
  await symlink(
    join(deploy, 'node_modules', '@deepseek-ai', 'dsh'),
    join(profile, 'node_modules', '@deepseek-ai', 'dsh'),
    isWin ? 'junction' : 'dir'
  );

  process.env.DSH_UC_PROFILE_NODE_MODULES = join(profile, 'node_modules');
  delete process.env.DSH_DEPLOY_ROOT; // 强制走 junction 反推，而非 env 回退
  mod = await import('../lib/index.js');
});

test.after(async () => {
  await rm(base, { recursive: true, force: true });
});

test('findDeployRoot 通过 junction realpath 反推', async () => {
  assert.equal(await mod.findDeployRoot(), deploy);
});

test('readEcoVersions 能读穿 junction 拿到版本', async () => {
  assert.deepEqual(await mod.readEcoVersions(join(profile, 'node_modules')), { dsh: '1.2.0' });
});

test('planSync 在 junction 下版本一致 → 空计划', async () => {
  const { todo } = await mod.planSync(deploy);
  assert.deepEqual(todo, []);
});

test('runSync 对 junction（同文件）跳过而非自拷贝', async () => {
  // 即便强制一个版本差的计划，realpath 相同也应 skip，绝不自我拷贝
  const forced = [{ name: 'dsh', from: '0.0.0', to: '1.2.0' }];
  const results = await mod.runSync(deploy, forced);
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, true);
  assert.equal(results[0].skipped, 'same-file (junction)');
  // 部署侧文件未被破坏
  const pkg = JSON.parse(await readFile(join(deploy, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'));
  assert.equal(pkg.version, '1.2.0');
});
