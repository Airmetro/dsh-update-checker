import test from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pickDshHome } from '../lib/index.js';

test('pickDshHome: 真正的 profiles 布局按安装位置推导（含 DSH_UC_PROFILE_NODE_MODULES 覆盖与测试隔离）', () => {
  assert.equal(
    pickDshHome('D:\\unrelated-home', 'C:\\Users\\x\\.dsh\\profiles\\node_modules'),
    'C:\\Users\\x\\.dsh'
  );
  assert.equal(
    pickDshHome('D:\\unrelated-home', 'C:\\temp\\duc-1234\\profiles\\node_modules'),
    'C:\\temp\\duc-1234'
  );
  assert.equal(
    pickDshHome(undefined, 'C:\\Temp\\PROFILES\\node_modules'),
    'C:\\Temp',
    '大小写不敏感'
  );
});

test('pickDshHome: 布局不像 Harness home 时，用 DSH_HOME，而不是把状态丢到程序目录旁', () => {
  assert.equal(
    pickDshHome('D:\\harness-home', 'D:\\应用\\deepseek harness\\node_modules'),
    resolve('D:\\harness-home')
  );
  assert.equal(
    pickDshHome('  D:\\harness-home  ', 'D:\\应用\\deepseek harness\\node_modules'),
    resolve('D:\\harness-home')
  );
});

test('pickDshHome: 都没有时退回 ~/.dsh（与 dsh 自身的默认一致）', () => {
  const fallback = join(homedir(), '.dsh');
  assert.equal(pickDshHome(undefined, 'D:\\应用\\deepseek harness\\node_modules'), fallback);
  assert.equal(pickDshHome('', 'D:\\应用\\deepseek harness\\node_modules'), fallback);
  assert.equal(pickDshHome('   ', 'D:\\应用\\deepseek harness\\node_modules'), fallback);
  assert.equal(pickDshHome(null, 'D:\\应用\\deepseek harness\\node_modules'), fallback);
});
