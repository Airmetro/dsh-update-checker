import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStageInstallArgs, buildPluginInstallArgs } from '../lib/index.js';

test('stage install skips peer resolution: the staging prefix is a throwaway tree', () => {
  const stage = buildStageInstallArgs('C:\\tmp\\stage');
  assert.ok(stage.includes('--legacy-peer-deps'));
  assert.ok(stage.includes('--prefix'));
  assert.equal(stage[stage.indexOf('--prefix') + 1], 'C:\\tmp\\stage');
  assert.ok(stage.includes('--no-save'));
  assert.ok(stage.includes('--package-lock=false'));
  assert.ok(stage.includes('--omit=dev'));

  const npmChannel = buildPluginInstallArgs('C:\\tmp\\stage', 'pkg@1.2.3');
  assert.ok(npmChannel.includes('--legacy-peer-deps'));
  assert.ok(npmChannel.includes('pkg@1.2.3'));
  assert.ok(npmChannel.includes('--no-save'));
});
