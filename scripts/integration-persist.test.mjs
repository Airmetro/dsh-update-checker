



import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let base;
let profiles;
let web;
let pnpmLog;
let fakePnpm;
let mod;

test.before(async () => {
  base = await mkdtemp(join(tmpdir(), 'duc-persist-'));
  profiles = join(base, 'profiles');
  web = join(profiles, 'web');

  
  await mkdir(join(web, 'node_modules', 'dsh-better-sidebar'), { recursive: true });
  await mkdir(join(web, 'node_modules', 'dsh-sidebar-qa'), { recursive: true });
  await writeFile(
    join(web, 'package.json'),
    JSON.stringify(
      {
        name: 'dsh-profile-web',
        private: true,
        dependencies: {
          'dsh-better-sidebar': '^0.12.3',
          'dsh-sidebar-qa': 'github:ChenRuoT/dsh-sidebar-qa',
          'dshmarket': '^1.13.1',
        },
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

  process.env.DSH_UC_PROFILE_NODE_MODULES = join(profiles, 'node_modules');
  process.env.DSH_UC_PNPM_BIN = fakePnpm;
  mod = await import('../lib/index.js');
});

test.after(async () => {
  delete process.env.DSH_UC_PROFILE_NODE_MODULES;
  delete process.env.DSH_UC_PNPM_BIN;
  delete process.env.DSH_UC_PNPM_LOG;
  await rm(base, { recursive: true, force: true });
});

test('persistPluginUpdate：semver 声明回写 ^新版本，其它依赖不动，pnpm 锁文件同步', async () => {
  const res = await mod.persistPluginUpdate({
    name: 'dsh-better-sidebar',
    newVersion: '0.13.1',
    targetDir: join(web, 'node_modules', 'dsh-better-sidebar'),
    gh: null,
  });

  assert.equal(res.manifest.length, 1);
  assert.equal(res.manifest[0].profile, web);
  assert.equal(res.manifest[0].changed, true);
  assert.equal(res.manifest[0].oldSpec, '^0.12.3');
  assert.equal(res.manifest[0].spec, '^0.13.1');

  const pj = JSON.parse(await readFile(join(web, 'package.json'), 'utf8'));
  assert.equal(pj.dependencies['dsh-better-sidebar'], '^0.13.1');
  assert.equal(pj.dependencies['dshmarket'], '^1.13.1'); 
  assert.equal(pj.dependencies['dsh-sidebar-qa'], 'github:ChenRuoT/dsh-sidebar-qa');

  assert.equal(res.lockfile.length, 1);
  assert.equal(res.lockfile[0].pm, 'pnpm');
  assert.equal(res.lockfile[0].ok, true);

  const log = await readFile(pnpmLog, 'utf8');
  assert.match(log, /--lockfile-only/);
  assert.match(log, /--no-frozen-lockfile/);
  
  assert.ok(log.includes(await realpath(web)), 'pnpm 应在声明该插件的 profile 目录运行');
});

test('persistPluginUpdate：幂等 —— 已是新版本声明时不再改写', async () => {
  const res = await mod.persistPluginUpdate({
    name: 'dsh-better-sidebar',
    newVersion: '0.13.1',
    targetDir: join(web, 'node_modules', 'dsh-better-sidebar'),
    gh: null,
  });
  assert.equal(res.manifest[0].changed, false);
  assert.equal(res.manifest[0].spec, '^0.13.1');
});

test('persistPluginUpdate：github 声明的插件钉到 release tag', async () => {
  const res = await mod.persistPluginUpdate({
    name: 'dsh-sidebar-qa',
    newVersion: '0.3.0',
    targetDir: join(web, 'node_modules', 'dsh-sidebar-qa'),
    gh: { source: 'github', owner: 'ChenRuoT', repo: 'dsh-sidebar-qa', tag: 'v0.3.0' },
  });
  assert.equal(res.manifest[0].changed, true);
  assert.equal(res.manifest[0].spec, 'github:ChenRuoT/dsh-sidebar-qa#v0.3.0');
  const pj = JSON.parse(await readFile(join(web, 'package.json'), 'utf8'));
  assert.equal(pj.dependencies['dsh-sidebar-qa'], 'github:ChenRuoT/dsh-sidebar-qa#v0.3.0');
});

test('persistPluginUpdate：清单未声明的插件无法推导 → 跳过不误写', async () => {
  const res = await mod.persistPluginUpdate({
    name: 'dsh-inline-images', 
    newVersion: '1.1.0',
    targetDir: join(web, 'node_modules', 'dsh-inline-images'),
    gh: null,
  });
  assert.equal(res.manifest.length, 1);
  assert.equal(res.manifest[0].changed, false);
  assert.equal(res.manifest[0].reason, 'not-derivable');
  const pj = JSON.parse(await readFile(join(web, 'package.json'), 'utf8'));
  assert.equal(pj.dependencies['dsh-inline-images'], undefined);
});

test('persistPluginSpec：回滚路径按记录的旧 spec 写回', async () => {
  const res = await mod.persistPluginSpec(
    'dsh-better-sidebar',
    join(web, 'node_modules', 'dsh-better-sidebar'),
    '^0.12.3'
  );
  assert.equal(res.manifest[0].changed, true);
  assert.equal(res.manifest[0].spec, '^0.12.3');
  const pj = JSON.parse(await readFile(join(web, 'package.json'), 'utf8'));
  assert.equal(pj.dependencies['dsh-better-sidebar'], '^0.12.3');
  
  assert.equal(res.lockfile[0].ok, true);
});

test('pnpm 不可用：manifest 照常回写，锁文件如实报失败，不抛异常', async () => {
  process.env.DSH_UC_PNPM_BIN = '__none__';
  try {
    const res = await mod.persistPluginUpdate({
      name: 'dsh-better-sidebar',
      newVersion: '0.13.2',
      targetDir: join(web, 'node_modules', 'dsh-better-sidebar'),
      gh: null,
    });
    assert.equal(res.manifest[0].changed, true);
    assert.equal(res.manifest[0].spec, '^0.13.2');
    assert.equal(res.lockfile[0].ok, false);
    assert.equal(res.lockfile[0].code, 'ENOPNPM');
  } finally {
    process.env.DSH_UC_PNPM_BIN = fakePnpm;
  }
});
