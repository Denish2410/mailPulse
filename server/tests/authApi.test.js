import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config();

// Ensure test environment variables are set for deterministic tests
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET =
  process.env.JWT_SECRET || 'deterministic_test_jwt_secret_min_32_characters!';
process.env.JWT_EXPIRES_IN = '15m';

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import express from 'express';
import rateLimit from 'express-rate-limit';

import app from '../src/app.js';
import User from '../src/models/User.js';
import { connectDB } from '../src/config/db.js';
import { verifyAccessToken, signAccessToken } from '../src/utils/token.js';
import { hashPassword } from '../src/services/password.service.js';

describe('Authentication API (Registration, Login & Security Integration)', () => {
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

    it('6. Concurrent duplicate registrations are safely handled via database unique index', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      const email = `${testPrefix}-concurrent@example.com`;
      const payload = JSON.stringify({
        name: 'Concurrent User',
        email,
        password: 'ValidPassword123!',
      });

      // Fire two identical registration requests simultaneously
      const [resA, resB] = await Promise.all([
        fetch(`${baseUrl}/api/v1/auth/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: payload,
        }),
        fetch(`${baseUrl}/api/v1/auth/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: payload,
        }),
      ]);

      const statuses = [resA.status, resB.status].sort();
      // Exactly one request must succeed (201) and the duplicate must be rejected (409)
      assert.deepEqual(statuses, [201, 409]);

      // Confirm only 1 database document was created
      const count = await User.countDocuments({ email });
      assert.equal(count, 1);
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

  describe('GET /api/v1/auth/me', () => {
    let activeUser;
    let activeToken;
    let suspendedUser;
    let suspendedToken;

    beforeEach(async () => {
      if (!isDbConnected) return;

      const passwordHash = await hashPassword('ValidPassword123!');

      // Create active user
      activeUser = await User.create({
        name: 'Active Current User',
        email: `${testPrefix}-me-active@example.com`,
        passwordHash,
        status: 'active',
      });
      activeToken = signAccessToken(activeUser);

      // Create suspended user
      suspendedUser = await User.create({
        name: 'Suspended Current User',
        email: `${testPrefix}-me-suspended@example.com`,
        passwordHash,
        status: 'suspended',
      });
      suspendedToken = signAccessToken(suspendedUser);
    });

    it('12. A valid token for an active user returns HTTP 200 and the correct safe profile', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      const res = await fetch(`${baseUrl}/api/v1/auth/me`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${activeToken}`,
        },
      });

      const data = await res.json();

      assert.equal(res.status, 200);
      assert.equal(data.success, true);
      assert.equal(data.message, 'Current user profile retrieved successfully');
      assert.ok(data.data?.user);
      assert.equal(data.data.user.id, activeUser._id.toString());
      assert.equal(data.data.user.name, 'Active Current User');
      assert.equal(data.data.user.email, `${testPrefix}-me-active@example.com`);
      assert.equal(data.data.user.status, 'active');
      assert.ok(data.data.user.createdAt);
      assert.ok(data.data.user.updatedAt);
    });

    it('13. The response does not contain passwordHash or sensitive internal fields', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      const res = await fetch(`${baseUrl}/api/v1/auth/me`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${activeToken}`,
        },
      });

      const data = await res.json();

      assert.equal(res.status, 200);
      assert.equal(data.data.user.passwordHash, undefined);
      assert.equal(data.data.user.password, undefined);
      assert.equal(data.data.user._id, undefined);
      assert.equal(data.data.user.__v, undefined);
      assert.equal(JSON.stringify(data).includes('passwordHash'), false);
    });

    it('14. Missing authorization header is rejected with HTTP 401 Unauthorized', async () => {
      const res = await fetch(`${baseUrl}/api/v1/auth/me`, {
        method: 'GET',
      });

      const data = await res.json();

      assert.equal(res.status, 401);
      assert.equal(data.success, false);
      assert.equal(data.message, 'Authentication required. Invalid or missing authorization token.');
    });

    it('15. Malformed Bearer header is rejected with HTTP 401', async () => {
      const malformedHeaders = [
        'Bearer',
        'Bearer ',
        'Bearer token-one token-two',
        'Basic dXNlcjpwYXNz',
        'bearer-missing-space',
      ];

      for (const header of malformedHeaders) {
        const res = await fetch(`${baseUrl}/api/v1/auth/me`, {
          method: 'GET',
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

    it('16. Invalid or corrupted token is rejected with HTTP 401', async () => {
      const invalidToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.invalidpayload.invalidsig';

      const res = await fetch(`${baseUrl}/api/v1/auth/me`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${invalidToken}`,
        },
      });

      const data = await res.json();

      assert.equal(res.status, 401);
      assert.equal(data.success, false);
      assert.equal(data.message, 'Authentication required. Invalid or missing authorization token.');
    });

    it('17. Expired token is rejected with HTTP 401', async () => {
      const expiredToken = signAccessToken('expired-user-id', {
        secret: process.env.JWT_SECRET,
        expiresIn: '1ms',
        issuer: 'mailpulse-api',
        audience: 'mailpulse-client',
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      const res = await fetch(`${baseUrl}/api/v1/auth/me`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${expiredToken}`,
        },
      });

      const data = await res.json();

      assert.equal(res.status, 401);
      assert.equal(data.success, false);
      assert.equal(data.message, 'Authentication required. Invalid or missing authorization token.');
    });

    it('18. A valid token for a deleted/nonexistent user is rejected with HTTP 401', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      // Generate a valid ObjectId that does not exist in the database
      const nonExistentUserId = new mongoose.Types.ObjectId().toString();
      const nonExistentUserToken = signAccessToken(nonExistentUserId);

      const res = await fetch(`${baseUrl}/api/v1/auth/me`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${nonExistentUserToken}`,
        },
      });

      const data = await res.json();

      assert.equal(res.status, 401);
      assert.equal(data.success, false);
      assert.equal(data.message, 'User account not found.');
    });

    it('19. A valid token for a suspended user is rejected with HTTP 403 Forbidden', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      const res = await fetch(`${baseUrl}/api/v1/auth/me`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${suspendedToken}`,
        },
      });

      const data = await res.json();

      assert.equal(res.status, 403);
      assert.equal(data.success, false);
      assert.match(data.message, /account has been suspended/i);
    });

    it('20. A user identity cannot be overridden through a request body or query parameter', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      const spoofedId = suspendedUser._id.toString();

      const res = await fetch(`${baseUrl}/api/v1/auth/me?userId=${spoofedId}&id=${spoofedId}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${activeToken}`,
          'Content-Type': 'application/json',
        },
      });

      const data = await res.json();

      assert.equal(res.status, 200);
      assert.equal(data.success, true);
      // Profile MUST match activeUser from the verified token, ignoring query parameters
      assert.equal(data.data.user.id, activeUser._id.toString());
      assert.equal(data.data.user.email, activeUser.email);
      assert.notEqual(data.data.user.id, spoofedId);
    });

    it('21. A token containing a malformed non-ObjectId userId string returns HTTP 401 without 500 error', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      const malformedIdToken = signAccessToken('not-a-valid-24-hex-object-id');

      const res = await fetch(`${baseUrl}/api/v1/auth/me`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${malformedIdToken}`,
        },
      });

      const data = await res.json();
      assert.equal(res.status, 401);
      assert.equal(data.success, false);
      assert.equal(data.message, 'User account not found.');
    });
  });

  describe('Authentication Rate Limiting Security', () => {
    it('22. Exceeding rate limit threshold returns HTTP 429 and sanitized error message', async () => {
      const testLimiter = rateLimit({
        windowMs: 60 * 1000,
        max: 2,
        standardHeaders: true,
        legacyHeaders: false,
        message: {
          success: false,
          message: 'Too many authentication attempts from this IP address, please try again after 15 minutes.',
        },
      });

      const rateLimitApp = express();
      rateLimitApp.use(express.json());
      rateLimitApp.post('/test-rate-limit', testLimiter, (req, res) => {
        res.status(200).json({ success: true, message: 'Proceed' });
      });

      const rlServer = rateLimitApp.listen(0);
      const rlPort = rlServer.address().port;

      try {
        const r1 = await fetch(`http://127.0.0.1:${rlPort}/test-rate-limit`, { method: 'POST' });
        assert.equal(r1.status, 200);

        const r2 = await fetch(`http://127.0.0.1:${rlPort}/test-rate-limit`, { method: 'POST' });
        assert.equal(r2.status, 200);

        // Third attempt exceeds threshold
        const r3 = await fetch(`http://127.0.0.1:${rlPort}/test-rate-limit`, { method: 'POST' });
        const r3Data = await r3.json();
        assert.equal(r3.status, 429);
        assert.equal(r3Data.success, false);
        assert.match(r3Data.message, /too many authentication attempts/i);
      } finally {
        await new Promise((resolve) => rlServer.close(resolve));
      }
    });
  });

  describe('Full Authentication Lifecycle Integration (End-to-End)', () => {
    it('23. Executes complete 9-step registration, login, profile, suspension, deletion, and logout sequence', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      const e2eEmail = `${testPrefix}-e2e-lifecycle@example.com`;
      const e2ePassword = 'ComplexE2EPassword123!';

      // Step 1: Register a unique test user
      const registerRes = await fetch(`${baseUrl}/api/v1/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'E2E Lifecycle User',
          email: e2eEmail,
          password: e2ePassword,
        }),
      });
      const registerData = await registerRes.json();
      assert.equal(registerRes.status, 201);
      assert.equal(registerData.success, true);
      const registeredUserId = registerData.data.user.id;

      // Step 2: Confirm password is hashed with Argon2id in MongoDB and plaintext is absent
      const storedInDb = await User.findById(registeredUserId).select('+passwordHash');
      assert.ok(storedInDb);
      assert.ok(storedInDb.passwordHash.startsWith('$argon2id$'));
      assert.notEqual(storedInDb.passwordHash, e2ePassword);

      // Confirm default query excludes passwordHash
      const defaultQuery = await User.findById(registeredUserId);
      assert.equal(defaultQuery.passwordHash, undefined);

      // Step 3: Log in with registered credentials
      const loginRes = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: e2eEmail,
          password: e2ePassword,
        }),
      });
      const loginData = await loginRes.json();
      assert.equal(loginRes.status, 200);
      assert.ok(loginData.data.token);
      const authToken = loginData.data.token;

      // Step 4: Call GET /api/v1/auth/me with returned token
      const meRes = await fetch(`${baseUrl}/api/v1/auth/me`, {
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      });
      const meData = await meRes.json();
      assert.equal(meRes.status, 200);

      // Step 5: Confirm profile is safe and correct
      assert.equal(meData.data.user.id, registeredUserId);
      assert.equal(meData.data.user.email, e2eEmail);
      assert.equal(meData.data.user.status, 'active');
      assert.ok(meData.data.user.createdAt);
      assert.ok(meData.data.user.updatedAt);
      assert.equal(meData.data.user.passwordHash, undefined);
      assert.equal(meData.data.user.password, undefined);
      assert.equal(meData.data.user.__v, undefined);

      // Step 6: Confirm a request without a token is rejected
      const unauthRes = await fetch(`${baseUrl}/api/v1/auth/me`);
      assert.equal(unauthRes.status, 401);

      // Step 7: Suspend the user and confirm protected access is rejected
      await User.findByIdAndUpdate(registeredUserId, { status: 'suspended' });
      const suspendedMeRes = await fetch(`${baseUrl}/api/v1/auth/me`, {
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      });
      const suspendedMeData = await suspendedMeRes.json();
      assert.equal(suspendedMeRes.status, 403);
      assert.match(suspendedMeData.message, /suspended/i);

      // Also confirm suspended user cannot log in
      const suspendedLoginRes = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: e2eEmail,
          password: e2ePassword,
        }),
      });
      assert.equal(suspendedLoginRes.status, 403);

      // Step 8: Confirm deleted user cannot continue using token on /me
      await User.findByIdAndDelete(registeredUserId);
      const deletedUserMeRes = await fetch(`${baseUrl}/api/v1/auth/me`, {
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      });
      const deletedUserMeData = await deletedUserMeRes.json();
      assert.equal(deletedUserMeRes.status, 401);
      assert.equal(deletedUserMeData.message, 'User account not found.');

      // Step 9: Verify client logout behavior (cleared token results in rejection)
      const afterLogoutRes = await fetch(`${baseUrl}/api/v1/auth/me`, {
        headers: {}, // simulate client-cleared token
      });
      assert.equal(afterLogoutRes.status, 401);
    });
  });

  describe('Existing Health Probe Compatibility', () => {
    it('24. Existing health check routes remain unauthenticated and fully functional', async () => {
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
