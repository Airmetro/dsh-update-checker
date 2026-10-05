import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { stripBom } from '../lib/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PS1 = join(HERE, 'restart-watchdog.ps1');
const SH = join(HERE, 'restart-watchdog.sh');

test('watchdog.ps1: 重启的进程带 stdout/stderr 重定向与 -PassThru，拒绝无诊断启动（issue #36）', async () => {
  const src = await readFile(PS1, 'utf8');
  assert.match(src, /RedirectStandardOutput/);
  assert.match(src, /RedirectStandardError/);
  assert.match(src, /PassThru\s*=\s*\$true/);
  assert.match(src, /\$script:lastPid = \$proc\.Id/);
  assert.match(src, /relaunch-env DSH_HOME=/);
  assert.match(src, /relaunch-logs stdout=/);
});

test('watchdog.ps1: 等待期间不再杀进程（重试只针对已退出的实例）', async () => {
  const src = await readFile(PS1, 'utf8');
  const reloadAt = src.indexOf('function Start-Reload');
  const waitAt = src.indexOf('while ((Get-Date) -lt $deadline');
  assert.ok(reloadAt > 0 && waitAt > reloadAt, '脚本结构应包含 Start-Reload 与等待循环');
  const waitLoop = src.slice(waitAt);
  assert.equal(/taskkill\.exe/.test(waitLoop), false, '等待循环里不允许出现 taskkill');
  const beforeWait = src.slice(0, waitAt);
  assert.match(beforeWait, /killed PID \$targetPid/);
  assert.match(waitLoop, /if \(\$script:relaunchCount -lt 3\)/);
});

test('watchdog.ps1: 端口监听即视为阶段成功，并把判定写进结果', async () => {
  const src = await readFile(PS1, 'utf8');
  assert.match(src, /\$recoveredBy = 'plugin'/);
  assert.match(src, /\$recoveredBy = 'port'/);
  assert.match(src, /recoveredBy = \$recoveredBy/);
  assert.match(src, /outputTail = \(Tail \$errLog 20\)/);
  assert.match(src, /http \$code from plugin route/);
});

test('watchdog.ps1: 等待窗口可配置，默认窗口足够冷启动', async () => {
  const src = await readFile(PS1, 'utf8');
  assert.match(src, /\$env:DSH_RESTART_WAIT_SEC/);
  assert.match(src, /\$env:DSH_RESTART_MAX_WAIT_SEC/);
  assert.match(src, /\$env:DSH_RESTART_MOUNT_GRACE_SEC/);
  assert.match(src, /\$waitSec = 120/);
  assert.match(src, /\$maxWaitSec = 420/);
});

test('watchdog 脚本: 结果 JSON 与日志都不写 BOM（PS 5.1 的 Out-File -Encoding utf8 会写 EF BB BF，Node JSON.parse 会炸）', async () => {
  const ps1 = await readFile(PS1, 'utf8');
  assert.match(ps1, /\[System\.IO\.File\]::WriteAllText\(\$resultFile, \$json, \$utf8NoBom\)/);
  assert.match(ps1, /New-Object System\.Text\.UTF8Encoding \$false/);
  assert.equal(/Out-File\b/.test(ps1), false, '不再使用 Out-File 写结果/日志');
  const sh = await readFile(SH, 'utf8');
  assert.match(sh, /"recoveredBy":/);
  assert.match(sh, /relaunches:Number/);
});

test('watchdog.sh: 等待期间同样不再 kill 已启动实例', async () => {
  const src = await readFile(SH, 'utf8');
  const waitAt = src.indexOf('END_AT=$(( $(date +%s) + MAX_WAIT_SEC ))');
  assert.ok(waitAt > 0, '应包含等待循环');
  const waitLoop = src.slice(waitAt);
  assert.equal(/kill -9/.test(waitLoop), false, '等待循环里不允许出现 kill -9');
});

test('stripBom: 兼容旧版 watchdog 写出的带 BOM 结果文件', () => {
  assert.equal(stripBom('\uFEFF{"ok":true}'), '{"ok":true}');
  assert.equal(stripBom('{"ok":true}'), '{"ok":true}');
  assert.equal(stripBom(''), '');
  assert.equal(stripBom(null), '');
  assert.deepEqual(JSON.parse(stripBom('\uFEFF{"recovered":true}')), { recovered: true });
});
