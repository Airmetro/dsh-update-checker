import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let root;
let worker;

test.before(async () => {
  root = await mkdtemp(join(tmpdir(), 'duc-creep-'));
  await mkdir(join(root, 'node_modules', '@deepseek-ai', 'dsh'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0' }), 'utf8');
  process.env.DSH_UC_UPDATE_ROOT = root;
  process.env.DSH_UC_UPDATE_TARGET = '9.9.9';
  process.env.DSH_UC_UPDATE_BACKUP = join(root, '.backup');
  process.env.DSH_UC_UPDATE_PROGRESS = join(root, 'progress.json');
  process.env.DSH_UC_UPDATE_OPS = join(root, 'ops.log');
  process.env.DSH_UC_UPDATE_DSH_HOME = root;
  process.env.DSH_UC_UPDATE_NO_RUN = '1';
  worker = await import(new URL('../scripts/main-update-worker.mjs', import.meta.url).href);
});

test.after(async () => {
  await rm(root, { recursive: true, force: true });
});

test('phaseCreepPercent: monotonic, bounded and never stalls at the start', () => {
  const start = 10;
  const end = 55;
  let prev = start;
  for (const t of [0, 1000, 5000, 30000, 60000, 120000, 180000, 300000, 600000, 3600000]) {
    const p = worker.phaseCreepPercent(start, end, t, 180000);
    assert.ok(p >= start, `never below start at t=${t} (got ${p})`);
    assert.ok(p <= end, `never above end at t=${t} (got ${p})`);
    assert.ok(p >= prev, `monotonic at t=${t} (got ${p}, prev ${prev})`);
    prev = p;
  }
  assert.equal(worker.phaseCreepPercent(start, end, 0, 180000), start);
});

test('phaseCreepPercent: moves early enough that the bar never looks frozen', () => {
  const at30 = worker.phaseCreepPercent(10, 55, 30000, 180000);
  const at60 = worker.phaseCreepPercent(10, 55, 60000, 180000);
  const at180 = worker.phaseCreepPercent(10, 55, 180000, 180000);
  assert.ok(at30 - 10 >= 5, `30s should already show visible movement (got ${at30})`);
  assert.ok(at60 > at30, 'still moving at 60s');
  assert.ok(at180 >= 35 && at180 <= 41, `half-life should reach ~63% of the range (got ${at180})`);
  assert.ok(at180 <= 55);
});

test('phaseCreepPercent: guards a degenerate range and negative elapsed time', () => {
  assert.equal(worker.phaseCreepPercent(50, 50, 1000, 1000), 50);
  assert.equal(worker.phaseCreepPercent(60, 40, 1000, 1000), 40);
  assert.equal(worker.phaseCreepPercent(10, 55, -5000, 180000), 10);
});

test('countLockPackages: reads the lockfile package count, null when absent', async () => {
  assert.equal(await worker.countLockPackages(root), null);
  const lock = JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': { name: 'app' },
      'node_modules/a': { version: '1.0.0' },
      'node_modules/b': { version: '1.0.0' },
      'node_modules/c': { version: '1.0.0' },
    },
  });
  await writeFile(join(root, 'package-lock.json'), lock, 'utf8');
  assert.equal(await worker.countLockPackages(root), 3);
  await rm(join(root, 'package-lock.json'), { force: true });
});

test('startProgressTicker: writes a live, monotonic, in-range record every interval', async () => {
  const progressFile = process.env.DSH_UC_UPDATE_PROGRESS;
  const seen = [];
  const ticker = worker.startProgressTicker(10, 55, 300, (pct, sec) => ({
    phase: 'download',
    label: 'verifying',
    percent: pct,
    detail: `已等待 ${sec}s`,
  }), 100);
  const startedAt = Date.now();
  while (Date.now() - startedAt < 1500) {
    await new Promise((r) => setTimeout(r, 100));
    try {
      const p = JSON.parse(await readFile(progressFile, 'utf8'));
      seen.push(p);
    } catch {
      
    }
  }
  await ticker.stop();
  assert.ok(seen.length >= 5, `ticker should keep writing (got ${seen.length} records)`);
  let prev = 10;
  for (const p of seen) {
    assert.equal(p.running, true);
    assert.equal(p.workerPid, process.pid);
    assert.ok(p.percent >= prev, `monotonic (${p.percent} after ${prev})`);
    assert.ok(p.percent <= 55, `bounded (${p.percent})`);
    prev = p.percent;
  }
  assert.ok(seen[seen.length - 1].percent > seen[0].percent, 'percent must advance while a phase runs');

  const maxGap = seen.reduce((acc, p, i) => (i === 0 ? 0 : Math.max(acc, p.at - seen[i - 1].at)), 0);
  assert.ok(maxGap < 900, `record must be refreshed continuously (max gap ${maxGap}ms)`);
});

test('startProgressTicker: setFloor lets real signals push past the creep without rewinding', async () => {
  const progressFile = process.env.DSH_UC_UPDATE_PROGRESS;
  const ticker = worker.startProgressTicker(10, 55, 100000, (pct) => ({
    phase: 'download',
    label: 'verifying',
    percent: pct,
  }), 50);
  ticker.setFloor(40);
  await new Promise((r) => setTimeout(r, 150));
  const p = JSON.parse(await readFile(progressFile, 'utf8'));
  await ticker.stop();
  assert.ok(p.percent >= 40, `floor respected (got ${p.percent})`);
  assert.ok(p.percent <= 55, `end respected (got ${p.percent})`);
});

