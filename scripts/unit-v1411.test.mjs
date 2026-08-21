



import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { buildNodeExeCandidates, resolveNodeExe, getNpmCli } from '../lib/index.js';


test('buildNodeExeCandidates: node 形态 execPath 排第一（web 形态直接命中自身）', () => {
  const list = buildNodeExeCandidates(process.execPath, {});
  assert.equal(list[0], process.execPath);
});

test('buildNodeExeCandidates: Electron execPath 不会被当作 node，且含目录旁/系统候选（issue #8）', () => {
  const fake = 'C:\\Program Files\\DSH Desktop\\dsh-desktop.exe';
  const list = buildNodeExeCandidates(fake, {});
  assert.ok(!list.includes(fake), 'electron 自身不应作为候选');
  assert.ok(list.includes(join(dirname(fake), 'node.exe')), '应有 electron 目录旁 node.exe');
  assert.ok(list.includes(join(dirname(fake), '..', 'node.exe')), '应有上一级 node.exe');
  assert.ok(list.some((p) => p.includes('nodejs\\node.exe')), '应有 Program Files nodejs 候选');
  assert.ok(list.includes('C:\\nodejs\\node.exe'), '应有 C:\\nodejs 候选');
});

test('buildNodeExeCandidates: 去重，且 NODE / npm_node_execpath 参与候选', () => {
  const fake = 'C:\\app\\node.exe';
  const list = buildNodeExeCandidates(fake, {
    NODE: 'C:\\custom\\node.exe',
    npm_node_execpath: 'C:\\custom\\node.exe',
  });
  assert.equal(list.length, new Set(list).size, '候选不应重复');
  assert.ok(list.includes('C:\\custom\\node.exe'), 'NODE 环境变量候选应存在');
});

test('buildNodeExeCandidates: chrome/electron 关键字排除（防把浏览器二进制当 node）', () => {
  for (const fake of ['C:\\x\\electron.exe', 'C:\\x\\chrome.exe', 'C:\\x\\dsh-desktop.exe']) {
    const list = buildNodeExeCandidates(fake, {});
    assert.ok(!list.includes(fake), `${fake} 不应作为自身候选`);
  }
});


test('resolveNodeExe: web 形态返回自身（真实 node）', () => {
  assert.equal(resolveNodeExe(), process.execPath);
  assert.ok(existsSync(resolveNodeExe()));
});

test('getNpmCli: 解析到真实存在的 npm-cli.js', () => {
  const cli = getNpmCli();
  assert.ok(existsSync(cli), `npm-cli.js 应存在: ${cli}`);
});
