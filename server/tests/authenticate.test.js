import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config();

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import jwt from 'jsonwebtoken';

import { authenticate } from '../src/middleware/authenticate.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { signAccessToken } from '../src/utils/token.js';
import { getAuthConfig } from '../src/config/auth.js';

describe('Authentication Middleware Foundation', () => {
  let app;
  let server;
  let baseUrl;
  let validToken;
  let expiredToken;
  let testUserId = 'user_abc_123456789';

  before(async () => {
    // Ensure deterministic test auth configuration
    process.env.JWT_SECRET = 'deterministic_test_jwt_secret_min_32_characters!';
    process.env.JWT_EXPIRES_IN = '15m';

    const config = getAuthConfig();
    validToken = signAccessToken(testUserId, config);
    expiredToken = signAccessToken('expired_user', { ...config, expiresIn: '1ms' });

    // Wait briefly so expiredToken expires
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Create minimal test Express app with a protected endpoint
    app = express();
    app.use(express.json());

    app.get('/protected', authenticate, (req, res) => {
      res.status(200).json({
        success: true,
        message: 'Access granted',
        auth: req.auth,
      });
    });

    // Centralized error handling
    app.use(errorHandler);

    // Start ephemeral server
    server = app.listen(0);
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('1. Valid Bearer token succeeds, calls next(), and attaches req.auth.userId', async () => {
    const res = await fetch(`${baseUrl}/protected`, {
      headers: {
        Authorization: `Bearer ${validToken}`,
      },
    });

    const data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(data.success, true);
    assert.equal(data.auth?.userId, testUserId);
  });

  it('2. Missing Authorization header returns uniform HTTP 401 Unauthorized', async () => {
    const res = await fetch(`${baseUrl}/protected`);
    const data = await res.json();

    assert.equal(res.status, 401);
    assert.equal(data.success, false);
    assert.equal(data.message, 'Authentication required. Invalid or missing authorization token.');
  });

  it('3. Non-Bearer authorization schemes (e.g. Basic) return HTTP 401', async () => {
    const res = await fetch(`${baseUrl}/protected`, {
      headers: {
        Authorization: 'Basic dXNlcjpwYXNzd29yZA==',
      },
    });

    const data = await res.json();
    assert.equal(res.status, 401);
    assert.equal(data.success, false);
    assert.equal(data.message, 'Authentication required. Invalid or missing authorization token.');
  });

  it('4. Malformed Authorization headers return HTTP 401', async () => {
    const malformedHeaders = [
      'Bearer',
      'Bearer ',
      'Bearer token1 token2',
      'bearer-without-space-token',
      'Token onlyWithoutBearer',
    ];

    for (const header of malformedHeaders) {
      const res = await fetch(`${baseUrl}/protected`, {
        headers: {
          Authorization: header,
        },
      });

      const data = await res.json();
      assert.equal(res.status, 401, `Expected 401 for header: "${header}"`);
      assert.equal(data.success, false);
      assert.equal(data.message, 'Authentication required. Invalid or missing authorization token.');
    }
  });

  it('5. Invalid signature or corrupted token returns uniform HTTP 401', async () => {
    const invalidSignatureToken = validToken.slice(0, -6) + 'abcdef';

    const res = await fetch(`${baseUrl}/protected`, {
      headers: {
        Authorization: `Bearer ${invalidSignatureToken}`,
      },
    });

    const data = await res.json();
    assert.equal(res.status, 401);
    assert.equal(data.success, false);
    assert.equal(data.message, 'Authentication required. Invalid or missing authorization token.');
  });

  it('6. Expired token returns identical uniform HTTP 401 without disclosing expiration details', async () => {
    const res = await fetch(`${baseUrl}/protected`, {
      headers: {
        Authorization: `Bearer ${expiredToken}`,
      },
    });

    const data = await res.json();
    assert.equal(res.status, 401);
    assert.equal(data.success, false);
    // Message MUST be identical to invalid/missing cases to prevent user enumeration or state disclosure
    assert.equal(data.message, 'Authentication required. Invalid or missing authorization token.');
  });

  it('7. Middleware does not trust caller-supplied userId in request body or query', async () => {
    const res = await fetch(`${baseUrl}/protected?userId=hacked_admin_id`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${validToken}`,
        'Content-Type': 'application/json',
      },
    });

    const data = await res.json();
    assert.equal(res.status, 200);
    // Identity must come exclusively from verified token, ignoring query parameters
    assert.equal(data.auth?.userId, testUserId);
    assert.notEqual(data.auth?.userId, 'hacked_admin_id');
  });

  it('8. Tokens without user identity claim are rejected with HTTP 401', async () => {
    const config = getAuthConfig();
    const tokenWithoutIdentity = jwt.sign({ role: 'admin' }, config.secret, {
      algorithm: 'HS256',
      issuer: config.issuer,
      audience: config.audience,
    });

    const res = await fetch(`${baseUrl}/protected`, {
      headers: {
        Authorization: `Bearer ${tokenWithoutIdentity}`,
      },
    });

    const data = await res.json();
    assert.equal(res.status, 401);
    assert.equal(data.success, false);
    assert.equal(data.message, 'Authentication required. Invalid or missing authorization token.');
  });

  it('9. Tokens with whitespace-only user identity are rejected with HTTP 401', async () => {
    const config = getAuthConfig();
    const tokenWithWhitespaceIdentity = jwt.sign({ userId: '    ' }, config.secret, {
      algorithm: 'HS256',
      issuer: config.issuer,
      audience: config.audience,
    });

    const res = await fetch(`${baseUrl}/protected`, {
      headers: {
        Authorization: `Bearer ${tokenWithWhitespaceIdentity}`,
      },
    });

    const data = await res.json();
    assert.equal(res.status, 401);
    assert.equal(data.success, false);
    assert.equal(data.message, 'Authentication required. Invalid or missing authorization token.');
  });
});
