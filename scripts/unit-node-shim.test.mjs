
import test from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import {
  npmCliCandidates,
  locateNpmCli,
  realNodeFromExecPath,
  resolveRealNode,
} from '../lib/index.js';

function makeShimLayout() {
  const base = join(tmpdir(), 'uc-shim-test-' + process.pid + '-' + Date.now());
  const realBin = join(base, 'installs', 'node', '24.19.0', 'bin');
  const shimDir = join(base, 'shims');
  const npmBin = join(base, 'installs', 'node', '24.19.0', 'lib', 'node_modules', 'npm', 'bin');
  mkdirSync(realBin, { recursive: true });
  mkdirSync(shimDir, { recursive: true });
  mkdirSync(npmBin, { recursive: true });
  const realNode = join(realBin, process.platform === 'win32' ? 'node.exe' : 'node');
  copyFileSync(process.execPath, realNode);
  const shim = join(shimDir, process.platform === 'win32' ? 'node.cmd' : 'node');
  if (process.platform === 'win32') {
    writeFileSync(shim, `@echo off\r\ncall "${realNode}" %*\r\n`);
  } else {
    writeFileSync(shim, `#!/bin/sh\nexec "${realNode}" "$@"\r\n`);
  }
  const npmCli = join(npmBin, 'npm-cli.js');
  writeFileSync(npmCli, 'npm-cli.js stub\n');
  return { base, realBin, shimDir, realNode, shim, npmCli };
}

test('npmCliCandidates: 返回四个标准相对布局', () => {
  const list = npmCliCandidates('/usr/local/bin');
  assert.equal(list.length, 4);
  assert.ok(list.includes(join('/usr/local/bin', 'node_modules', 'npm', 'bin', 'npm-cli.js')));
  assert.ok(list.includes(join('/usr/local', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')));
  assert.ok(list.includes(join('/usr/local', 'node_modules', 'npm', 'bin', 'npm-cli.js')));
  assert.ok(list.includes(join('/usr/local', 'libexec', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')));
});

test('locateNpmCli: 命中真实 npm-cli.js（web 形态）', () => {
  const cli = locateNpmCli(dirname(process.execPath));
  assert.ok(existsSync(cli), `npm-cli.js 应存在: ${cli}`);
});

test('locateNpmCli: 无 npm 时抛 ENPMCLI（不静默 fallback 到不存在路径）', () => {
  const empty = join(tmpdir(), 'uc-no-npm-' + process.pid + '-' + Date.now());
  mkdirSync(empty, { recursive: true });
  assert.throws(() => locateNpmCli(empty), (e) => e.code === 'ENPMCLI');
});

test('realNodeFromExecPath: 真实 node 返回其自身路径（不会误判 shim）', () => {
  const out = realNodeFromExecPath(process.execPath);
  assert.ok(out === null || out === process.execPath);
});

test('resolveRealNode: shim 目录无 npm → 解析到真实 node（issue #17）', () => {
  const { base, shim, realNode } = makeShimLayout();
  const got = resolveRealNode(shim);
  assert.ok(got, '应解析到真实 node');
  assert.ok(existsSync(got), `解析结果应存在: ${got}`);
  assert.notEqual(got, shim, '不应再返回 shim 路径');
  assert.equal(got, realNode, '应解析到真实 node 二进制');
});

test('resolveRealNode: 目录旁有 npm → 原样返回（不 spawn）', () => {
  const { base, shim, npmCli } = makeShimLayout();
  const shimDir = dirname(shim);
  const npmDir = join(shimDir, 'node_modules', 'npm', 'bin');
  mkdirSync(npmDir, { recursive: true });
  writeFileSync(join(npmDir, 'npm-cli.js'), 'stub\n');
  const got = resolveRealNode(shim);
  assert.equal(got, shim, '目录旁有 npm 时应原样返回 shim（这是被识别为真实安装的情况）');
});
