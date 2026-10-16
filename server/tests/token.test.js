import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

import { signAccessToken, verifyAccessToken } from '../src/utils/token.js';

describe('Token Service Utility (JWT)', () => {
  const testConfig = {
    secret: 'test_jwt_secret_must_be_at_least_32_chars_long!!',
    expiresIn: '15m',
    issuer: 'test-issuer',
    audience: 'test-audience',
    algorithm: 'HS256',
  };

  it('1. Successfully signs and verifies an access token with expected claims', () => {
    const userId = '507f1f77bcf86cd799439011';
    const token = signAccessToken(userId, testConfig);

    assert.equal(typeof token, 'string');
    assert.ok(token.split('.').length === 3, 'JWT should contain 3 dot-separated parts');

    const decoded = verifyAccessToken(token, testConfig);

    assert.equal(decoded.userId, userId);
    assert.equal(decoded.sub, userId);
    assert.equal(decoded.iss, testConfig.issuer);
    assert.equal(decoded.aud, testConfig.audience);
    assert.ok(decoded.exp);
    assert.ok(decoded.iat);
  });

  it('2. Extracts userId from user object and strips sensitive fields from payload', () => {
    const userObject = {
      _id: 'user_object_id_999',
      name: 'John Doe',
      email: 'john@example.com',
      password: 'plainPasswordShouldNotBeInToken',
      passwordHash: '$argon2id$secretHashShouldNotBeInToken',
    };

    const token = signAccessToken(userObject, testConfig);
    const decoded = verifyAccessToken(token, testConfig);

    assert.equal(decoded.userId, 'user_object_id_999');
    // Ensure sensitive fields are NEVER included in the decoded JWT payload
    assert.equal(decoded.password, undefined);
    assert.equal(decoded.passwordHash, undefined);
    assert.equal(decoded.email, undefined);
  });

  it('3. Throws when attempting to sign without a valid userId', () => {
    assert.throws(() => signAccessToken('', testConfig), /A valid non-empty userId is required/i);
    assert.throws(() => signAccessToken('   ', testConfig), /A valid non-empty userId is required/i);
    assert.throws(() => signAccessToken(null, testConfig), /A valid non-empty userId is required/i);
    assert.throws(() => signAccessToken({}, testConfig), /A valid non-empty userId is required/i);
  });

  it('4. Rejects token with invalid signature', () => {
    const validToken = signAccessToken('user123', testConfig);
    const wrongKeyConfig = {
      ...testConfig,
      secret: 'a_completely_different_secret_key_32_characters!',
    };

    assert.throws(
      () => verifyAccessToken(validToken, wrongKeyConfig),
      /invalid signature/i
    );
  });

  it('5. Rejects malformed or corrupted token strings', () => {
    const malformed = ['not-a-token', 'header.payload', 'a.b.c.d', '', '   '];

    for (const token of malformed) {
      assert.throws(
        () => verifyAccessToken(token, testConfig),
        /must be a non-empty string|jwt malformed|invalid token/i
      );
    }
  });

  it('6. Rejects expired tokens', async () => {
    // Sign token that expires immediately in 1ms
    const shortConfig = { ...testConfig, expiresIn: '1ms' };
    const expiredToken = signAccessToken('user_expired', shortConfig);

    // Pause briefly to ensure expiration
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.throws(
      () => verifyAccessToken(expiredToken, testConfig),
      (err) => {
        assert.equal(err.name, 'TokenExpiredError');
        assert.match(err.message, /jwt expired/i);
        return true;
      }
    );
  });

  it('7. Rejects unsigned tokens or tokens with unexpected algorithms (e.g. none)', () => {
    // Manually forge an unsigned token with algorithm 'none'
    const unsignedHeader = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ userId: 'hacker', iss: testConfig.issuer, aud: testConfig.audience })).toString('base64url');
    const forgedToken = `${unsignedHeader}.${payload}.`;

    assert.throws(
      () => verifyAccessToken(forgedToken, testConfig),
      /jwt signature is required|invalid algorithm|unsupported/i
    );
  });

  it('8. Rejects token with mismatched issuer or audience', () => {
    const token = signAccessToken('user123', testConfig);

    // Verify with different expected issuer
    assert.throws(
      () => verifyAccessToken(token, { ...testConfig, issuer: 'wrong-issuer' }),
      /jwt issuer invalid/i
    );

    // Verify with different expected audience
    assert.throws(
      () => verifyAccessToken(token, { ...testConfig, audience: 'wrong-audience' }),
      /jwt audience invalid/i
    );
  });
});
