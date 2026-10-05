import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

let base;
let profiles;
let web;
let nested;
let shared;
let pnpmLog;
let fakePnpm;
let mod;

test.before(async () => {
  base = await mkdtemp(join(tmpdir(), 'duc-profiles-root-'));
  profiles = join(base, 'profiles');
  web = join(profiles, 'web');
  nested = join(web, 'node_modules');
  shared = join(profiles, 'node_modules');

  await mkdir(join(nested, 'dsh-better-sidebar'), { recursive: true });
  await writeFile(
    join(web, 'package.json'),
    JSON.stringify(
      {
        name: 'dsh-profile-web',
        private: true,
        dependencies: { 'dsh-better-sidebar': '^0.12.3', dshmarket: '^1.13.1' },
      },
      null,
      2
    ) + '\n'
  );
  await writeFile(join(web, 'pnpm-lock.yaml'), '# marker\n');

  pnpmLog = join(base, 'pnpm-args.log');
  fakePnpm = join(base, 'fake-pnpm.mjs');
  await writeFile(
    fakePnpm,
    `import { appendFileSync } from 'node:fs';\n` +
      `appendFileSync(process.env.DSH_UC_PNPM_LOG, 'cwd=' + process.cwd() + '\\n' + process.argv.slice(2).join(' ') + '\\n');\n`
  );
  process.env.DSH_UC_PNPM_LOG = pnpmLog;

  process.env.DSH_UC_PROFILE_NODE_MODULES = nested;
  process.env.DSH_UC_PNPM_BIN = fakePnpm;
  process.env.DSH_HOME = base;
  mod = await import('../lib/index.js');
});

test.after(async () => {
  delete process.env.DSH_UC_PROFILE_NODE_MODULES;
  delete process.env.DSH_UC_PNPM_BIN;
  delete process.env.DSH_UC_PNPM_LOG;
  delete process.env.DSH_HOME;
  await rm(base, { recursive: true, force: true });
});

test('pickProfilesRoot：共用布局与每-profile 布局都指向 profiles 目录', () => {
  assert.equal(mod.pickProfilesRoot(shared), profiles, '共用布局：node_modules 的父目录就是 profiles');
  assert.equal(
    mod.pickProfilesRoot(nested),
    profiles,
    '每-profile 布局：profiles 在 profile 目录之上，而不是 profile 目录本身'
  );
  assert.equal(
    mod.pickProfilesRoot(nested),
    dirname(dirname(nested)),
    '与旧实现 dirname(node_modules) 的差异正是本缺陷'
  );
});

test('pickDshHome：每-profile 布局同样能推导出 home，而不是退回 ~/.dsh', () => {
  assert.equal(mod.pickDshHome('D:\\unrelated-home', nested), base);
  assert.equal(mod.pickDshHome(undefined, nested), base);
});

test('persistPluginUpdate：该布局下版本写回 profile 的 package.json，锁文件在 profile 目录同步', async () => {
  const res = await mod.persistPluginUpdate({
    name: 'dsh-better-sidebar',
    newVersion: '0.13.1',
    targetDir: join(nested, 'dsh-better-sidebar'),
    gh: null,
  });

  assert.equal(res.manifest.length, 1, '必须找到声明该插件的 profile');
  assert.equal(res.manifest[0].profile, web);
  assert.equal(res.manifest[0].changed, true, 'persistedManifest 不能再是 0');
  assert.equal(res.manifest[0].oldSpec, '^0.12.3');
  assert.equal(res.manifest[0].spec, '^0.13.1');

  const pj = JSON.parse(await readFile(join(web, 'package.json'), 'utf8'));
  assert.equal(pj.dependencies['dsh-better-sidebar'], '^0.13.1');
  assert.equal(pj.dependencies.dshmarket, '^1.13.1', '其它依赖不动');

  assert.equal(res.lockfile.length, 1);
  assert.equal(res.lockfile[0].pm, 'pnpm');
  assert.equal(res.lockfile[0].ok, true);
  const log = await readFile(pnpmLog, 'utf8');
  assert.ok(log.includes(await realpath(web)), 'pnpm 应在声明该插件的 profile 目录运行');
});
