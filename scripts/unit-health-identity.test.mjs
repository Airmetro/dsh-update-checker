/**
 * 实例身份校验（v1.5.0）。
 *
 * 背景：安装成功后的健康检查原先只要求"3080 端口有人应答"——200 就扫资源，
 * 401/403/407 直接判成功。于是在 composeProfile 阶段就崩掉的机器上，它照样
 * 报告"更新成功"（实机事故：更新 0.1.6-alpha.1 后启动即崩，插件日志却是
 * main-update-ok）。
 *
 * 现在把插件自己的路由当作身份探针：重启前的实例 id 由宿主通过
 * DSH_UC_UPDATE_PREV_INSTANCE 传进来，只有探到的 instanceId 与它不同，才说明
 * 真的是新进程在服务。探不到（插件未组合、路由未就绪、宿主版本较旧）时保持
 * 原有行为，绝不把可能健康的更新误判为失败。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const PREV = '111-prev';
let root;
let server;
let port;
let servedInstanceId = PREV;
let worker;

const loadWorker = (tag) =>
  import(new URL('../scripts/main-update-worker.mjs', import.meta.url).href + `?tag=${tag}&port=${port}`);

test.before(async () => {
  root = await mkdtemp(join(tmpdir(), 'duc-identity-'));
  await mkdir(join(root, 'node_modules', '@deepseek-ai', 'dsh'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0' }), 'utf8');

  server = http.createServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(401, { 'content-type': 'text/plain' });
      res.end('unauthorized');
      return;
    }
    if (req.url === '/dsh-update-checker/update-progress.json') {
      if (servedInstanceId === null) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('no progress');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ phase: 'health', instanceId: servedInstanceId }));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('nope');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;

  process.env.DSH_UC_UPDATE_ROOT = root;
  process.env.DSH_UC_UPDATE_TARGET = '9.9.9';
  process.env.DSH_UC_UPDATE_BACKUP = join(root, '.backup');
  process.env.DSH_UC_UPDATE_PROGRESS = join(root, 'progress.json');
  process.env.DSH_UC_UPDATE_OPS = join(root, 'ops.log');
  process.env.DSH_UC_UPDATE_DSH_HOME = root;
  process.env.DSH_UC_UPDATE_NO_RUN = '1';
  process.env.DSH_UC_UPDATE_PORT = String(port);
  process.env.DSH_UC_UPDATE_PREV_INSTANCE = PREV;
  worker = await loadWorker('base');
});

test.after(async () => {
  await new Promise((r) => server.close(r));
  delete process.env.DSH_UC_UPDATE_PORT;
  delete process.env.DSH_UC_UPDATE_PREV_INSTANCE;
  await rm(root, { recursive: true, force: true });
});

test('classifyInstanceIdentity: fresh / stale / unavailable', () => {
  assert.equal(worker.classifyInstanceIdentity(PREV, '222-next'), 'fresh');
  assert.equal(worker.classifyInstanceIdentity(PREV, PREV), 'stale');
  assert.equal(worker.classifyInstanceIdentity('', '222-next'), 'unavailable', '宿主未提供旧实例 id 时不下判断');
  assert.equal(worker.classifyInstanceIdentity(PREV, ''), 'unavailable');
  assert.equal(worker.classifyInstanceIdentity(PREV, null), 'unavailable');
  assert.equal(worker.classifyInstanceIdentity(PREV, undefined), 'unavailable');
});

test('宿主与 worker 用同一个环境变量名传递上一实例 id（防止静默漂移成 unavailable）', async () => {
  const lib = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8');
  const src = await readFile(new URL('../scripts/main-update-worker.mjs', import.meta.url), 'utf8');
  assert.ok(lib.includes('DSH_UC_UPDATE_PREV_INSTANCE'), '宿主半身应把上一实例 id 传给 worker');
  assert.ok(lib.includes('INSTANCE_ID'), '宿主半身应传入自己当前的实例 id');
  assert.ok(src.includes('DSH_UC_UPDATE_PREV_INSTANCE'), 'worker 应读取该环境变量');
});

test('healthCheck: 同一个旧实例还在应答 -> 判失败（这正是实机事故的形状）', async () => {
  servedInstanceId = PREV;
  const fresh = await loadWorker('stale');
  const res = await fresh.healthCheck();
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.match(String(res.error), /instance identity/);
  assert.match(String(res.error), new RegExp(PREV));
});

test('healthCheck: 探到新实例 id -> 判成功，并在 notes 里说明依据', async () => {
  servedInstanceId = '222-next';
  const fresh = await loadWorker('fresh');
  const res = await fresh.healthCheck();
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.ok(res.notes.some((n) => n.includes('new process')), JSON.stringify(res.notes));
});

test('healthCheck: 探针拿不到身份（插件路由未组合/未就绪）-> 保持原有行为，不误报失败', async () => {
  servedInstanceId = null;
  const fresh = await loadWorker('unavailable');
  const res = await fresh.healthCheck();
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.ok(res.notes.some((n) => n.includes('unavailable')), JSON.stringify(res.notes));
});

test('healthCheck: 宿主太旧没传 prev instance -> 不下判断，行为与 1.4.23 一致', async () => {
  servedInstanceId = PREV;
  delete process.env.DSH_UC_UPDATE_PREV_INSTANCE;
  try {
    const fresh = await loadWorker('noprev');
    const res = await fresh.healthCheck();
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.ok(res.notes.some((n) => n.includes('unavailable')), JSON.stringify(res.notes));
  } finally {
    process.env.DSH_UC_UPDATE_PREV_INSTANCE = PREV;
  }
});
