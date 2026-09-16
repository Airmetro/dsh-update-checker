import test from 'node:test';
import assert from 'node:assert/strict';
import { isStaleProgressRecord, pidAlive } from '../lib/index.js';

const NOW = 1_700_000_000_000;
const STALE = 600000;

const opts = (alivePids = []) => ({
  now: NOW,
  staleMs: STALE,
  alive: (pid) => alivePids.includes(Number(pid)),
});

test('isStaleProgressRecord: not running is never stale', () => {
  assert.equal(isStaleProgressRecord(null, opts()), false);
  assert.equal(isStaleProgressRecord({}, opts()), false);
  assert.equal(isStaleProgressRecord({ running: false, phase: 'error' }, opts()), false);
  assert.equal(isStaleProgressRecord({ running: false, phase: 'done', at: NOW - 10 * STALE }, opts()), false);
});

test('isStaleProgressRecord: live worker pid keeps the record alive', () => {
  const p = { running: true, workerPid: 4242, at: NOW - 10 * STALE };
  assert.equal(isStaleProgressRecord(p, opts([4242])), false);
});

test('isStaleProgressRecord: dead worker pid marks the record stale immediately', () => {
  const p = { running: true, workerPid: 4242, at: NOW };
  assert.equal(isStaleProgressRecord(p, opts([])), true);
});

test('isStaleProgressRecord: dead host pid (no worker yet) marks the record stale', () => {
  const p = { running: true, hostPid: 111, phase: 'backup', at: NOW };
  assert.equal(isStaleProgressRecord(p, opts([])), true);
  assert.equal(isStaleProgressRecord(p, opts([111])), false);
});

test('isStaleProgressRecord: worker pid wins over a live host pid', () => {
  const p = { running: true, hostPid: 111, workerPid: 222, at: NOW };
  assert.equal(isStaleProgressRecord(p, opts([111])), true);
  assert.equal(isStaleProgressRecord(p, opts([111, 222])), false);
});

test('isStaleProgressRecord: without pids falls back to record age', () => {
  assert.equal(isStaleProgressRecord({ running: true, at: NOW - STALE + 1 }, opts()), false);
  assert.equal(isStaleProgressRecord({ running: true, at: NOW - STALE - 1 }, opts()), true);
  assert.equal(isStaleProgressRecord({ running: true }, opts()), false);
});

test('isStaleProgressRecord: explicit stale flag is honoured', () => {
  assert.equal(isStaleProgressRecord({ running: true, stale: true, workerPid: 1 }, opts([1])), true);
});

test('pidAlive: current process is alive, absurd pids are not', () => {
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(0), false);
  assert.equal(pidAlive(-5), false);
  assert.equal(pidAlive('not-a-pid'), false);
  assert.equal(pidAlive(null), false);
});
