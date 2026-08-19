// 单元测试：v1.4.7 新增纯函数 pnpmCandidates —— 跨平台 pnpm 定位候选列表
// （findPnpm 本体依赖 fs/环境，DSH_UC_PNPM_BIN 路径已由 integration-persist.test.mjs 覆盖）
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pnpmCandidates } from '../lib/index.js';

const WIN_NPM = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js';
const LINUX_NPM = '/usr/local/lib/node_modules/npm/bin/npm-cli.js';
// join 在 Windows 上产出反斜杠、Unix 上产出正斜杠——期望值一律用 join 构造以适配运行平台
const J = (...p) => join(...p);

test('pnpmCandidates: win32 用 corepack.cmd/.exe，不用无扩展名 bash shim', () => {
  const list = pnpmCandidates('C:\\Program Files\\nodejs', WIN_NPM, 'win32');
  const cmds = list.map((c) => c.cmd);
  assert.ok(cmds.includes(J('C:\\Program Files\\nodejs', 'corepack.cmd')));
  assert.ok(cmds.includes(J('C:\\Program Files\\nodejs', 'corepack.exe')));
  assert.ok(!cmds.includes(J('C:\\Program Files\\nodejs', 'corepack'))); // 无扩展名 bash shim 排除
  assert.ok(!cmds.includes(J('C:\\Program Files\\nodejs', 'pnpm'))); // 无扩展名 shim 排除
  // npm 全局前缀推导：NPM_CLI 三级 dirname → <prefix>/node_modules
  assert.ok(cmds.includes(J('C:\\Program Files\\nodejs', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')));
  assert.ok(cmds.includes(J('C:\\Program Files\\nodejs', 'node_modules', 'pnpm', 'bin', 'pnpm.cmd')));
});

test('pnpmCandidates: linux/darwin 用无扩展名 shim + corepack + lib 布局', () => {
  for (const plat of ['linux', 'darwin']) {
    const list = pnpmCandidates('/usr/local/bin', LINUX_NPM, plat);
    const cmds = list.map((c) => c.cmd);
    assert.ok(cmds.includes(J('/usr/local/bin', 'pnpm')));
    assert.ok(cmds.includes(J('/usr/local/bin', 'corepack')));
    assert.ok(!cmds.includes(J('/usr/local/bin', 'corepack.cmd'))); // Unix 不需要 .cmd
    // npm 全局前缀推导：<prefix>/lib/node_modules
    assert.ok(cmds.includes(J('/usr/local/lib/node_modules', 'pnpm', 'bin', 'pnpm.cjs')));
  }
});

test('pnpmCandidates: exeDir 旁 cjs 与 .. /lib 布局均保留', () => {
  const list = pnpmCandidates('/usr/local/bin', LINUX_NPM, 'linux');
  const cmds = list.map((c) => c.cmd);
  assert.ok(cmds.includes(J('/usr/local/bin', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'))); // Windows 型 node 旁
  assert.ok(cmds.includes(J('/usr/local/lib/node_modules', 'pnpm', 'bin', 'pnpm.cjs'))); // exeDir/../lib
});

test('pnpmCandidates: npmCli 缺失时只返回确定性候选', () => {
  const list = pnpmCandidates('C:\\node', null, 'win32');
  assert.equal(list.length, 4); // cjs + lib + corepack.cmd + corepack.exe
  const listU = pnpmCandidates('/usr/bin', null, 'linux');
  assert.equal(listU.length, 4); // cjs + lib + pnpm shim + corepack
});

test('pnpmCandidates: 候选标记正确（viaNode/corepack）', () => {
  const list = pnpmCandidates('C:\\Program Files\\nodejs', WIN_NPM, 'win32');
  const corepackCmd = list.find((c) => c.cmd.endsWith('corepack.cmd'));
  assert.ok(corepackCmd && corepackCmd.corepack === true && corepackCmd.viaNode === false);
  const cjs = list.find((c) => c.cmd.endsWith(J('node_modules', 'pnpm', 'bin', 'pnpm.cjs')));
  assert.ok(cjs && cjs.viaNode === true && cjs.corepack === false);
});
