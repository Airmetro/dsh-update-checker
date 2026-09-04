import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

let root;
let worker;
const TARGET = '0.1.2-rc.1';

async function writeLockfile(p, version) {
  const lock = JSON.stringify({ name: 'app', lockfileVersion: 3, packages: { 'node_modules/@deepseek-ai/dsh': { version } } }, null, 2);
  await writeFile(join(p, 'package-lock.json'), lock, 'utf8');
  await writeFile(join(p, 'node_modules', '.package-lock.json'), lock, 'utf8');
}

test.before(async () => {
  root = await mkdtemp(join(tmpdir(), 'duc-stale-'));
  await mkdir(join(root, 'node_modules', '@deepseek-ai', 'dsh'), { recursive: true });
  await writeFile(join(root, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.2-alpha.5' }), 'utf8');
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'app', dependencies: { '@deepseek-ai/dsh': '0.1.2-alpha.5' } }), 'utf8');
  await writeLockfile(root, '0.1.2-rc.1');

  process.env.DSH_UC_UPDATE_ROOT = root;
  process.env.DSH_UC_UPDATE_TARGET = TARGET;
  process.env.DSH_UC_UPDATE_BACKUP = join(root, '.backup');
  process.env.DSH_UC_UPDATE_PROGRESS = join(root, 'progress.json');
  process.env.DSH_UC_UPDATE_OPS = join(root, 'ops.log');
  process.env.DSH_UC_UPDATE_DSH_HOME = root;
  process.env.DSH_UC_UPDATE_NO_RUN = '1';
  worker = await import(pathToFileURL('D:\\AI办公\\dsh-update-checker\\scripts\\main-update-worker.mjs').href);
});

test.after(async () => {
  await rm(root, { recursive: true, force: true });
});

test('worker resetStaleLockfilesIfNeeded: lock=rc.1 物理=alpha.5 -> 重置并删双 lockfile（R52 自愈）', async () => {
  const res = await worker.resetStaleLockfilesIfNeeded(TARGET);
  assert.equal(res.reset, true);
  assert.equal(res.physical, '0.1.2-alpha.5');
  assert.equal(res.locked, '0.1.2-rc.1');
  await assert.rejects(() => access(join(root, 'package-lock.json')));
  await assert.rejects(() => access(join(root, 'node_modules', '.package-lock.json')));
});

test('worker resetStaleLockfilesIfNeeded: lock 与物理一致 -> 不重置', async () => {
  await writeLockfile(root, '0.1.2-alpha.5');
  const res = await worker.resetStaleLockfilesIfNeeded(TARGET);
  assert.equal(res.reset, false);
});
