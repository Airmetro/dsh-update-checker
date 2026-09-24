import test from 'node:test';
import assert from 'node:assert/strict';
import { mainUpdatePlatformError } from '../lib/index.js';

test('mainUpdatePlatformError: win32 permits the existing update worker', () => {
  assert.equal(mainUpdatePlatformError('win32'), null);
});

test('mainUpdatePlatformError: POSIX is gated on a usable port probe', () => {
  assert.equal(mainUpdatePlatformError('linux', { probe: true, systemctl: false }), null);

  for (const platform of ['linux', 'darwin']) {
    const err = mainUpdatePlatformError(platform, { probe: false, systemctl: false });
    assert.equal(err.code, 'E_PLATFORM_UNSUPPORTED');
    assert.match(err.error, /ss|lsof/);
  }
});
