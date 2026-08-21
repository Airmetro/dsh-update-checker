

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVersion, compareVersions, tagToVersion, parseGhRepo } from '../lib/index.js';

test('parseVersion: 合法 semver 解析', () => {
  assert.deepEqual(parseVersion('1.2.3'), { core: [1, 2, 3], pre: [] });
  assert.deepEqual(parseVersion('0.1.0-rc.6'), { core: [0, 1, 0], pre: ['rc', '6'] });
  assert.deepEqual(parseVersion('10.20.30'), { core: [10, 20, 30], pre: [] });
  assert.deepEqual(parseVersion(' 2.0.0-beta.10 '), { core: [2, 0, 0], pre: ['beta', '10'] });
});

test('parseVersion: 非法输入返回 null', () => {
  for (const v of ['', 'abc', '1.2', '1.2.3.4', 'v1.2.3', '1.2.3-beta.10+meta', null, undefined, 1.5]) {
    assert.equal(parseVersion(v), null, `应当拒绝 ${JSON.stringify(v)}`);
  }
});

test('compareVersions: 主/次/补丁为数字比较（非字典序）', () => {
  assert.equal(compareVersions('2.0.0', '1.9.9'), 1);
  assert.equal(compareVersions('1.10.0', '1.9.0'), 1); 
  assert.equal(compareVersions('1.2.10', '1.2.9'), 1);
  assert.equal(compareVersions('1.2.3', '1.2.4'), -1);
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  assert.equal(compareVersions('0.0.1', '0.0.2'), -1);
});

test('compareVersions: 预发布语义（release > prerelease；数字标识符 < 字母标识符）', () => {
  assert.equal(compareVersions('0.1.0', '0.1.0-rc.6'), 1);
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0'), -1);
  assert.equal(compareVersions('1.0.0-rc.9', '1.0.0-rc.10'), -1); 
  assert.equal(compareVersions('1.0.0-rc.10', '1.0.0-rc.9'), 1);
  assert.equal(compareVersions('1.0.0-1', '1.0.0-alpha'), -1); 
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-beta'), -1); 
  assert.equal(compareVersions('1.0.0-beta.2', '1.0.0-beta.10'), -1);
  assert.equal(compareVersions('1.0.0-beta.10', '1.0.0-rc.1'), -1); 
  assert.equal(compareVersions('1.0.0-rc.1.1', '1.0.0-rc.1'), 1); 
});

test('compareVersions: 非法版本按相等处理（0）', () => {
  assert.equal(compareVersions('abc', '1.2.3'), 0);
  assert.equal(compareVersions('1.2.3', 'nope'), 0);
  assert.equal(compareVersions(null, undefined), 0);
});

test('tagToVersion: 去掉 v 前缀并校验 semver 开头', () => {
  assert.equal(tagToVersion('v1.2.3'), '1.2.3');
  assert.equal(tagToVersion('V2.0.0'), '2.0.0');
  assert.equal(tagToVersion('1.2.3'), '1.2.3');
  assert.equal(tagToVersion('v1.2.3-beta.1'), '1.2.3-beta.1');
  
  assert.equal(tagToVersion('v1.2.3.4'), '1.2.3.4');
  assert.equal(tagToVersion('v1.2.3-beta.10+meta'), '1.2.3-beta.10+meta');
});

test('tagToVersion: 非 semver 开头返回 null', () => {
  for (const t of ['release-1.2.3', '1.2', 'latest', 'v1.2', '']) {
    assert.equal(tagToVersion(t), null, `tag: ${JSON.stringify(t)}`);
  }
});

test('parseGhRepo: 常见 URL 形态', () => {
  assert.equal(parseGhRepo('https://github.com/Airmetro/dsh-update-checker'), 'Airmetro/dsh-update-checker');
  assert.equal(parseGhRepo('git@github.com:owner/repo.git'), 'owner/repo');
  assert.equal(parseGhRepo('https://github.com/a/b.git'), 'a/b');
  assert.equal(parseGhRepo({ url: 'https://github.com/a/b' }), 'a/b');
  assert.equal(parseGhRepo('a/b'), 'a/b'); 
});

test('parseGhRepo: 无法解析返回 null', () => {
  assert.equal(parseGhRepo(null), null);
  assert.equal(parseGhRepo(''), null);
  assert.equal(parseGhRepo('https://gitlab.com/a/b'), null);
  assert.equal(parseGhRepo({}), null);
});

test('parseGhRepo: 仓库名含点号保留（不再截断）', () => {
  assert.equal(parseGhRepo('https://github.com/my-org/my.plugin'), 'my-org/my.plugin');
  assert.equal(parseGhRepo('https://github.com/a/b.c.d'), 'a/b.c.d');
});

test('parseGhRepo: .git 后缀被剥除（含带尾随路径）', () => {
  assert.equal(parseGhRepo('https://github.com/a/b.git'), 'a/b');
  assert.equal(parseGhRepo('a/b.git'), 'a/b');
  assert.equal(parseGhRepo('https://github.com/a/b.git/tree/main'), 'a/b');
});
