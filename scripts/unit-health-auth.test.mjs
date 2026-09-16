import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { classifyHealthStatus as hostClassify } from '../lib/index.js';

let root;
let worker;

test.before(async () => {
  root = await mkdtemp(join(tmpdir(), 'duc-health-'));
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

const CASES = [
  [200, 'ok'],
  [201, 'bad'],
  [204, 'bad'],
  [301, 'bad'],
  [401, 'auth-gated'],
  [403, 'auth-gated'],
  [407, 'auth-gated'],
  [404, 'bad'],
  [500, 'bad'],
  [502, 'bad'],
  [0, 'unreachable'],
  [null, 'unreachable'],
  [undefined, 'unreachable'],
  ['not-a-status', 'unreachable'],
];

test('classifyHealthStatus (host half): HTTP answers that prove the service is up', () => {
  for (const [status, expected] of CASES) {
    assert.equal(hostClassify(status), expected, `host classifyHealthStatus(${status})`);
  }
});

test('classifyHealthStatus (worker half): auth-gated frontends are not failures', () => {
  for (const [status, expected] of CASES) {
    assert.equal(worker.classifyHealthStatus(status), expected, `worker classifyHealthStatus(${status})`);
  }
});

test('healthCheck: an auth-gated GET / counts as healthy and skips the asset sweep', async () => {
  const http = await import('node:http');
  const port = 3998;
  const server = http.createServer((req, res) => {
    res.writeHead(401, { 'content-type': 'text/plain' });
    res.end('unauthorized');
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  process.env.DSH_UC_UPDATE_PORT = String(port);
  const fresh = await import(new URL('../scripts/main-update-worker.mjs', import.meta.url).href + `?p=${port}`);
  try {
    const res = await fresh.healthCheck();
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.ok(res.notes.some((n) => n.includes('auth-gated')), JSON.stringify(res.notes));
    const ops = await (await import('node:fs/promises')).readFile(join(root, 'ops.log'), 'utf8');
    assert.ok(ops.includes('main-update-health-auth-gated'), ops);
  } finally {
    await new Promise((r) => server.close(r));
    delete process.env.DSH_UC_UPDATE_PORT;
  }
});

test('healthCheck: a 500 or a dead port is still a failure', async () => {
  const http = await import('node:http');
  const port = 3997;
  const server = http.createServer((req, res) => {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('boom');
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  process.env.DSH_UC_UPDATE_PORT = String(port);
  const fresh = await import(new URL('../scripts/main-update-worker.mjs', import.meta.url).href + `?p=${port}`);
  try {
    const bad = await fresh.healthCheck();
    assert.equal(bad.ok, false, JSON.stringify(bad));
    assert.ok(String(bad.error).includes('500'), bad.error);
  } finally {
    await new Promise((r) => server.close(r));
  }
  process.env.DSH_UC_UPDATE_PORT = '3996';
  const dead = await import(new URL('../scripts/main-update-worker.mjs', import.meta.url).href + '?p=3996');
  const res = await dead.healthCheck();
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.ok(String(res.error).includes('no response'), res.error);
  delete process.env.DSH_UC_UPDATE_PORT;
});
