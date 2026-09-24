import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import {
  IS_WIN32,
  parsePidList,
  buildPortProbe,
  buildPortProbeFallback,
  collectPortPids,
  probePortOpen,
  killPid,
  buildWorkerSpawn,
  detectPosixUpdateCaps,
  mainUpdatePlatformError,
  POWERSHELL_EXE,
} from '../lib/index.js';

test('parsePidList reads windows lines, ss pid= fields and bare lsof pids', () => {
  assert.deepEqual(parsePidList('1234\r\n5678\r\n'), [1234, 5678]);
  assert.deepEqual(
    parsePidList('LISTEN 0 511 127.0.0.1:3080 0.0.0.0:* users:(("node",pid=1397,fd=38))'),
    [1397]
  );
  assert.deepEqual(parsePidList('1397\n'), [1397]);
  assert.deepEqual(parsePidList(''), []);
  assert.deepEqual(parsePidList(null), []);
});

test('buildPortProbe: posix filter names the exact port, never every listener', () => {
  const posix = buildPortProbe('linux', 3080);
  assert.equal(posix.file, 'ss');
  assert.deepEqual(posix.args, ['-H', '-tlnp', 'sport = :3080']);

  const mac = buildPortProbe('darwin', 3081);
  assert.ok(mac.args.includes('sport = :3081'));

  const win = buildPortProbe('win32', 3080);
  assert.equal(win.file, POWERSHELL_EXE);
  assert.ok(win.args.join(' ').includes('-LocalPort 3080'));
});

test('buildPortProbeFallback: lsof keeps the port, win32 has no fallback', () => {
  const fb = buildPortProbeFallback('linux', 3080);
  assert.equal(fb.file, 'lsof');
  assert.deepEqual(fb.args, ['-tiTCP:3080', '-sTCP:LISTEN']);
  assert.equal(buildPortProbeFallback('win32', 3080), null);
});

test('buildWorkerSpawn: win32 keeps powershell Start-Process, posix spawns node detached', () => {
  const win = buildWorkerSpawn('win32', 'C:\\nodejs\\node.exe', 'C:\\x\\main-update-worker.mjs');
  assert.equal(win.file, POWERSHELL_EXE);
  assert.equal(win.detached, false);
  assert.ok(win.args.join(' ').includes('Start-Process'));

  for (const plat of ['linux', 'darwin']) {
    const posix = buildWorkerSpawn(plat, '/usr/bin/node', '/srv/scripts/main-update-worker.mjs');
    assert.equal(posix.file, '/usr/bin/node');
    assert.deepEqual(posix.args, ['/srv/scripts/main-update-worker.mjs']);
    assert.equal(posix.detached, true);
  }
});

test('probePortOpen sees a live listener and a dead port (both paths used by stop/start)', async () => {
  const server = net.createServer();
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const port = server.address().port;
  assert.equal(await probePortOpen(port), true);
  await new Promise((res) => server.close(res));
  assert.equal(await probePortOpen(port), false);
});

test('collectPortPids finds the process holding a live port', async () => {
  const server = net.createServer();
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const port = server.address().port;
  const found = await collectPortPids(port);
  await new Promise((res) => server.close(res));
  assert.ok(
    found.includes(process.pid),
    `expected ${process.pid} among ${JSON.stringify(found)} (platform ${process.platform})`
  );
});

test('killPid terminates a spawned child', async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(killPid(child.pid, IS_WIN32 ? 'win32' : 'linux'), true);
  const exited = await new Promise((res) => {
    const t = setTimeout(() => res(false), 8000);
    child.on('exit', () => {
      clearTimeout(t);
      res(true);
    });
  });
  assert.equal(exited, true, 'child should be gone after killPid');
  assert.equal(killPid(child.pid, IS_WIN32 ? 'win32' : 'linux'), true);
});

test('platform gate: windows always allowed, posix needs a port probe', () => {
  assert.equal(mainUpdatePlatformError('win32'), null);
  assert.equal(mainUpdatePlatformError('linux', { probe: true, systemctl: true }), null);
  assert.equal(mainUpdatePlatformError('darwin', { probe: true, systemctl: false }), null);

  for (const platform of ['linux', 'darwin']) {
    const err = mainUpdatePlatformError(platform, { probe: false, systemctl: true });
    assert.equal(err.code, 'E_PLATFORM_UNSUPPORTED');
    assert.match(err.error, /ss|lsof/);
  }
});

test('detectPosixUpdateCaps reports both probe helpers and systemctl on posix', () => {
  const caps = detectPosixUpdateCaps('linux');
  assert.equal(typeof caps.probe, 'boolean');
  assert.equal(typeof caps.systemctl, 'boolean');
  assert.deepEqual(detectPosixUpdateCaps('win32'), { probe: true, systemctl: true });
});
