import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import {
  IS_WIN32,
  parsePidList,
  buildPortProbe,
  collectPortPids,
  killPid,
  buildWorkerSpawn,
} from '../lib/index.js';

test('platform const matches runtime', () => {
  assert.equal(IS_WIN32, process.platform === 'win32');
});

test('buildWorkerSpawn: win32 delegates through powershell Start-Process', () => {
  const s = buildWorkerSpawn('win32', 'C:\\nodejs\\node.exe', 'C:\\x\\main-update-worker.mjs');
  assert.match(s.file, /powershell\.exe$/i);
  assert.ok(s.args.join(' ').includes('Start-Process'));
  assert.ok(s.args.join(' ').includes('main-update-worker.mjs'));
  assert.equal(s.detached, false);
});

test('buildWorkerSpawn: posix spawns node directly, detached (linux/darwin)', () => {
  for (const plat of ['linux', 'darwin']) {
    const s = buildWorkerSpawn(plat, '/usr/local/bin/node', '/x/main-update-worker.mjs');
    assert.equal(s.file, '/usr/local/bin/node');
    assert.deepEqual(s.args, ['/x/main-update-worker.mjs']);
    assert.equal(s.detached, true);
  }
});

test('parsePidList handles win lines, ss pid= and bare lsof pids', () => {
  assert.deepEqual(parsePidList('1234\r\n5678\r\n'), [1234, 5678]);
  assert.deepEqual(
    parsePidList('LISTEN 0 511 127.0.0.1:3080 0.0.0.0:* users:(("node",pid=1397,fd=38))'),
    [1397]
  );
  assert.deepEqual(parsePidList('1397\n'), [1397]);
  assert.deepEqual(parsePidList(''), []);
  assert.deepEqual(parsePidList(null), []);
});

test('buildPortProbe: win32 powershell / posix sh with port', () => {
  const w = buildPortProbe('win32', 3080);
  assert.match(w.file, /powershell\.exe$/i);
  assert.ok(w.args.join(' ').includes('3080'));
  for (const plat of ['linux', 'darwin']) {
    const p = buildPortProbe(plat, 3080);
    assert.equal(p.file, 'sh');
    assert.ok(p.args.join(' ').includes('3080'));
  }
});

test('collectPortPids finds a live listener and drops it after close (posix)', async () => {
  if (process.platform === 'win32') return;
  const server = net.createServer();
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const port = server.address().port;
  const found = await collectPortPids(port, 'linux');
  assert.ok(found.includes(process.pid), `expected ${process.pid} in ${JSON.stringify(found)}`);
  await new Promise((res) => server.close(res));
  await new Promise((r) => setTimeout(r, 500));
  const gone = await collectPortPids(port, 'linux');
  assert.ok(!gone.includes(process.pid), `pid should be gone: ${JSON.stringify(gone)}`);
});

test('killPid terminates a spawned child (posix)', async () => {
  if (process.platform === 'win32') return;
  const child = spawn('sleep', ['30']);
  assert.equal(typeof child.pid, 'number');
  assert.equal(killPid(child.pid, 'linux'), true);
  const result = await new Promise((res) => child.on('exit', (code, signal) => res({ code, signal })));
  assert.equal(result.signal, 'SIGKILL', `expected SIGKILL, got ${JSON.stringify(result)}`);
});
