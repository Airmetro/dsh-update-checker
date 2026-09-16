import test from 'node:test';
import assert from 'node:assert/strict';
import { mainUpdatePlatformError } from '../lib/index.js';

test('mainUpdatePlatformError: win32 permits the existing update worker', () => {
  assert.equal(mainUpdatePlatformError('win32'), null);
});

test('mainUpdatePlatformError: POSIX rejects before backup and Windows-only spawn', () => {
  for (const platform of ['linux', 'darwin']) {
    assert.deepEqual(mainUpdatePlatformError(platform), {
      code: 'E_PLATFORM_UNSUPPORTED',
      error: 'One-click core updates are unsupported on Linux/macOS. Stop DSH, update it manually, then restart DSH.',
    });
  }
});
