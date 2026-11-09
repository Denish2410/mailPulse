import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getSecurityWarnings } from '../src/config/securityWarnings.js';

describe('getSecurityWarnings', () => {
  it('stays quiet outside production', () => {
    assert.deepEqual(getSecurityWarnings({ NODE_ENV: 'development' }), []);
    assert.deepEqual(getSecurityWarnings({ NODE_ENV: 'test' }), []);
    assert.deepEqual(getSecurityWarnings({}), []);
  });

  it('flags a missing TRACKING_SECRET and localhost URLs in production', () => {
    const w = getSecurityWarnings({ NODE_ENV: 'production', CLIENT_URL: 'http://localhost:5173' });
    assert.ok(w.some((m) => m.includes('TRACKING_SECRET')));
    assert.ok(w.some((m) => m.includes('CLIENT_URL')));
    assert.ok(w.some((m) => m.includes('TRACKING_BASE_URL')));
  });

  it('is silent for a properly configured production environment', () => {
    assert.deepEqual(
      getSecurityWarnings({
        NODE_ENV: 'production',
        TRACKING_SECRET: 'x'.repeat(40),
        CLIENT_URL: 'https://mail.example.com',
        TRACKING_BASE_URL: 'https://mail.example.com',
      }),
      []
    );
  });
});
