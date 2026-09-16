import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { swapDirectoryInPlace } from '../lib/index.js';

let root;

test.before(async () => {
  root = await mkdtemp(join(tmpdir(), 'duc-swap-'));
});

test.after(async () => {
  await rm(root, { recursive: true, force: true });
});

async function makePluginDir(name, files) {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, content, 'utf8');
  }
  return dir;
}

const tmpDirsIn = async (parent) =>
  (await readdir(parent, { withFileTypes: true }))
    .filter((e) => e.isDirectory() && e.name.startsWith('.dsh-uc-'))
    .map((e) => e.name);

test('swapDirectoryInPlace: stages first, then swaps, leaving no temp dirs behind', async () => {
  const parent = join(root, 'case-happy');
  await mkdir(parent, { recursive: true });
  const dst = join(parent, 'plugin-a');
  const src = join(root, 'src-a');
  await mkdir(dst, { recursive: true });
  await writeFile(join(dst, 'package.json'), '{"version":"1.0.0"}', 'utf8');
  await writeFile(join(dst, 'old.js'), 'old', 'utf8');
  await mkdir(src, { recursive: true });
  await writeFile(join(src, 'package.json'), '{"version":"2.0.0"}', 'utf8');
  await writeFile(join(src, 'new.js'), 'new', 'utf8');

  const res = await swapDirectoryInPlace(dst, src);
  assert.equal(res.movedAside, true);
  assert.equal(res.trashRemoved, true);
  assert.equal(await readFile(join(dst, 'package.json'), 'utf8'), '{"version":"2.0.0"}');
  assert.equal(await readFile(join(dst, 'new.js'), 'utf8'), 'new');
  await assert.rejects(() => access(join(dst, 'old.js')));
  assert.deepEqual(await tmpDirsIn(parent), []);
});

test('swapDirectoryInPlace: a failing stage never touches the existing directory (issue #21)', async () => {
  const parent = join(root, 'case-stage-fail');
  await mkdir(parent, { recursive: true });
  const dst = join(parent, 'plugin-b');
  await mkdir(dst, { recursive: true });
  await writeFile(join(dst, 'package.json'), '{"version":"1.0.0"}', 'utf8');
  await writeFile(join(dst, 'native.node'), 'binary', 'utf8');

  await assert.rejects(() => swapDirectoryInPlace(dst, join(root, 'missing-src')));
  assert.equal(await readFile(join(dst, 'package.json'), 'utf8'), '{"version":"1.0.0"}');
  assert.equal(await readFile(join(dst, 'native.node'), 'utf8'), 'binary');
  assert.deepEqual(await tmpDirsIn(parent), []);
});

test('swapDirectoryInPlace: filter is applied to the staged copy only', async () => {
  const parent = join(root, 'case-filter');
  await mkdir(parent, { recursive: true });
  const dst = join(parent, 'plugin-c');
  const src = join(root, 'src-c');
  await mkdir(dst, { recursive: true });
  await writeFile(join(dst, 'keep.txt'), 'old', 'utf8');
  await mkdir(src, { recursive: true });
  await writeFile(join(src, 'keep.txt'), 'new', 'utf8');
  await writeFile(join(src, 'skip.txt'), 'skip', 'utf8');

  await swapDirectoryInPlace(dst, src, (s) => !s.endsWith('skip.txt'));
  assert.equal(await readFile(join(dst, 'keep.txt'), 'utf8'), 'new');
  await assert.rejects(() => access(join(dst, 'skip.txt')));
});

test('swapDirectoryInPlace: an unrelated .dsh-uc trash dir is swept for the same plugin', async () => {
  const parent = join(root, 'case-sweep');
  await mkdir(parent, { recursive: true });
  const dst = join(parent, 'plugin-d');
  const src = join(root, 'src-d');
  const leftover = join(parent, '.dsh-uc-trash-plugin-d-1-1');
  await mkdir(dst, { recursive: true });
  await mkdir(leftover, { recursive: true });
  await writeFile(join(leftover, 'stale.txt'), 'x', 'utf8');
  await mkdir(src, { recursive: true });
  await writeFile(join(src, 'package.json'), '{"version":"9.9.9"}', 'utf8');

  await swapDirectoryInPlace(dst, src);
  await assert.rejects(() => access(leftover));
  assert.deepEqual(await tmpDirsIn(parent), []);
});
