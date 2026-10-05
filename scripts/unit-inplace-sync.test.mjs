import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, rename, open, opendir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { syncDirectoryInPlace, swapDirectoryInPlace, isDirectoryRenameBlocked } from '../lib/index.js';

async function makeTree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, content, 'utf8');
  }
}

async function listTmpDirs(parent, prefix) {
  const out = [];
  for (const e of await readdir(parent, { withFileTypes: true })) {
    if (e.isDirectory() && e.name.startsWith(prefix)) out.push(e.name);
  }
  return out;
}

test('isDirectoryRenameBlocked: 常驻句柄类拒绝（EPERM/EACCES）判为不可重命名，瞬时的 EBUSY 不判', () => {
  assert.equal(isDirectoryRenameBlocked(Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' })), true);
  assert.equal(isDirectoryRenameBlocked(Object.assign(new Error('EACCES'), { code: 'EACCES' })), true);
  assert.equal(isDirectoryRenameBlocked(Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })), false);
  assert.equal(isDirectoryRenameBlocked(Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })), false);
});

test('syncDirectoryInPlace: 覆盖同名文件、补齐缺失文件、删除陈旧文件与目录', async () => {
  const root = await mkdtemp(join(tmpdir(), 'duc-inplace-'));
  try {
    const src = join(root, 'new');
    const dst = join(root, 'old');
    await makeTree(src, { 'package.json': '{"version":"1.0.0"}', 'lib/index.js': 'new', 'skills/a/keep.txt': 'keep' });
    await makeTree(dst, { 'package.json': '{"version":"0.1.0"}', 'lib/index.js': 'old', 'lib/legacy.js': 'gone', 'old-dir/old.txt': 'gone' });
    const res = await syncDirectoryInPlace(dst, src);
    assert.equal(res.mode, 'in-place');
    assert.equal(await readFile(join(dst, 'package.json'), 'utf8'), '{"version":"1.0.0"}');
    assert.equal(await readFile(join(dst, 'lib/index.js'), 'utf8'), 'new');
    assert.equal(await readFile(join(dst, 'skills/a/keep.txt'), 'utf8'), 'keep');
    await assert.rejects(() => readFile(join(dst, 'lib/legacy.js'), 'utf8'));
    await assert.rejects(() => readFile(join(dst, 'old-dir/old.txt'), 'utf8'));
    assert.equal(res.removedFiles, 2);
    assert.equal(res.removedDirs, 1);
    assert.equal(res.leftoverCount, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('syncDirectoryInPlace: filter 生效（node_modules 不进目标目录）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'duc-inplace-filter-'));
  try {
    const src = join(root, 'new');
    const dst = join(root, 'old');
    await makeTree(src, { 'package.json': '{}', 'node_modules/dep/package.json': '{}' });
    await mkdir(dst, { recursive: true });
    const res = await syncDirectoryInPlace(dst, src, (p) => !String(p).split(/[\\/]/).includes('node_modules'));
    assert.equal(res.written, 1);
    await assert.rejects(() => readFile(join(dst, 'node_modules/dep/package.json'), 'utf8'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('swapDirectoryInPlace: 子目录被句柄占住时 rename 必失败（前置条件），此时降级为原地文件级同步（issue #37）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'duc-pinned-'));
  let handle = null;
  try {
    const dst = join(root, 'archify-dsh');
    const src = join(root, 'staged');
    await makeTree(dst, {
      'package.json': '{"name":"archify-dsh","version":"0.1.0"}',
      'skills/archify/notes.txt': 'old notes',
      'skills/archify/legacy.txt': 'legacy',
      'lib/index.js': 'old',
    });
    await makeTree(src, {
      'package.json': '{"name":"archify-dsh","version":"1.0.0"}',
      'skills/archify/notes.txt': 'new notes',
      'lib/index.js': 'new',
    });
    handle = await open(join(dst, 'skills', 'archify', 'notes.txt'), 'r');
    const trash = join(root, 'trash-probe');
    await assert.rejects(() => rename(dst, trash), (err) => err.code === 'EPERM' || err.code === 'EACCES');
    const res = await swapDirectoryInPlace(dst, src);
    assert.equal(res.inPlace, true);
    assert.equal(res.movedAside, false);
    assert.equal(res.sync.written, 3);
    assert.equal(await readFile(join(dst, 'package.json'), 'utf8'), '{"name":"archify-dsh","version":"1.0.0"}');
    assert.equal(await readFile(join(dst, 'skills/archify/notes.txt'), 'utf8'), 'new notes');
    assert.equal(await readFile(join(dst, 'lib/index.js'), 'utf8'), 'new');
    await assert.rejects(() => readFile(join(dst, 'skills/archify/legacy.txt'), 'utf8'));
    assert.deepEqual(await listTmpDirs(root, '.dsh-uc-'), []);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test('swapDirectoryInPlace: 句柄释放后仍然走 rename 交换（不误用原地同步）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'duc-free-'));
  try {
    const dst = join(root, 'pkg');
    const src = join(root, 'staged');
    await makeTree(dst, { 'package.json': '{"version":"0.1.0"}' });
    await makeTree(src, { 'package.json': '{"version":"1.0.0"}' });
    const res = await swapDirectoryInPlace(dst, src);
    assert.equal(res.movedAside, true);
    assert.equal(res.inPlace, undefined);
    assert.equal(await readFile(join(dst, 'package.json'), 'utf8'), '{"version":"1.0.0"}');
    assert.deepEqual(await listTmpDirs(root, '.dsh-uc-'), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('swapDirectoryInPlace: 目录监视句柄（opendir 子目录，宿主技能监视器的同款持有方式）同样触发原地同步', async () => {
  const root = await mkdtemp(join(tmpdir(), 'duc-watch-'));
  let watcher = null;
  try {
    const dst = join(root, 'skill-plugin');
    const src = join(root, 'staged');
    await makeTree(dst, { 'package.json': '{"version":"0.1.0"}', 'skills/demo/SKILL.md': 'old skill' });
    await makeTree(src, { 'package.json': '{"version":"2.0.0"}', 'skills/demo/SKILL.md': 'new skill' });
    watcher = await opendir(join(dst, 'skills', 'demo'));
    await assert.rejects(() => rename(dst, join(root, 'probe')), (err) => err.code === 'EPERM' || err.code === 'EACCES');
    const res = await swapDirectoryInPlace(dst, src);
    assert.equal(res.inPlace, true);
    assert.equal(await readFile(join(dst, 'package.json'), 'utf8'), '{"version":"2.0.0"}');
    assert.equal(await readFile(join(dst, 'skills/demo/SKILL.md'), 'utf8'), 'new skill');
    assert.equal(await readFile(join(dst, 'skills/demo/SKILL.md'), 'utf8').then(() => true), true);
  } finally {
    if (watcher) await watcher.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test('swapDirectoryInPlace: 原地同步后被占住的技能目录仍然存在（不删被监视的子目录）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'duc-inplace-keep-'));
  let handle = null;
  try {
    const dst = join(root, 'pkg');
    const src = join(root, 'staged');
    await makeTree(dst, { 'package.json': '{"version":"0.1.0"}', 'skills/a/pinned.txt': 'pinned' });
    await makeTree(src, { 'package.json': '{"version":"1.0.0"}', 'skills/a/pinned.txt': 'pinned' });
    handle = await open(join(dst, 'skills/a/pinned.txt'), 'r');
    const res = await swapDirectoryInPlace(dst, src);
    assert.equal(res.inPlace, true);
    assert.equal(res.sync.leftoverCount, 0);
    assert.equal(await readFile(join(dst, 'package.json'), 'utf8'), '{"version":"1.0.0"}');
    assert.equal(await readFile(join(dst, 'skills/a/pinned.txt'), 'utf8'), 'pinned');
  } finally {
    if (handle) await handle.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
