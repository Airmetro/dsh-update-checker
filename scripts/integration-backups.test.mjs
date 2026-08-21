
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let mod;
let base;
let profileNM;

test.before(async () => {
  base = await mkdtemp(join(tmpdir(), 'duc-bkup-'));
  profileNM = join(base, 'profiles', 'node_modules');
  await mkdir(profileNM, { recursive: true });
  process.env.DSH_UC_PROFILE_NODE_MODULES = profileNM;
  mod = await import('../lib/index.js');
});

test.after(async () => {
  delete process.env.DSH_UC_PROFILE_NODE_MODULES;
  await rm(base, { recursive: true, force: true });
});

test('backupDirs: 默认备份根 = $DSH_HOME/dsh-update-checker-backups，插件备份在 plugins 子目录', async () => {
  const dirs = await mod.backupDirs();
  assert.equal(dirs.main, join(base, 'dsh-update-checker-backups'));
  assert.equal(dirs.plugins, join(base, 'dsh-update-checker-backups', 'plugins'));
});

test('writeBackupRoot: 拒绝相对路径；接受绝对路径并持久化', async () => {
  await assert.rejects(() => mod.writeBackupRoot('relative/path'), /absolute path/);
  const custom = join(base, 'my-backups');
  await mod.writeBackupRoot(custom);
  assert.equal(await mod.readBackupRoot(), custom);
  assert.deepEqual(await mod.backupDirs(), { main: custom, plugins: join(custom, 'plugins') });
  
  await mod.writeBackupRoot(join(base, 'dsh-update-checker-backups'));
});

test('migrateLegacyBackups: 旧 .dsh-plugin-backups 首次使用时迁移到 backupRoot/plugins', async () => {
  const legacy = join(profileNM, '.dsh-plugin-backups');
  const legacyEntry = join(legacy, 'dshcost-123');
  await mkdir(legacyEntry, { recursive: true });
  await writeFile(join(legacyEntry, 'backup-info.json'), JSON.stringify({ name: 'dshcost', original: join(profileNM, 'dshcost'), at: 123 }), 'utf8');
  const dirs = await mod.backupDirs();
  await mod.migrateLegacyBackups();
  
  assert.equal((await readdir(dirs.plugins)).includes('dshcost-123'), true, '备份应迁移到 plugins 目录');
  const legacyGone = await import('node:fs').then(({ existsSync }) => !existsSync(legacy));
  assert.equal(legacyGone, true, '旧位置应已被移动（不再存在）');
});

test('listMainBackups: 忽略 plugins 容器目录（不当作主程序备份）', async () => {
  const dirs = await mod.backupDirs();
  await mkdir(join(dirs.main, 'plugins', 'dshcost-789'), { recursive: true });
  const stamp = join(dirs.main, '2026-08-18T01-00-00-000Z');
  await mkdir(stamp, { recursive: true });
  await writeFile(join(stamp, 'backup-meta.json'), JSON.stringify({ installed: '0.1.0-rc.6' }), 'utf8');
  const main = await mod.listMainBackups();
  const ids = main.map((b) => b.id);
  assert.deepEqual(ids, ['2026-08-18T01-00-00-000Z'], `应只含真实备份，不含 plugins 容器: ${JSON.stringify(ids)}`);
});

test('clearAllBackups: 删除主程序与插件全部备份条目', async () => {
  const dirs = await mod.backupDirs();
  await mod.clearAllBackups(); 
  await mkdir(join(dirs.main, '2026-08-18T00-00-00-000Z'), { recursive: true });
  await mkdir(join(dirs.plugins, 'dshcost-456'), { recursive: true });
  const result = await mod.clearAllBackups();
  assert.equal(result.removed, 2);
  
  assert.deepEqual(await readdir(dirs.main), ['plugins']);
  assert.equal((await readdir(dirs.plugins)).length, 0);
});
