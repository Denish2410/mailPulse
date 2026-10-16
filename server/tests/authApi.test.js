import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config();

// Ensure test JWT secret is present for deterministic tests
process.env.JWT_SECRET =
  process.env.JWT_SECRET || 'deterministic_test_jwt_secret_min_32_characters!';
process.env.JWT_EXPIRES_IN = '15m';

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import app from '../src/app.js';
import User from '../src/models/User.js';
import { connectDB } from '../src/config/db.js';
import { verifyAccessToken } from '../src/utils/token.js';
import { hashPassword } from '../src/services/password.service.js';

describe('Authentication API (Registration & Login)', () => {
  let server;
  let baseUrl;
  let isDbConnected = false;
  const testPrefix = `authtest-${Date.now()}-${Math.floor(Math.random() * 10000)}`;

  before(async () => {
    try {
      await connectDB();
      isDbConnected = true;
      await User.init(); // ensure unique indexes are built
    } catch (err) {
      console.warn(`[Auth API Tests] MongoDB unavailable: ${err.message}`);
      isDbConnected = false;
    }

    server = app.listen(0);
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;
  });

  beforeEach(async () => {
    if (isDbConnected) {
      // Clean up any test users created by this test run
      await User.deleteMany({ email: new RegExp(`^${testPrefix}`) });
    }
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    if (isDbConnected) {
      await User.deleteMany({ email: new RegExp(`^${testPrefix}`) });
      await mongoose.disconnect();
    }
  });

  describe('POST /api/v1/auth/register', () => {
    it('1. Successfully registers a new user with valid input', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      const testEmail = `${testPrefix}-reg1@example.com`;
      const rawPassword = 'ValidPassword123!';

      const res = await fetch(`${baseUrl}/api/v1/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Jane Developer',
          email: testEmail,
          password: rawPassword,
        }),
      });

      const data = await res.json();

      assert.equal(res.status, 201);
      assert.equal(data.success, true);
      assert.equal(data.message, 'User registered successfully');
      assert.ok(data.data.user);
      assert.ok(data.data.user.id);
      assert.equal(data.data.user.name, 'Jane Developer');
      assert.equal(data.data.user.email, testEmail);
      assert.equal(data.data.user.status, 'active');
      assert.ok(data.data.user.createdAt);

      // Verify token
      assert.ok(data.data.token);
      assert.equal(data.data.tokenType, 'Bearer');
      assert.equal(data.data.expiresIn, '15m');

      // Verify token is valid and decodes to the registered user
      const decoded = verifyAccessToken(data.data.token);
      assert.equal(decoded.userId, data.data.user.id);

      // Verify response NEVER leaks password or passwordHash
      assert.equal(data.data.user.password, undefined);
      assert.equal(data.data.user.passwordHash, undefined);
      assert.equal(JSON.stringify(data).includes(rawPassword), false);

      // Verify database record has Argon2id hash, NOT raw password
      const stored = await User.findById(data.data.user.id).select('+passwordHash');
      assert.ok(stored.passwordHash);
      assert.ok(stored.passwordHash.startsWith('$argon2id$'));
      assert.notEqual(stored.passwordHash, rawPassword);
    });

    it('2. Normalizes email address to lowercase and trims whitespace', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      const rawEmail = `   ${testPrefix}-NORMALIZED@EXAMPLE.COM   `;
      const expectedNormalized = `${testPrefix}-normalized@example.com`;

      const res = await fetch(`${baseUrl}/api/v1/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: '  Trimmed Name  ',
          email: rawEmail,
          password: 'ValidPassword123!',
        }),
      });

      const data = await res.json();
      assert.equal(res.status, 201);
      assert.equal(data.data.user.email, expectedNormalized);
      assert.equal(data.data.user.name, 'Trimmed Name');

      const dbUser = await User.findOne({ email: expectedNormalized });
      assert.ok(dbUser);
      assert.equal(dbUser.email, expectedNormalized);
    });

    it('3. Rejects duplicate registration with HTTP 409 Conflict', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      const email = `${testPrefix}-duplicate@example.com`;

      // Initial registration
      const firstRes = await fetch(`${baseUrl}/api/v1/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'First User',
          email,
          password: 'ValidPassword123!',
        }),
      });
      assert.equal(firstRes.status, 201);

      // Second registration with same email (even with different casing)
      const secondRes = await fetch(`${baseUrl}/api/v1/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Second User',
          email: email.toUpperCase(),
          password: 'AnotherValidPassword123!',
        }),
      });

      const data = await secondRes.json();
      assert.equal(secondRes.status, 409);
      assert.equal(data.success, false);
      assert.match(data.message, /already exists/i);
    });

    it('4. Rejects invalid input data with HTTP 400 and structured validation errors', async () => {
      const invalidCases = [
        // Name too short
        { name: 'A', email: 'test@example.com', password: 'ValidPassword123!' },
        // Name missing
        { email: 'test@example.com', password: 'ValidPassword123!' },
        // Invalid email format
        { name: 'Valid Name', email: 'invalid-email', password: 'ValidPassword123!' },
        // Password too short (< 8 chars)
        { name: 'Valid Name', email: 'test@example.com', password: 'short' },
        // Password missing
        { name: 'Valid Name', email: 'test@example.com' },
        // Empty payload
        {},
      ];

      for (const payload of invalidCases) {
        const res = await fetch(`${baseUrl}/api/v1/auth/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });

        const data = await res.json();
        assert.equal(res.status, 400, `Expected 400 for payload: ${JSON.stringify(payload)}`);
        assert.equal(data.success, false);
        assert.equal(data.message, 'Validation failed');
        assert.ok(Array.isArray(data.errors));
      }
    });

    it('5. Rejects oversized passwords exceeding 128 characters to protect against DoS', async () => {
      const res = await fetch(`${baseUrl}/api/v1/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Valid Name',
          email: `${testPrefix}-oversized@example.com`,
          password: 'P'.repeat(129),
        }),
      });

      const data = await res.json();
      assert.equal(res.status, 400);
      assert.equal(data.success, false);
      assert.match(JSON.stringify(data.errors), /cannot exceed 128 characters/i);
    });
  });

  describe('POST /api/v1/auth/login', () => {
    const loginUserEmail = `${testPrefix}-login@example.com`;
    const loginPassword = 'StrongLoginPassword123!';
    let registeredUserId;

    beforeEach(async () => {
      if (!isDbConnected) return;

      const passwordHash = await hashPassword(loginPassword);
      const user = await User.create({
        name: 'Login Test User',
        email: loginUserEmail,
        passwordHash,
        status: 'active',
      });
      registeredUserId = user._id.toString();
    });

    it('6. Successfully logs in with valid credentials and returns access token', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      const res = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: loginUserEmail,
          password: loginPassword,
        }),
      });

      const data = await res.json();

      assert.equal(res.status, 200);
      assert.equal(data.success, true);
      assert.equal(data.message, 'Login successful');
      assert.ok(data.data.user);
      assert.equal(data.data.user.id, registeredUserId);
      assert.equal(data.data.user.email, loginUserEmail);
      assert.equal(data.data.user.status, 'active');

      // Verify token
      assert.ok(data.data.token);
      assert.equal(data.data.tokenType, 'Bearer');
      assert.equal(data.data.expiresIn, '15m');

      // Verify token decodes properly
      const decoded = verifyAccessToken(data.data.token);
      assert.equal(decoded.userId, registeredUserId);

      // Verify passwordHash is NOT exposed in response
      assert.equal(data.data.user.passwordHash, undefined);
      assert.equal(data.data.user.password, undefined);
    });

    it('7. Logs in successfully with uppercase and whitespace-padded email', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      const res = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: `   ${loginUserEmail.toUpperCase()}   `,
          password: loginPassword,
        }),
      });

      const data = await res.json();
      assert.equal(res.status, 200);
      assert.equal(data.data.user.email, loginUserEmail);
    });

    it('8. Incorrect password returns HTTP 401 with generic credential message', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      const res = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: loginUserEmail,
          password: 'WrongPassword999!',
        }),
      });

      const data = await res.json();
      assert.equal(res.status, 401);
      assert.equal(data.success, false);
      assert.equal(data.message, 'Invalid email or password.');
      assert.equal(data.data, undefined);
    });

    it('9. Unknown email returns identical HTTP 401 generic message without disclosing account non-existence', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      const res = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: `${testPrefix}-nonexistent@example.com`,
          password: 'AnyPassword123!',
        }),
      });

      const data = await res.json();
      assert.equal(res.status, 401);
      assert.equal(data.success, false);
      // Message MUST be identical to the incorrect password error
      assert.equal(data.message, 'Invalid email or password.');
    });

    it('10. Suspended user account is rejected with HTTP 403 Forbidden', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      const suspendedEmail = `${testPrefix}-suspended@example.com`;
      const password = 'SuspendedPassword123!';
      const passwordHash = await hashPassword(password);

      await User.create({
        name: 'Suspended User',
        email: suspendedEmail,
        passwordHash,
        status: 'suspended',
      });

      const res = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: suspendedEmail,
          password,
        }),
      });

      const data = await res.json();
      assert.equal(res.status, 403);
      assert.equal(data.success, false);
      assert.match(data.message, /account has been suspended/i);
    });

    it('11. Missing email or password returns HTTP 400 validation error', async () => {
      const res = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'user@example.com',
          // missing password
        }),
      });

      const data = await res.json();
      assert.equal(res.status, 400);
      assert.equal(data.success, false);
      assert.equal(data.message, 'Validation failed');
    });
  });

  describe('Existing Health Probe Compatibility', () => {
    it('12. Existing health check routes remain unauthenticated and fully functional', async () => {
      const liveRes = await fetch(`${baseUrl}/api/v1/health`);
      const liveData = await liveRes.json();
      assert.equal(liveRes.status, 200);
      assert.equal(liveData.status, 'healthy');

      if (isDbConnected) {
        const readyRes = await fetch(`${baseUrl}/api/v1/health/ready`);
        const readyData = await readyRes.json();
        assert.equal(readyRes.status, 200);
        assert.equal(readyData.status, 'ready');
      }
    });
  });
});
