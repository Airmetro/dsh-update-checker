import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findDshPackageDir, listDshPackageDirs, looksLikeFileLockError, installWithFileLockRetry, shouldResetStaleLock, verifyDeployTree } from '../lib/index.js';

async function makePkg(dir, version) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'pkg', version }), 'utf8');
}

test('findDshPackageDir: 顶层命中', async () => {
  const root = await mkdtemp(join(tmpdir(), 'duc-fw-'));
  try {
    const fw = join(root, 'node_modules', '@deepseek-ai', 'dsh-web-frontend');
    await makePkg(fw, '1.0.0');
    assert.equal(await findDshPackageDir(root, 'dsh-web-frontend'), fw);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('findDshPackageDir: npm -g 嵌套布局命中 dsh/node_modules 内', async () => {
  const root = await mkdtemp(join(tmpdir(), 'duc-fw2-'));
  try {
    const fw = join(root, 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-web-frontend');
    await makePkg(fw, '1.0.0');
    const found = await findDshPackageDir(root, 'dsh-web-frontend');
    assert.equal(found, fw);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('findDshPackageDir: 不存在返回 null', async () => {
  const root = await mkdtemp(join(tmpdir(), 'duc-fw3-'));
  try {
    assert.equal(await findDshPackageDir(root, 'dsh-web-frontend'), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('listDshPackageDirs: 顶层 + 嵌套并集', async () => {
  const root = await mkdtemp(join(tmpdir(), 'duc-list-'));
  try {
    const nm = join(root, 'node_modules', '@deepseek-ai');
    const dsh = join(nm, 'dsh');
    const nested = join(dsh, 'node_modules', '@deepseek-ai');
    await makePkg(dsh, '1.0.0');
    await makePkg(join(nm, 'dsh-cost'), '1.0.0');
    await makePkg(join(nested, 'dsh-web-frontend'), '1.0.0');
    const list = await listDshPackageDirs(root);
    const names = list.map((p) => p.name).sort();
    assert.deepEqual(names, ['dsh', 'dsh-cost', 'dsh-web-frontend']);
    const front = list.find((p) => p.name === 'dsh-web-frontend');
    assert.equal(front.dir, join(nested, 'dsh-web-frontend'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('verifyDeployTree: npm -g 嵌套布局通过（issue #16）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'duc-verify-'));
  try {
    const nm = join(root, 'node_modules', '@deepseek-ai');
    const dsh = join(nm, 'dsh');
    const nested = join(dsh, 'node_modules', '@deepseek-ai');
    await makePkg(dsh, '0.1.2-alpha.5');
    const fw = join(nested, 'dsh-web-frontend');
    await makePkg(fw, '0.1.2-alpha.5');
    const dist = join(fw, 'dist');
    await mkdir(dist, { recursive: true });
    await writeFile(join(dist, 'index.html'), '<html><script src="/assets/app.js"></script></html>', 'utf8');
    await mkdir(join(dist, 'assets'), { recursive: true });
    await writeFile(join(dist, 'assets', 'app.js'), 'console.log(1)', 'utf8');
    const cost = join(nested, 'dsh-cost');
    await makePkg(cost, '0.1.2-alpha.5');
    await mkdir(join(cost, 'lib'), { recursive: true });
    await writeFile(join(cost, 'lib', 'index.js'), 'export default 1', 'utf8');
    const res = await verifyDeployTree(root, '0.1.2-alpha.5');
    assert.equal(res.ok, true, JSON.stringify(res.problems));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('verifyDeployTree: 嵌套 dist 缺失时给出明确错误', async () => {
  const root = await mkdtemp(join(tmpdir(), 'duc-verify2-'));
  try {
    const nm = join(root, 'node_modules', '@deepseek-ai');
    const dsh = join(nm, 'dsh');
    await makePkg(dsh, '0.1.2-alpha.5');
    const res = await verifyDeployTree(root, '0.1.2-alpha.5');
    assert.equal(res.ok, false);
    assert.ok(res.problems.some((p) => /dsh-web-frontend not found/.test(p)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('looksLikeFileLockError: 识别 EBUSY / resource busy / EPERM', () => {
  assert.equal(looksLikeFileLockError({ message: 'EBUSY: resource busy or locked' }), true);
  assert.equal(looksLikeFileLockError({ stderr: 'npm ERR! code EBUSY' }), true);
  assert.equal(looksLikeFileLockError({ message: 'EPERM: operation not permitted' }), true);
  assert.equal(looksLikeFileLockError({ stderr: 'npm ERR! code ENOTEMPTY' }), true);
  assert.equal(looksLikeFileLockError({ message: 'ENOENT: no such file' }), false);
  assert.equal(looksLikeFileLockError({ message: 'npm ERR! code E404' }), false);
});

test('installWithFileLockRetry: EBUSY 失败一次后重试成功', async () => {
  let attempts = 0;
  let keepStoppedCalls = 0;
  let lockChecks = 0;
  const err = new Error('npm ERR! code EBUSY: resource busy or locked');
  err.code = 'EBUSY';
  err.stderr = 'npm ERR! code EBUSY';
  const res = await installWithFileLockRetry(
    () => { attempts++; if (attempts === 1) throw err; return { ok: true }; },
    {
      keepStopped: async () => { keepStoppedCalls++; return { ok: true }; },
      isPortLocked: async () => { lockChecks++; return true; },
      sleep: async () => {},
    }
  );
  assert.equal(res.ok, true);
  assert.equal(attempts, 2);
  assert.equal(keepStoppedCalls, 2);
  assert.equal(lockChecks, 1);
});

test('installWithFileLockRetry: 非文件锁错误立即放弃（不重试）', async () => {
  let attempts = 0;
  const err = new Error('npm ERR! code E404');
  err.code = 'E404';
  err.stderr = 'npm ERR! code E404';
  const res = await installWithFileLockRetry(
    () => { attempts++; throw err; },
    { keepStopped: async () => ({ ok: true }), isPortLocked: async () => false, sleep: async () => {} }
  );
  assert.equal(res.ok, false);
  assert.equal(attempts, 1);
  assert.equal(res.error.message, 'npm ERR! code E404');
});

test('installWithFileLockRetry: keepStopped 失败返回 E_STOP', async () => {
  const res = await installWithFileLockRetry(
    async () => ({ ok: true }),
    { keepStopped: async () => ({ ok: false, error: 'port 3080 still listening' }), sleep: async () => {} }
  );
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'E_STOP');
});

test('installWithFileLockRetry: 端口持续被占用耗尽重试', async () => {
  let attempts = 0;
  const err = new Error('EPERM: operation not permitted');
  err.code = 'EPERM';
  err.stderr = 'npm ERR! code EPERM';
  const res = await installWithFileLockRetry(
    () => { attempts++; throw err; },
    { maxAttempts: 3, keepStopped: async () => ({ ok: true }), isPortLocked: async () => true, sleep: async () => {} }
  );
  assert.equal(res.ok, false);
  assert.equal(attempts, 3);
});

test('shouldResetStaleLock: lockfile 声明目标但物理仍是旧版本 -> 重置', () => {
  assert.equal(shouldResetStaleLock('0.1.2-alpha.5', '0.1.2-rc.1', '0.1.2-rc.1'), true);
  assert.equal(shouldResetStaleLock('0.1.2-alpha.5', '0.1.2-rc.1', '0.1.2-rc.2'), true);
});

test('shouldResetStaleLock: 物理已达目标 / lock 与物理一致 / 缺失 -> 不重置', () => {
  assert.equal(shouldResetStaleLock('0.1.2-rc.1', '0.1.2-rc.1', '0.1.2-rc.1'), false);
  assert.equal(shouldResetStaleLock('0.1.2-alpha.5', '0.1.2-alpha.5', '0.1.2-rc.1'), false);
  assert.equal(shouldResetStaleLock(null, '0.1.2-rc.1', '0.1.2-rc.1'), false);
  assert.equal(shouldResetStaleLock('0.1.2-alpha.5', null, '0.1.2-rc.1'), false);
});
