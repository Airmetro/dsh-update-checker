

import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pnpmCandidates } from '../lib/index.js';

const WIN_NPM = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js';
const LINUX_NPM = '/usr/local/lib/node_modules/npm/bin/npm-cli.js';

const J = (...p) => join(...p);

test('pnpmCandidates: win32 用 corepack.cmd/.exe，不用无扩展名 bash shim', () => {
  const list = pnpmCandidates('C:\\Program Files\\nodejs', WIN_NPM, 'win32');
  const cmds = list.map((c) => c.cmd);
  assert.ok(cmds.includes(J('C:\\Program Files\\nodejs', 'corepack.cmd')));
  assert.ok(cmds.includes(J('C:\\Program Files\\nodejs', 'corepack.exe')));
  assert.ok(!cmds.includes(J('C:\\Program Files\\nodejs', 'corepack'))); 
  assert.ok(!cmds.includes(J('C:\\Program Files\\nodejs', 'pnpm'))); 
  
  assert.ok(cmds.includes(J('C:\\Program Files\\nodejs', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')));
  assert.ok(cmds.includes(J('C:\\Program Files\\nodejs', 'node_modules', 'pnpm', 'bin', 'pnpm.cmd')));
});

test('pnpmCandidates: linux/darwin 用无扩展名 shim + corepack + lib 布局', () => {
  for (const plat of ['linux', 'darwin']) {
    const list = pnpmCandidates('/usr/local/bin', LINUX_NPM, plat);
    const cmds = list.map((c) => c.cmd);
    assert.ok(cmds.includes(J('/usr/local/bin', 'pnpm')));
    assert.ok(cmds.includes(J('/usr/local/bin', 'corepack')));
    assert.ok(!cmds.includes(J('/usr/local/bin', 'corepack.cmd'))); 
    
    assert.ok(cmds.includes(J('/usr/local/lib/node_modules', 'pnpm', 'bin', 'pnpm.cjs')));
  }
});

test('pnpmCandidates: exeDir 旁 cjs 与 .. /lib 布局均保留', () => {
  const list = pnpmCandidates('/usr/local/bin', LINUX_NPM, 'linux');
  const cmds = list.map((c) => c.cmd);
  assert.ok(cmds.includes(J('/usr/local/bin', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'))); 
  assert.ok(cmds.includes(J('/usr/local/lib/node_modules', 'pnpm', 'bin', 'pnpm.cjs'))); 
});

test('pnpmCandidates: npmCli 缺失时只返回确定性候选', () => {
  const list = pnpmCandidates('C:\\node', null, 'win32');
  assert.equal(list.length, 4); 
  const listU = pnpmCandidates('/usr/bin', null, 'linux');
  assert.equal(listU.length, 4); 
});

test('pnpmCandidates: 候选标记正确（viaNode/corepack）', () => {
  const list = pnpmCandidates('C:\\Program Files\\nodejs', WIN_NPM, 'win32');
  const corepackCmd = list.find((c) => c.cmd.endsWith('corepack.cmd'));
  assert.ok(corepackCmd && corepackCmd.corepack === true && corepackCmd.viaNode === false);
  const cjs = list.find((c) => c.cmd.endsWith(J('node_modules', 'pnpm', 'bin', 'pnpm.cjs')));
  assert.ok(cjs && cjs.viaNode === true && cjs.corepack === false);
});
