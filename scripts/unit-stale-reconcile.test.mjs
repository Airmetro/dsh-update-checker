import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, utimes, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

let home;
let mod;

const progressFile = () => join(home, 'dsh-update-checker-update-progress.json');
const lockFile = () => join(home, 'dsh-update-checker-update.lock');

async function deadPid() {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  const pid = child.pid;
  await new Promise((resolve) => child.on('close', resolve));
  return pid;
}

test.before(async () => {
  home = await mkdtemp(join(tmpdir(), 'duc-reconcile-'));
  await mkdir(join(home, 'profiles', 'node_modules'), { recursive: true });
  process.env.DSH_UC_PROFILE_NODE_MODULES = join(home, 'profiles', 'node_modules');
  mod = await import(new URL('../lib/index.js', import.meta.url).href);
});

test.after(async () => {
  await rm(home, { recursive: true, force: true });
});

test('stale state is redirected to the temp home (guard for this suite)', async () => {
  await mod.writeProgress({ phase: 'check', label: 'redirect check', percent: 2 });
  const p = JSON.parse(await readFile(progressFile(), 'utf8'));
  assert.equal(p.hostPid, process.pid);
  await mod.clearProgress();
});

test('reconcileStaleUpdateState: a live owner (this process) is never reconciled', async () => {
  await mod.writeProgress({ phase: 'install', label: 'running', percent: 70 });
  const res = await mod.reconcileStaleUpdateState('test live owner');
  assert.equal(res.changed, false);
  const p = JSON.parse(await readFile(progressFile(), 'utf8'));
  assert.equal(p.running, true);
  assert.equal(p.phase, 'install');
  await mod.clearProgress();
});

test('reconcileStaleUpdateState: a dead worker pid clears the stuck banner and the lock (issue #25)', async () => {
  const pid = await deadPid();
  await mod.writeProgressRecord({
    at: Date.now(),
    running: true,
    workerPid: pid,
    phase: 'install',
    label: '正在安装新版本…',
    percent: 70,
    detail: '已解析 12/587 个包',
  });
  await writeFile(lockFile(), JSON.stringify({ at: Date.now(), pid: 12345 }), 'utf8');

  assert.equal(mod.isStaleProgress(JSON.parse(await readFile(progressFile(), 'utf8'))), true);
  const res = await mod.reconcileStaleUpdateState('test dead worker');
  assert.equal(res.changed, true);

  const p = JSON.parse(await readFile(progressFile(), 'utf8'));
  assert.equal(p.running, false);
  assert.equal(p.phase, 'error');
  assert.equal(p.code, 'E_INTERRUPTED');
  assert.equal(p.stale, true);
  assert.equal(p.percent, null);
  assert.equal(p.workerPid, undefined);
  await assert.rejects(() => stat(lockFile()), 'the stale update lock must be released');
  await mod.clearProgress();
});

test('reconcileStaleUpdateState: a live background worker keeps its progress record', async () => {
  await mod.writeProgress({ phase: 'install', label: 'running', percent: 70, workerPid: process.pid });
  const res = await mod.reconcileStaleUpdateState('test live worker');
  assert.equal(res.changed, false);
  await mod.clearProgress();
});

test('reconcileStaleUpdateState: an old record without pids is reconciled by age', async () => {
  await mod.writeProgressRecord({
    at: Date.now() - 11 * 60 * 1000,
    running: true,
    phase: 'download',
    label: '正在检查依赖树…',
    percent: 6,
  });
  const res = await mod.reconcileStaleUpdateState('test aged record');
  assert.equal(res.changed, true);
  const p = JSON.parse(await readFile(progressFile(), 'utf8'));
  assert.equal(p.code, 'E_INTERRUPTED');
  await mod.clearProgress();
});

test('reconcileStaleUpdateLock: keeps a fresh lock, drops an old lock with no live worker', async () => {
  await writeFile(lockFile(), JSON.stringify({ at: Date.now(), pid: process.pid }), 'utf8');
  let res = await mod.reconcileStaleUpdateLock();
  assert.equal(res.changed, false);
  assert.equal(res.fresh, true);

  const old = new Date(Date.now() - 30 * 60 * 1000);
  await utimes(lockFile(), old, old);
  res = await mod.reconcileStaleUpdateLock();
  assert.equal(res.changed, true);
  await assert.rejects(() => stat(lockFile()));
});

test('reconcileStaleUpdateLock: an old lock is kept while a background worker is alive', async () => {
  await mod.writeProgress({ phase: 'install', label: 'running', percent: 70, workerPid: process.pid });
  await writeFile(lockFile(), JSON.stringify({ at: Date.now(), pid: process.pid }), 'utf8');
  const old = new Date(Date.now() - 30 * 60 * 1000);
  await utimes(lockFile(), old, old);
  const res = await mod.reconcileStaleUpdateLock();
  assert.equal(res.changed, false);
  assert.equal(res.live, true);
  await stat(lockFile());
  await mod.clearProgress();
  await rm(lockFile(), { force: true });
});

test('reconcileStaleUpdateLock: no lock file is a no-op', async () => {
  await rm(lockFile(), { force: true });
  const res = await mod.reconcileStaleUpdateLock();
  assert.equal(res.changed, false);
  assert.equal(res.absent, true);
  assert.ok((await readdir(home)).length >= 0);
});
