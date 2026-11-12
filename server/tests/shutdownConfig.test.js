import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  getShutdownTimeoutMs,
  validateShutdownConfig,
} from '../src/config/shutdown.js';

describe('Shutdown timeout configuration', () => {
  it('defaults to 10 s when unset or blank, with no grace period configured', () => {
    assert.deepEqual(validateShutdownConfig({}), { timeoutMs: DEFAULT_SHUTDOWN_TIMEOUT_MS, graceMs: null });
    assert.equal(validateShutdownConfig({ SHUTDOWN_TIMEOUT_MS: '  ', STOP_GRACE_SECONDS: '' }).timeoutMs, 10000);
    assert.equal(getShutdownTimeoutMs({}), 10000);
  });

  it('accepts valid custom values', () => {
    assert.equal(validateShutdownConfig({ SHUTDOWN_TIMEOUT_MS: '20000' }).timeoutMs, 20000);
    assert.equal(getShutdownTimeoutMs({ SHUTDOWN_TIMEOUT_MS: '20000' }), 20000);
  });

  it('accepts a timeout that leaves the 5 s margin before the container grace period', () => {
    assert.deepEqual(validateShutdownConfig({ SHUTDOWN_TIMEOUT_MS: '20000', STOP_GRACE_SECONDS: '40' }), {
      timeoutMs: 20000,
      graceMs: 40000,
    });
    // exactly grace - margin is the largest allowed value
    assert.equal(validateShutdownConfig({ SHUTDOWN_TIMEOUT_MS: '35000', STOP_GRACE_SECONDS: '40' }).timeoutMs, 35000);
    // the 10 s default does not fit a 10 s grace period once the margin is applied
    assert.throws(() => validateShutdownConfig({ STOP_GRACE_SECONDS: '10' }), /shorter than the container stop grace period/);
  });

  it('rejects a timeout that is not shorter than the grace period minus the margin', () => {
    assert.throws(() => validateShutdownConfig({ SHUTDOWN_TIMEOUT_MS: '35001', STOP_GRACE_SECONDS: '40' }), /STOP_GRACE_SECONDS=40/);
    assert.throws(() => validateShutdownConfig({ SHUTDOWN_TIMEOUT_MS: '60000', STOP_GRACE_SECONDS: '40' }), /Lower SHUTDOWN_TIMEOUT_MS/);
  });

  it('rejects invalid values instead of silently ignoring them', () => {
    for (const bad of ['abc', '-5', '0', '999', '1.5', '10s', '99999999']) {
      assert.throws(() => validateShutdownConfig({ SHUTDOWN_TIMEOUT_MS: bad }), /SHUTDOWN_TIMEOUT_MS must be/, bad);
    }
    for (const bad of ['abc', '0', '-1', '2.5']) {
      assert.throws(() => validateShutdownConfig({ STOP_GRACE_SECONDS: bad }), /STOP_GRACE_SECONDS must be/, bad);
    }
  });

  it('the runtime reader falls back to the default for invalid values and never throws', () => {
    for (const bad of ['abc', '-5', '0', '999', '10s']) {
      assert.equal(getShutdownTimeoutMs({ SHUTDOWN_TIMEOUT_MS: bad }), DEFAULT_SHUTDOWN_TIMEOUT_MS, bad);
    }
  });
});
