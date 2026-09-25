import test from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import {
  npmCliCandidates,
  npmShimCandidates,
  locateNpmCli,
  realNodeFromExecPath,
  resolveRealNode,
  packageProgressPercent,
  parseNpmPackageCount,
  countNpmTarballFetches,
  launcherCandidates,
  buildServiceRelaunch,
  runningProfileDir,
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

test('npmCliCandidates: 保留四个标准相对布局', () => {
  const list = npmCliCandidates('/usr/local/bin');
  assert.ok(list.includes(join('/usr/local/bin', 'node_modules', 'npm', 'bin', 'npm-cli.js')));
  assert.ok(list.includes(join('/usr/local', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')));
  assert.ok(list.includes(join('/usr/local', 'node_modules', 'npm', 'bin', 'npm-cli.js')));
  assert.ok(list.includes(join('/usr/local', 'libexec', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')));
});

test('npmCliCandidates: 覆盖 Fedora/RHEL 的 node_modules_<major> 布局（issue #30）', () => {
  const list = npmCliCandidates('/usr/bin', { platform: 'linux', nodeMajor: '24' });
  assert.ok(list.includes(join('/usr', 'lib', 'node_modules_24', 'npm', 'bin', 'npm-cli.js')), '应包含 /usr/lib/node_modules_24');
  assert.ok(list.includes(join('/usr', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')));
  assert.ok(list.includes(join('/usr', 'local', 'lib', 'node_modules_24', 'npm', 'bin', 'npm-cli.js')));
  assert.ok(list.includes(join('/opt', 'homebrew', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')));
});

test('npmCliCandidates: 尊重 npm_config_prefix 与去重', () => {
  const list = npmCliCandidates('/usr/bin', { platform: 'linux', nodeMajor: '20', prefix: '/opt/npm-prefix' });
  assert.ok(list.includes(join('/opt', 'npm-prefix', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')));
  assert.ok(list.includes(join('/opt', 'npm-prefix', 'lib', 'node_modules_20', 'npm', 'bin', 'npm-cli.js')));
  assert.equal(new Set(list).size, list.length, '候选不得重复');
});

test('npmShimCandidates: PATH 中的 npm 与 shim 目录旁 npm 都可探测', () => {
  const list = npmShimCandidates('/usr/bin', { PATH: ['/usr/bin', '/usr/local/bin'].join(delimiter) }, 'linux');
  assert.ok(list.includes(join('/usr/bin', 'npm')));
  assert.ok(list.includes(join('/usr/local/bin', 'npm')));
  assert.ok(list.includes(join('/usr', 'bin', 'npm')));
});

test('locateNpmCli: 命中真实 npm-cli.js（web 形态）', () => {
  const cli = locateNpmCli(dirname(process.execPath));
  assert.ok(existsSync(cli), `npm-cli.js 应存在: ${cli}`);
});

test('locateNpmCli: 没有 npm（PATH 也为空）时抛 ENPMCLI，不静默 fallback', () => {
  const empty = join(tmpdir(), 'uc-no-npm-' + process.pid + '-' + Date.now());
  mkdirSync(empty, { recursive: true });
  assert.throws(() => locateNpmCli(empty, { PATH: '' }), (e) => e.code === 'ENPMCLI');
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

test('packageProgressPercent: 整体按包数推进（100/200=50%，198/200=99%）', () => {
  assert.equal(packageProgressPercent(100, 200), 50);
  assert.equal(packageProgressPercent(198, 200), 99);
  assert.equal(packageProgressPercent(0, 200), 10, '起步值不显示 0%');
  assert.equal(packageProgressPercent(1, 200), 10, '起步阶段不低于 10%');
  assert.equal(packageProgressPercent(200, 200), 99, '包阶段封顶 99%，把 100% 留给收尾');
  assert.equal(packageProgressPercent(137, 273), 50);
  assert.equal(packageProgressPercent(5, 0), null, '总包数未知时返回 null 交给调用方');
  assert.equal(packageProgressPercent(5, null), null);
});

test('parseNpmPackageCount: 从 npm 输出读取包数', () => {
  assert.equal(parseNpmPackageCount('added 273 packages in 42s'), 273);
  assert.equal(parseNpmPackageCount('added 12 packages, changed 260 packages in 1m'), 260);
  assert.equal(parseNpmPackageCount('up to date, audited 400 packages'), null);
  assert.equal(parseNpmPackageCount(''), null);
});

test('countNpmTarballFetches: 只数 tarball 且按 URL 去重', () => {
  const log = [
    'npm http fetch GET 200 https://registry.npmjs.org/@deepseek-ai%2fdsh-foo 120ms (cache miss)',
    'npm http fetch GET 200 https://registry.npmjs.org/@deepseek-ai/dsh-foo/-/dsh-foo-1.0.0.tgz 300ms (cache miss)',
    'npm http fetch GET 200 https://registry.npmjs.org/@deepseek-ai/dsh-foo/-/dsh-foo-1.0.0.tgz 2ms (cache hit)',
    'npm http fetch GET 200 https://registry.npmjs.org/@deepseek-ai/dsh-bar/-/dsh-bar-2.0.0.tgz 80ms (cache miss)',
  ].join('\n');
  assert.equal(countNpmTarballFetches(log), 2);
  assert.equal(countNpmTarballFetches(''), 0);
});

test('launcherCandidates: 环境变量优先，其次是部署目录下的启动器', () => {
  const list = launcherCandidates('C:\\dsh', { DSH_UC_LAUNCHER: 'D:\\custom\\start.cmd' }, 'win32');
  assert.equal(list[0], 'D:\\custom\\start.cmd');
  assert.ok(list.includes(join('C:\\dsh', 'DeepSeek Harness.cmd')));
  assert.ok(list.includes(join('C:\\dsh', 'start-dsh.cmd')));
  assert.equal(new Set(list.map((p) => p.toLowerCase())).size, list.length);
});

test('buildServiceRelaunch: 有启动器时走启动器且窗口可见（不再无控制台孤儿）', () => {
  const win = buildServiceRelaunch('win32', { deployRoot: 'C:\\dsh', nodeExe: 'C:\\node\\node.exe', launcher: 'C:\\dsh\\DeepSeek Harness.cmd', entry: null });
  assert.equal(win.method, 'launcher');
  assert.equal(win.windowsHide, false, '必须可见，否则又会留下无控制台实例');
  assert.equal(win.detached, true);
  assert.equal(win.args[0], '/c');
  assert.ok(String(win.args[1]).endsWith('DeepSeek Harness.cmd'));
  const posix = buildServiceRelaunch('linux', { deployRoot: '/dsh', nodeExe: '/usr/bin/node', launcher: '/dsh/DeepSeek Harness.sh', entry: null });
  assert.equal(posix.method, 'launcher');
  assert.equal(posix.file, '/dsh/DeepSeek Harness.sh');
});

test('buildServiceRelaunch: 无启动器时直接 node 且可见；缺少 entry 时返回 null', () => {
  const node = buildServiceRelaunch('win32', { deployRoot: 'C:\\dsh', nodeExe: 'C:\\node\\node.exe', launcher: null, entry: 'C:\\dsh\\bin.js' });
  assert.equal(node.method, 'node');
  assert.equal(node.windowsHide, false);
  assert.deepEqual(node.args, ['C:\\dsh\\bin.js', 'web']);
  const shim = buildServiceRelaunch('win32', { deployRoot: 'C:\\dsh', nodeExe: 'C:\\shims\\node.cmd', launcher: null, entry: 'C:\\dsh\\bin.js' });
  assert.equal(shim.method, 'node-shim', 'cmd/bat shim 必须经 ComSpec，否则 spawn EINVAL');
  assert.equal(shim.args[0], '/c');
  assert.deepEqual(shim.args.slice(1), ['C:\\shims\\node.cmd', 'C:\\dsh\\bin.js', 'web']);
  assert.equal(buildServiceRelaunch('win32', { deployRoot: 'C:\\dsh', nodeExe: 'C:\\node\\node.exe', launcher: null, entry: null }), null);
});

test('runningProfileDir: DSH_PROFILE_DIR 优先，其次 DSH_PROFILE', () => {
  const base = join(tmpdir(), 'uc-profile-' + process.pid + '-' + Date.now());
  const web = join(base, 'web');
  const desktop = join(base, 'desktop');
  mkdirSync(web, { recursive: true });
  mkdirSync(desktop, { recursive: true });
  writeFileSync(join(web, 'cordis.patch.yml'), '[]\n');
  writeFileSync(join(desktop, 'package.json'), '{}\n');
  assert.equal(runningProfileDir({ DSH_PROFILE_DIR: desktop, DSH_PROFILE: 'web' }, base), desktop);
  assert.equal(runningProfileDir({ DSH_PROFILE: 'web' }, base), web);
  assert.equal(runningProfileDir({ DSH_PROFILE: 'missing' }, base), null);
});
