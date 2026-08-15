// 单元测试：GitHub codeload tarball 解压（extractTarGzToDir 纯函数）
// 用内存构造的最小 tar.gz 驱动解压逻辑，覆盖：常规解压、目录项跳过、路径逃逸拒绝。
import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { extractTarGzToDir } from '../lib/index.js';

// 最小 tar 构造：单条 512 字节头 + 数据块（填充到 512 边界），结束时拼 1024 字节零块。
function tarEntry(name, data = null, typeflag = '0') {
  const buf = Buffer.alloc(512);
  buf.write(name.slice(0, 100), 0, 'utf8');          // 文件名（≤100 字节）
  buf.write('0000644\0', 100, 'utf8');               // mode
  buf.write('0000000\0', 108, 'utf8');               // uid
  buf.write('0000000\0', 116, 'utf8');               // gid
  const size = data ? data.length : 0;
  buf.write(size.toString(8).padStart(11, '0') + '\0', 124, 'utf8'); // size（8 进制）
  buf.write('00000000000\0', 136, 'utf8');           // mtime
  buf[156] = typeflag.charCodeAt(0);                 // typeflag: '0' 普通文件, '5' 目录
  buf.fill(0x20, 148, 156);                          // checksum 域先填空格
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += buf[i];
  buf.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'utf8'); // 6 位 8 进制 + NUL + 空格
  const out = [buf];
  if (data) {
    const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512);
    data.copy(padded);
    out.push(padded);
  }
  return Buffer.concat(out);
}

function makeTarGz(entries) {
  const end = Buffer.alloc(1024); // 两个 512 字节结尾块
  return gzipSync(Buffer.concat([...entries, end]));
}

test('extractTarGzToDir: 解压常规包（目录项跳过 + 文件落盘）', async () => {
  const dest = await mkdtemp(join(tmpdir(), 'duc-tar-'));
  try {
    const buf = makeTarGz([
      tarEntry('package/', null, '5'), // typeflag=5 目录项应被跳过
      tarEntry('package/package.json', Buffer.from('{"name":"demo","version":"1.0.0"}')),
      tarEntry('package/lib/index.js', Buffer.from('export default 1;')),
    ]);
    const root = extractTarGzToDir(buf, dest);
    assert.equal(root, join(dest, 'package'));
    assert.equal(
      await readFile(join(dest, 'package', 'package.json'), 'utf8'),
      '{"name":"demo","version":"1.0.0"}'
    );
    assert.equal(await readFile(join(dest, 'package', 'lib', 'index.js'), 'utf8'), 'export default 1;');
  } finally {
    await rm(dest, { recursive: true, force: true });
  }
});

test('extractTarGzToDir: 多块数据正确还原（>512 字节）', async () => {
  const dest = await mkdtemp(join(tmpdir(), 'duc-tar-'));
  try {
    const payload = Buffer.from('x'.repeat(700)); // 跨 2 个 512 块
    const buf = makeTarGz([tarEntry('pkg/main.js', payload)]);
    extractTarGzToDir(buf, dest);
    const got = await readFile(join(dest, 'pkg', 'main.js'));
    assert.equal(got.length, 700);
    assert.ok(got.equals(payload));
  } finally {
    await rm(dest, { recursive: true, force: true });
  }
});

test('extractTarGzToDir: 路径逃逸条目被跳过且不写盘', async () => {
  const dest = await mkdtemp(join(tmpdir(), 'duc-esc-'));
  try {
    const buf = makeTarGz([
      tarEntry('../../evil.txt', Buffer.from('pwned')),
      tarEntry('../escape.js', Buffer.from('bad')),
    ]);
    // 不抛错，且 dest 内不落任何文件
    extractTarGzToDir(buf, dest);
    assert.deepEqual(await readdir(dest), []);
    // dest 之外的文件也不存在
    await assert.rejects(access(resolve(dest, '..', 'evil.txt')));
    await assert.rejects(access(resolve(dest, '..', 'escape.js')));
  } finally {
    await rm(dest, { recursive: true, force: true });
  }
});

test('extractTarGzToDir: 空 tar（仅结尾块）不抛错', async () => {
  const dest = await mkdtemp(join(tmpdir(), 'duc-empty-'));
  try {
    const root = extractTarGzToDir(makeTarGz([]), dest);
    assert.equal(root, join(dest, 'package')); // 无条目时回退名
    assert.deepEqual(await readdir(dest), []);
  } finally {
    await rm(dest, { recursive: true, force: true });
  }
});
