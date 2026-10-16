import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { getAuthConfig, validateAuthConfig, MIN_SECRET_LENGTH } from '../src/config/auth.js';

describe('Authentication Configuration Module', () => {
  const validSecret32 = '12345678901234567890123456789012'; // exactly 32 chars

  it('1. Successfully loads valid configuration with defaults', () => {
    const env = {
      JWT_SECRET: validSecret32,
    };

    const config = getAuthConfig(env);

    assert.equal(config.secret, validSecret32);
    assert.equal(config.expiresIn, '15m');
    assert.equal(config.issuer, 'mailpulse-api');
    assert.equal(config.audience, 'mailpulse-client');
    assert.equal(config.algorithm, 'HS256');
  });

  it('2. Custom issuer, audience, and expiresIn options are respected', () => {
    const env = {
      JWT_SECRET: validSecret32 + '_extended_entropy_key',
      JWT_EXPIRES_IN: '1h',
      JWT_ISSUER: 'custom-auth-service',
      JWT_AUDIENCE: 'custom-mobile-client',
    };

    const config = validateAuthConfig(env);

    assert.equal(config.expiresIn, '1h');
    assert.equal(config.issuer, 'custom-auth-service');
    assert.equal(config.audience, 'custom-mobile-client');
  });

  it('3. Throws when JWT_SECRET is missing or empty', () => {
    assert.throws(
      () => getAuthConfig({}),
      /JWT_SECRET environment variable is required/i
    );

    assert.throws(
      () => getAuthConfig({ JWT_SECRET: '' }),
      /JWT_SECRET environment variable is required/i
    );

    assert.throws(
      () => getAuthConfig({ JWT_SECRET: '   ' }),
      /JWT_SECRET environment variable is required/i
    );
  });

  it('4. Rejects secrets shorter than minimum entropy policy (32 characters)', () => {
    const shortSecret = 'short_secret_only_24_ch!';
    assert.ok(shortSecret.length < MIN_SECRET_LENGTH);

    assert.throws(
      () => getAuthConfig({ JWT_SECRET: shortSecret }),
      /must be at least 32 characters long/i
    );
  });

  it('5. Rejects invalid token expiration strings', () => {
    const invalidExpirations = ['invalid_time', '15x', '-10m', '0s', ''];

    for (const exp of invalidExpirations) {
      assert.throws(
        () => getAuthConfig({ JWT_SECRET: validSecret32, JWT_EXPIRES_IN: exp }),
        /must be a positive number of seconds or a valid time string/i
      );
    }
  });
});
