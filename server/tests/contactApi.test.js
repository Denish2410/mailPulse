import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config();

// Ensure test environment variables are set
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET =
  process.env.JWT_SECRET || 'deterministic_test_jwt_secret_min_32_characters!';
process.env.JWT_EXPIRES_IN = '15m';

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import app from '../src/app.js';
import User from '../src/models/User.js';
import Contact from '../src/models/Contact.js';
import { connectDB } from '../src/config/db.js';
import { signAccessToken } from '../src/utils/token.js';
import { getAuthConfig } from '../src/config/auth.js';
import jwt from 'jsonwebtoken';
import { hashPassword } from '../src/services/password.service.js';

describe('Contact CRUD APIs (/api/v1/contacts)', () => {
  let server;
  let baseUrl;
  let isDbConnected = false;
  const testPrefix = `contactapitest-${Date.now()}-${Math.floor(Math.random() * 10000)}`;

  let userOne;
  let tokenOne;
  let userTwo;
  let tokenTwo;

  before(async () => {
    try {
      await connectDB();
      isDbConnected = true;
      await User.init();
      await Contact.init();
    } catch (err) {
      console.warn(`[Contact API Tests] MongoDB unavailable: ${err.message}`);
      isDbConnected = false;
    }

    server = app.listen(0);
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;

    if (isDbConnected) {
      const defaultPasswordHash = await hashPassword('StrongPassword123!');

      userOne = await User.create({
        name: 'User One',
        email: `${testPrefix}-user1@example.com`,
        passwordHash: defaultPasswordHash,
      });
      tokenOne = signAccessToken(userOne);

      userTwo = await User.create({
        name: 'User Two',
        email: `${testPrefix}-user2@example.com`,
        passwordHash: defaultPasswordHash,
      });
      tokenTwo = signAccessToken(userTwo);
    }
  });

  beforeEach(async () => {
    if (isDbConnected) {
      // Clean up contacts created during testing
      await Contact.deleteMany({ email: new RegExp(`^${testPrefix}`) });
    }
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    if (isDbConnected) {
      await Contact.deleteMany({ email: new RegExp(`^${testPrefix}`) });
      await User.deleteMany({ email: new RegExp(`^${testPrefix}`) });
      await mongoose.disconnect();
    }
  });

  describe('1. Authentication Guard', () => {
    it('1. Unauthenticated requests are rejected with HTTP 401', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      const dummyId = new mongoose.Types.ObjectId().toString();

      // POST /contacts without auth header
      const postRes = await fetch(`${baseUrl}/api/v1/contacts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Unauth Contact', email: `${testPrefix}-unauth@example.com` }),
      });
      assert.equal(postRes.status, 401);
      const postData = await postRes.json();
      assert.equal(postData.success, false);

      // GET /contacts without auth header
      const getRes = await fetch(`${baseUrl}/api/v1/contacts`);
      assert.equal(getRes.status, 401);

      // PATCH /contacts/:id without auth header
      const patchRes = await fetch(`${baseUrl}/api/v1/contacts/${dummyId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated' }),
      });
      assert.equal(patchRes.status, 401);

      // DELETE /contacts/:id without auth header
      const deleteRes = await fetch(`${baseUrl}/api/v1/contacts/${dummyId}`, {
        method: 'DELETE',
      });
      assert.equal(deleteRes.status, 401);

      // Request with invalid token string
      const invalidTokenRes = await fetch(`${baseUrl}/api/v1/contacts`, {
        headers: { Authorization: 'Bearer invalid.jwt.token' },
      });
      assert.equal(invalidTokenRes.status, 401);
    });

    it('Expired JWT access token on GET /api/v1/contacts returns HTTP 401', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      const config = getAuthConfig();
      const expiredToken = signAccessToken(userOne, { ...config, expiresIn: '1ms' });
      await new Promise((resolve) => setTimeout(resolve, 50));

      const res = await fetch(`${baseUrl}/api/v1/contacts`, {
        headers: { Authorization: `Bearer ${expiredToken}` },
      });

      assert.equal(res.status, 401);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.equal(data.message, 'Authentication required. Invalid or missing authorization token.');
      assert.equal(data.data, undefined);
    });

    it('Invalid JWT signature on GET /api/v1/contacts returns HTTP 401', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      const tamperedSecret = 'wrong_secret_at_least_32_characters_long!';
      const invalidSigToken = jwt.sign(
        { userId: userOne._id.toString() },
        tamperedSecret,
        {
          algorithm: 'HS256',
          expiresIn: '15m',
          issuer: 'mailpulse-auth',
          audience: 'mailpulse-client',
          subject: userOne._id.toString(),
        }
      );

      const res = await fetch(`${baseUrl}/api/v1/contacts`, {
        headers: { Authorization: `Bearer ${invalidSigToken}` },
      });

      assert.equal(res.status, 401);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.equal(data.message, 'Authentication required. Invalid or missing authorization token.');
      assert.equal(data.data, undefined);
    });

    it('Correctly signed token with non-ObjectId user identity returns HTTP 401 from controller guard', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      const config = getAuthConfig();
      const nonObjectIdUserId = 'not-a-valid-mongo-object-id';
      const tokenWithMalformedId = signAccessToken(nonObjectIdUserId, config);

      const res = await fetch(`${baseUrl}/api/v1/contacts`, {
        headers: { Authorization: `Bearer ${tokenWithMalformedId}` },
      });

      assert.equal(res.status, 401);
      const data = await res.json();
      assert.equal(data.success, false);
      // The authenticate middleware passes req.auth.userId = 'not-a-valid-mongo-object-id'
      // The contact controller's guard checks !mongoose.isValidObjectId(userId) and throws 401
      assert.equal(data.message, 'Authentication required. Invalid user identity.');
      assert.equal(data.data, undefined);
    });
  });

  describe('2. POST /api/v1/contacts (Create Contact)', () => {
    it('2. An authenticated user can create a valid contact', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      const res = await fetch(`${baseUrl}/api/v1/contacts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenOne}`,
        },
        body: JSON.stringify({
          name: '  Alice Johnson  ',
          email: `  ${testPrefix.toUpperCase()}-Alice@Example.COM  `,
        }),
      });

      assert.equal(res.status, 201);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.message, 'Contact created successfully');
      assert.ok(data.data.contact);
      assert.equal(data.data.contact.name, 'Alice Johnson');
      assert.equal(data.data.contact.email, `${testPrefix.toLowerCase()}-alice@example.com`);
      assert.ok(data.data.contact.id);
      assert.equal(data.data.contact._id, undefined, '_id should not be exposed to client');
      assert.equal(data.data.contact.userId, undefined, 'userId should not be exposed to client');
      assert.ok(data.data.contact.createdAt);
      assert.ok(data.data.contact.updatedAt);

      // Verify record exists in MongoDB with proper ownership
      const persisted = await Contact.findById(data.data.contact.id);
      assert.ok(persisted);
      assert.equal(persisted.userId.toString(), userOne._id.toString());
    });

    it('7. Invalid request bodies are rejected with HTTP 400', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      // Missing name
      const resMissingName = await fetch(`${baseUrl}/api/v1/contacts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenOne}`,
        },
        body: JSON.stringify({ email: `${testPrefix}-noname@example.com` }),
      });
      assert.equal(resMissingName.status, 400);
      const errName = await resMissingName.json();
      assert.equal(errName.success, false);
      assert.ok(errName.errors.some((e) => e.path.includes('name')));

      // Missing email
      const resMissingEmail = await fetch(`${baseUrl}/api/v1/contacts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenOne}`,
        },
        body: JSON.stringify({ name: 'No Email' }),
      });
      assert.equal(resMissingEmail.status, 400);

      // Malformed email
      const resBadEmail = await fetch(`${baseUrl}/api/v1/contacts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenOne}`,
        },
        body: JSON.stringify({ name: 'Bad Email', email: 'not-an-email' }),
      });
      assert.equal(resBadEmail.status, 400);

      // Name too short (< 2 characters)
      const resShortName = await fetch(`${baseUrl}/api/v1/contacts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenOne}`,
        },
        body: JSON.stringify({ name: 'A', email: `${testPrefix}-short@example.com` }),
      });
      assert.equal(resShortName.status, 400);
    });

    it('9. Duplicate emails for the same owner return HTTP 409', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      const contactEmail = `${testPrefix}-duplicate-test@example.com`;

      // First creation succeeds
      const firstRes = await fetch(`${baseUrl}/api/v1/contacts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenOne}`,
        },
        body: JSON.stringify({
          name: 'First Insertion',
          email: contactEmail,
        }),
      });
      assert.equal(firstRes.status, 201);

      // Second creation for the SAME user with identical (or differently cased) email fails with 409
      const secondRes = await fetch(`${baseUrl}/api/v1/contacts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenOne}`,
        },
        body: JSON.stringify({
          name: 'Second Insertion Attempt',
          email: `  ${contactEmail.toUpperCase()}  `,
        }),
      });

      assert.equal(secondRes.status, 409);
      const secondData = await secondRes.json();
      assert.equal(secondData.success, false);
      assert.match(secondData.message, /already exists/i);
    });

    it('Duplicate email race condition safeguard (MongoDB code 11000) translates to HTTP 409', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      const raceEmail = `${testPrefix}-race@example.com`;

      // Pre-insert a contact directly in DB
      await Contact.create({
        userId: userOne._id,
        name: 'Pre-existing Record',
        email: raceEmail,
      });

      // Temporarily stub Contact.findOne to return null to bypass proactive check
      // and test the final Mongoose compound unique index safeguard
      const originalFindOne = Contact.findOne;
      Contact.findOne = async () => null;

      try {
        const res = await fetch(`${baseUrl}/api/v1/contacts`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${tokenOne}`,
          },
          body: JSON.stringify({
            name: 'Concurrent Request Challenger',
            email: raceEmail,
          }),
        });

        assert.equal(res.status, 409);
        const data = await res.json();
        assert.equal(data.success, false);
        assert.match(data.message, /already exists/i);
        assert.equal(data.stack, undefined);
      } finally {
        Contact.findOne = originalFindOne;
      }
    });

    it('10. The same email can belong to different users', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      const sharedEmail = `${testPrefix}-shared-between-users@example.com`;

      // User One creates contact with sharedEmail
      const resOne = await fetch(`${baseUrl}/api/v1/contacts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenOne}`,
        },
        body: JSON.stringify({
          name: 'User One Contact',
          email: sharedEmail,
        }),
      });
      assert.equal(resOne.status, 201);

      // User Two creates contact with identical sharedEmail - must succeed with 201
      const resTwo = await fetch(`${baseUrl}/api/v1/contacts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenTwo}`,
        },
        body: JSON.stringify({
          name: 'User Two Contact',
          email: sharedEmail,
        }),
      });
      assert.equal(resTwo.status, 201);

      const dataOne = await resOne.json();
      const dataTwo = await resTwo.json();
      assert.equal(dataOne.data.contact.email, dataTwo.data.contact.email);
      assert.notEqual(dataOne.data.contact.id, dataTwo.data.contact.id);

      // Verify distinct ownership in database
      const persistedOne = await Contact.findById(dataOne.data.contact.id);
      const persistedTwo = await Contact.findById(dataTwo.data.contact.id);
      assert.equal(persistedOne.userId.toString(), userOne._id.toString());
      assert.equal(persistedTwo.userId.toString(), userTwo._id.toString());
    });

    it('12. Attempts to pass protected or extra fields in create are rejected', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      const res = await fetch(`${baseUrl}/api/v1/contacts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenOne}`,
        },
        body: JSON.stringify({
          name: 'Malicious Attempt',
          email: `${testPrefix}-inject@example.com`,
          userId: userTwo._id.toString(), // Attempted spoof of owner ID
          _id: new mongoose.Types.ObjectId().toString(),
          role: 'admin',
        }),
      });

      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.message, /validation failed/i);
    });

    it('Creation rejects whitespace-only name with HTTP 400 and creates no contact', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      const uniqueEmail = `${testPrefix}-whitespace-create@example.com`;
      const res = await fetch(`${baseUrl}/api/v1/contacts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenOne}`,
        },
        body: JSON.stringify({
          name: '     ',
          email: uniqueEmail,
        }),
      });

      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.message, /validation failed/i);
      assert.ok(data.errors.some((e) => e.path.includes('name')));

      // Verify no contact was persisted in the database
      const persisted = await Contact.findOne({ email: uniqueEmail });
      assert.equal(persisted, null);
    });

    it('API creation rejects email exceeding 254 characters with HTTP 400', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      const longEmail = 'a'.repeat(64) + '@' + 'b'.repeat(63) + '.' + 'c'.repeat(63) + '.' + 'd'.repeat(60) + '.com';
      assert.ok(longEmail.length > 254);

      const res = await fetch(`${baseUrl}/api/v1/contacts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenOne}`,
        },
        body: JSON.stringify({
          name: 'Long Email Tester',
          email: longEmail,
        }),
      });

      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.message, /validation failed/i);
      assert.ok(data.errors.some((e) => e.path.includes('email')));
    });
  });

  describe('3. GET /api/v1/contacts (List Contacts)', () => {
    it('3. An authenticated user can list their own contacts in newest-first order', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      // Create 2 contacts sequentially with small delay to ensure distinct timestamps
      const c1 = await Contact.create({
        userId: userOne._id,
        name: 'Contact Early',
        email: `${testPrefix}-early@example.com`,
      });

      await new Promise((r) => setTimeout(r, 10));

      const c2 = await Contact.create({
        userId: userOne._id,
        name: 'Contact Later',
        email: `${testPrefix}-later@example.com`,
      });

      const res = await fetch(`${baseUrl}/api/v1/contacts`, {
        headers: { Authorization: `Bearer ${tokenOne}` },
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.message, 'Contacts retrieved successfully');
      assert.equal(data.data.count, 2);
      assert.equal(data.data.contacts.length, 2);

      // Verify newest first order
      assert.equal(data.data.contacts[0].id, c2._id.toString());
      assert.equal(data.data.contacts[1].id, c1._id.toString());
    });

    it("4. One user cannot see another user's contacts", async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      // Create contact for User One
      await Contact.create({
        userId: userOne._id,
        name: 'User One Exclusive',
        email: `${testPrefix}-u1-exclusive@example.com`,
      });

      // Create contact for User Two
      await Contact.create({
        userId: userTwo._id,
        name: 'User Two Exclusive',
        email: `${testPrefix}-u2-exclusive@example.com`,
      });

      // User One queries list
      const resOne = await fetch(`${baseUrl}/api/v1/contacts`, {
        headers: { Authorization: `Bearer ${tokenOne}` },
      });
      const dataOne = await resOne.json();
      assert.equal(resOne.status, 200);
      assert.ok(dataOne.data.contacts.some((c) => c.name === 'User One Exclusive'));
      assert.ok(!dataOne.data.contacts.some((c) => c.name === 'User Two Exclusive'));

      // User Two queries list
      const resTwo = await fetch(`${baseUrl}/api/v1/contacts`, {
        headers: { Authorization: `Bearer ${tokenTwo}` },
      });
      const dataTwo = await resTwo.json();
      assert.equal(resTwo.status, 200);
      assert.ok(dataTwo.data.contacts.some((c) => c.name === 'User Two Exclusive'));
      assert.ok(!dataTwo.data.contacts.some((c) => c.name === 'User One Exclusive'));
    });
  });

  describe('4. PATCH /api/v1/contacts/:id (Update Contact)', () => {
    it('An authenticated user can update name and/or email on their contact', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      const contact = await Contact.create({
        userId: userOne._id,
        name: 'Original Name',
        email: `${testPrefix}-patch@example.com`,
      });

      const res = await fetch(`${baseUrl}/api/v1/contacts/${contact._id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenOne}`,
        },
        body: JSON.stringify({
          name: 'Updated Name',
          email: `${testPrefix}-patched-email@example.com`,
        }),
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.data.contact.name, 'Updated Name');
      assert.equal(data.data.contact.email, `${testPrefix}-patched-email@example.com`);
    });

    it("5. One user cannot update another user's contact (returns 404, preserving record)", async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      // Contact owned by User Two
      const userTwoContact = await Contact.create({
        userId: userTwo._id,
        name: 'User Two Target',
        email: `${testPrefix}-u2-target@example.com`,
      });

      // User One tries to patch User Two's contact
      const res = await fetch(`${baseUrl}/api/v1/contacts/${userTwoContact._id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenOne}`,
        },
        body: JSON.stringify({
          name: 'Hacked Name',
        }),
      });

      assert.equal(res.status, 404);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.message, /not found/i);

      // Verify contact was not changed in database
      const unchanged = await Contact.findById(userTwoContact._id);
      assert.equal(unchanged.name, 'User Two Target');
    });

    it('8. Invalid contact IDs return HTTP 400', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      const res = await fetch(`${baseUrl}/api/v1/contacts/not-a-valid-id`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenOne}`,
        },
        body: JSON.stringify({ name: 'Valid Name' }),
      });

      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.ok(data.errors.some((e) => e.path.includes('params.id')));
    });

    it('9. Updating contact email to an existing duplicate email for same owner returns HTTP 409', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      const emailA = `${testPrefix}-email-a@example.com`;
      const emailB = `${testPrefix}-email-b@example.com`;

      await Contact.create({
        userId: userOne._id,
        name: 'Contact A',
        email: emailA,
      });

      const contactB = await Contact.create({
        userId: userOne._id,
        name: 'Contact B',
        email: emailB,
      });

      // Attempt to update Contact B to have emailA
      const res = await fetch(`${baseUrl}/api/v1/contacts/${contactB._id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenOne}`,
        },
        body: JSON.stringify({
          email: emailA,
        }),
      });

      assert.equal(res.status, 409);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.message, /already exists/i);

      // Verify Contact B was preserved
      const preserved = await Contact.findById(contactB._id);
      assert.equal(preserved.email, emailB);
    });

    it('11. Empty update bodies are rejected with HTTP 400', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      const contact = await Contact.create({
        userId: userOne._id,
        name: 'No Change Contact',
        email: `${testPrefix}-empty-patch@example.com`,
      });

      const res = await fetch(`${baseUrl}/api/v1/contacts/${contact._id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenOne}`,
        },
        body: JSON.stringify({}),
      });

      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.ok(data.errors.some((e) => e.message.includes('At least one field')));
    });

    it('12. Attempts to modify protected fields during update are rejected with HTTP 400', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      const contact = await Contact.create({
        userId: userOne._id,
        name: 'Protected Test',
        email: `${testPrefix}-protected@example.com`,
      });

      const res = await fetch(`${baseUrl}/api/v1/contacts/${contact._id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenOne}`,
        },
        body: JSON.stringify({
          userId: userTwo._id.toString(), // Protected field
          name: 'Updated Name',
        }),
      });

      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.message, /validation failed/i);
    });

    it('13. Missing contact ID returns HTTP 404', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      const randomValidId = new mongoose.Types.ObjectId().toString();

      const res = await fetch(`${baseUrl}/api/v1/contacts/${randomValidId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenOne}`,
        },
        body: JSON.stringify({ name: 'Does Not Exist' }),
      });

      assert.equal(res.status, 404);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.message, /not found/i);
    });

    it('4. Update validation rejects invalid values (malformed email, too short name)', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      const contact = await Contact.create({
        userId: userOne._id,
        name: 'Valid Contact',
        email: `${testPrefix}-val-patch@example.com`,
      });

      // Invalid email format
      const resBadEmail = await fetch(`${baseUrl}/api/v1/contacts/${contact._id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenOne}`,
        },
        body: JSON.stringify({ email: 'not-a-valid-email' }),
      });
      assert.equal(resBadEmail.status, 400);
      const dataBadEmail = await resBadEmail.json();
      assert.equal(dataBadEmail.success, false);
      assert.ok(dataBadEmail.errors.some((e) => e.path.includes('email')));
      assert.equal(dataBadEmail.stack, undefined);

      // Name too short (< 2 characters)
      const resShortName = await fetch(`${baseUrl}/api/v1/contacts/${contact._id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenOne}`,
        },
        body: JSON.stringify({ name: 'A' }),
      });
      assert.equal(resShortName.status, 400);
      const dataShortName = await resShortName.json();
      assert.equal(dataShortName.success, false);
      assert.ok(dataShortName.errors.some((e) => e.path.includes('name')));
      assert.equal(dataShortName.stack, undefined);
    });

    it('Updating contact with its existing email (exact and case/whitespace variations) succeeds with HTTP 200 without false-positive 409', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      const selfEmail = `${testPrefix}-self-email@example.com`;
      const contact = await Contact.create({
        userId: userOne._id,
        name: 'Self Update User',
        email: selfEmail,
      });

      // 1. Update with exact existing email
      const exactRes = await fetch(`${baseUrl}/api/v1/contacts/${contact._id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenOne}`,
        },
        body: JSON.stringify({
          name: 'Self Update User Renamed',
          email: selfEmail,
        }),
      });

      assert.equal(exactRes.status, 200);
      const exactData = await exactRes.json();
      assert.equal(exactData.success, true);
      assert.equal(exactData.data.contact.name, 'Self Update User Renamed');
      assert.equal(exactData.data.contact.email, selfEmail);

      // Verify DB persistence
      const exactDb = await Contact.findById(contact._id);
      assert.equal(exactDb.name, 'Self Update User Renamed');
      assert.equal(exactDb.email, selfEmail);

      // 2. Update with same email in uppercase and surrounded by whitespace
      const variationEmail = `   ${selfEmail.toUpperCase()}   `;
      const variationRes = await fetch(`${baseUrl}/api/v1/contacts/${contact._id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenOne}`,
        },
        body: JSON.stringify({
          email: variationEmail,
        }),
      });

      assert.equal(variationRes.status, 200);
      const variationData = await variationRes.json();
      assert.equal(variationData.success, true);
      assert.equal(variationData.data.contact.email, selfEmail);

      // Verify DB persistence remains normalized to lowercase
      const variationDb = await Contact.findById(contact._id);
      assert.equal(variationDb.email, selfEmail);
    });

    it('Update rejects whitespace-only name with HTTP 400 and preserves original contact', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      const originalName = 'Unchanged Contact Name';
      const contact = await Contact.create({
        userId: userOne._id,
        name: originalName,
        email: `${testPrefix}-whitespace-patch@example.com`,
      });

      const res = await fetch(`${baseUrl}/api/v1/contacts/${contact._id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenOne}`,
        },
        body: JSON.stringify({
          name: '     ',
        }),
      });

      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.message, /validation failed/i);
      assert.ok(data.errors.some((e) => e.path.includes('name')));

      // Verify original contact was not modified
      const preserved = await Contact.findById(contact._id);
      assert.equal(preserved.name, originalName);
    });

    it('Duplicate email race condition safeguard on update (MongoDB code 11000 on save) translates to HTTP 409', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      const existingEmail = `${testPrefix}-race-update-target@example.com`;

      // Pre-insert the target collision contact
      await Contact.create({
        userId: userOne._id,
        name: 'Target Existing Contact',
        email: existingEmail,
      });

      // Create the contact to be updated
      const contactToUpdate = await Contact.create({
        userId: userOne._id,
        name: 'Challenger Contact',
        email: `${testPrefix}-race-update-src@example.com`,
      });

      // Selectively stub Contact.findOne to bypass the proactive duplicate check
      // only for the duplicate-lookup query (_id: { $ne: id }), simulating a concurrent race
      const originalFindOne = Contact.findOne;
      Contact.findOne = function (filter, ...args) {
        if (filter && filter._id && filter._id.$ne) {
          return Promise.resolve(null);
        }
        return originalFindOne.call(this, filter, ...args);
      };

      try {
        const res = await fetch(`${baseUrl}/api/v1/contacts/${contactToUpdate._id}`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${tokenOne}`,
          },
          body: JSON.stringify({
            email: existingEmail,
          }),
        });

        assert.equal(res.status, 409);
        const data = await res.json();
        assert.equal(data.success, false);
        assert.match(data.message, /already exists/i);
        assert.equal(data.stack, undefined);
      } finally {
        Contact.findOne = originalFindOne;
      }
    });

    it('API update rejects email exceeding 254 characters with HTTP 400', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      const contact = await Contact.create({
        userId: userOne._id,
        name: 'Length Test Target',
        email: `${testPrefix}-update-length-test@example.com`,
      });

      const longEmail = 'a'.repeat(64) + '@' + 'b'.repeat(63) + '.' + 'c'.repeat(63) + '.' + 'd'.repeat(60) + '.com';
      assert.ok(longEmail.length > 254);

      const res = await fetch(`${baseUrl}/api/v1/contacts/${contact._id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenOne}`,
        },
        body: JSON.stringify({
          email: longEmail,
        }),
      });

      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.message, /validation failed/i);
      assert.ok(data.errors.some((e) => e.path.includes('email')));
    });

    it("Updating a contact to an email already owned by another user succeeds (per-user email scope)", async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      const sharedEmail = `${testPrefix}-charlie-shared@example.com`;

      // User B has a contact with sharedEmail
      const userTwoContact = await Contact.create({
        userId: userTwo._id,
        name: 'User Two Charlie',
        email: sharedEmail,
      });

      // User A creates a contact with alice@initial.com
      const userOneContact = await Contact.create({
        userId: userOne._id,
        name: 'User One Alice',
        email: `${testPrefix}-alice-initial@example.com`,
      });

      // User A updates their contact to sharedEmail
      const res = await fetch(`${baseUrl}/api/v1/contacts/${userOneContact._id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenOne}`,
        },
        body: JSON.stringify({
          email: sharedEmail,
        }),
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.data.contact.email, sharedEmail);

      // Verify User B's contact still exists and remains untouched
      const preservedUserTwoContact = await Contact.findById(userTwoContact._id);
      assert.ok(preservedUserTwoContact);
      assert.equal(preservedUserTwoContact.email, sharedEmail);
      assert.equal(preservedUserTwoContact.userId.toString(), userTwo._id.toString());
    });
  });

  describe('5. DELETE /api/v1/contacts/:id (Delete Contact)', () => {
    it('An authenticated user can delete their contact', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      const contact = await Contact.create({
        userId: userOne._id,
        name: 'To Be Deleted',
        email: `${testPrefix}-delete@example.com`,
      });

      const res = await fetch(`${baseUrl}/api/v1/contacts/${contact._id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${tokenOne}` },
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.message, 'Contact deleted successfully');

      // Verify contact is deleted from DB
      const found = await Contact.findById(contact._id);
      assert.equal(found, null);
    });

    it("6. One user cannot delete another user's contact (returns 404, contact preserved)", async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      const userTwoContact = await Contact.create({
        userId: userTwo._id,
        name: 'User Two Preserved',
        email: `${testPrefix}-u2-preserved@example.com`,
      });

      // User One attempts to delete User Two's contact
      const res = await fetch(`${baseUrl}/api/v1/contacts/${userTwoContact._id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${tokenOne}` },
      });

      assert.equal(res.status, 404);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.message, /not found/i);

      // Verify contact still exists in DB
      const preserved = await Contact.findById(userTwoContact._id);
      assert.ok(preserved);
      assert.equal(preserved.name, 'User Two Preserved');
    });

    it('8. Invalid contact IDs on DELETE return HTTP 400', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      const res = await fetch(`${baseUrl}/api/v1/contacts/malformed-id-123`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${tokenOne}` },
      });

      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.ok(data.errors.some((e) => e.path.includes('params.id')));
    });

    it('13. Deleting non-existent contact returns HTTP 404', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      const randomValidId = new mongoose.Types.ObjectId().toString();

      const res = await fetch(`${baseUrl}/api/v1/contacts/${randomValidId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${tokenOne}` },
      });

      assert.equal(res.status, 404);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.message, /not found/i);
    });
  });

  describe('6. Pagination, Search & Filtering (GET /api/v1/contacts)', () => {
    const pPrefix = `${testPrefix}-pg`;

    beforeEach(async () => {
      if (!isDbConnected) return;

      // Clean up contacts matching this sub-suite prefix
      await Contact.deleteMany({ email: new RegExp(`^${pPrefix}`) });

      // Seed 7 deterministic contacts for User One
      const fixtures = [
        { name: 'Alex Developer', email: `${pPrefix}-alex@gmail.com` },
        { name: 'Beatrice Stone', email: `${pPrefix}-beatrice@gmail.com` },
        { name: 'Carlos Ray', email: `${pPrefix}-carlos@work.org` },
        { name: 'Diana Prince', email: `${pPrefix}-diana@work.org` },
        { name: 'Evan Wright', email: `${pPrefix}-evan@notgmail.com` },
        { name: 'Special [Chars]+User.*', email: `${pPrefix}-special+chars@gmail.com` },
        { name: 'Subdomain Contact', email: `${pPrefix}-sub@corp.gmail.com` },
      ];

      for (const item of fixtures) {
        await Contact.create({
          userId: userOne._id,
          name: item.name,
          email: item.email,
        });
        await new Promise((r) => setTimeout(r, 2));
      }

      // Seed 2 contacts for User Two
      await Contact.create({
        userId: userTwo._id,
        name: 'Alex Imposter',
        email: `${pPrefix}-alex-imposter@gmail.com`,
      });
      await Contact.create({
        userId: userTwo._id,
        name: 'User Two Staff',
        email: `${pPrefix}-staff@work.org`,
      });
    });

    it('1. Default pagination values (page: 1, limit: 20)', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      const res = await fetch(`${baseUrl}/api/v1/contacts`, {
        headers: { Authorization: `Bearer ${tokenOne}` },
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.data.pagination.page, 1);
      assert.equal(data.data.pagination.limit, 20);
      assert.equal(data.data.pagination.total, 7);
      assert.equal(data.data.pagination.totalPages, 1);
      assert.equal(data.data.pagination.hasNextPage, false);
      assert.equal(data.data.pagination.hasPrevPage, false);
      assert.equal(data.data.contacts.length, 7);
    });

    it('2. Custom page and limit with stable tie-breaker sort', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      // Request page 2 with limit 3 (should return items 4, 5, 6)
      const res = await fetch(`${baseUrl}/api/v1/contacts?page=2&limit=3`, {
        headers: { Authorization: `Bearer ${tokenOne}` },
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.data.pagination.page, 2);
      assert.equal(data.data.pagination.limit, 3);
      assert.equal(data.data.pagination.total, 7);
      assert.equal(data.data.pagination.totalPages, 3);
      assert.equal(data.data.pagination.hasNextPage, true);
      assert.equal(data.data.pagination.hasPrevPage, true);
      assert.equal(data.data.contacts.length, 3);

      // Verify page 1 items are newer than page 2 items
      const resPage1 = await fetch(`${baseUrl}/api/v1/contacts?page=1&limit=3`, {
        headers: { Authorization: `Bearer ${tokenOne}` },
      });
      const dataPage1 = await resPage1.json();
      assert.equal(dataPage1.data.contacts.length, 3);

      const page1LastCreated = new Date(dataPage1.data.contacts[2].createdAt).getTime();
      const page2FirstCreated = new Date(data.data.contacts[0].createdAt).getTime();
      assert.ok(page1LastCreated >= page2FirstCreated);
    });

    it('3. Limit maximum enforcement: rejects limit > 100 with HTTP 400', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      const res = await fetch(`${baseUrl}/api/v1/contacts?limit=101`, {
        headers: { Authorization: `Bearer ${tokenOne}` },
      });

      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.message, /validation failed/i);
      assert.ok(data.errors.some((e) => e.path.includes('limit')));
    });

    it('4. Invalid, negative, zero and non-integer pagination values return HTTP 400', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      const invalidQueries = [
        'page=0',
        'page=-1',
        'page=1.5',
        'page=abc',
        'limit=0',
        'limit=-5',
        'limit=2.5',
        'limit=xyz',
      ];

      for (const query of invalidQueries) {
        const res = await fetch(`${baseUrl}/api/v1/contacts?${query}`, {
          headers: { Authorization: `Bearer ${tokenOne}` },
        });

        assert.equal(res.status, 400, `Expected 400 for query: ${query}`);
        const data = await res.json();
        assert.equal(data.success, false);
      }
    });

    it('Empty and whitespace-only pagination parameters return HTTP 400', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      const emptyAndWhitespaceQueries = [
        'page=',
        'page=%20%20',
        'limit=',
        'limit=%20%20',
        'page=&limit=',
        'page=%20%20&limit=%20%20',
        'page[]=1',
        'limit[]=20',
      ];

      for (const query of emptyAndWhitespaceQueries) {
        const res = await fetch(`${baseUrl}/api/v1/contacts?${query}`, {
          headers: { Authorization: `Bearer ${tokenOne}` },
        });

        assert.equal(res.status, 400, `Expected 400 for query: ${query}`);
        const data = await res.json();
        assert.equal(data.success, false);
        assert.match(data.message, /validation failed/i);
        assert.ok(data.errors && data.errors.length > 0);
      }
    });

    it('5. Correct total and totalPages calculations', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      // 7 contacts with limit=2 -> totalPages = Math.ceil(7 / 2) = 4
      const res = await fetch(`${baseUrl}/api/v1/contacts?page=1&limit=2`, {
        headers: { Authorization: `Bearer ${tokenOne}` },
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.data.pagination.total, 7);
      assert.equal(data.data.pagination.totalPages, 4);
      assert.equal(data.data.pagination.hasNextPage, true);
      assert.equal(data.data.pagination.hasPrevPage, false);
    });

    it('6. Empty pages and out-of-range pages return empty array with accurate metadata', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      // Request page 10 (beyond totalPages 3 for limit 3)
      const res = await fetch(`${baseUrl}/api/v1/contacts?page=10&limit=3`, {
        headers: { Authorization: `Bearer ${tokenOne}` },
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.deepEqual(data.data.contacts, []);
      assert.equal(data.data.count, 0);
      assert.equal(data.data.pagination.page, 10);
      assert.equal(data.data.pagination.limit, 3);
      assert.equal(data.data.pagination.total, 7);
      assert.equal(data.data.pagination.totalPages, 3);
      assert.equal(data.data.pagination.hasNextPage, false);
      assert.equal(data.data.pagination.hasPrevPage, true);
    });

    it('7. Name search filters case-insensitively', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      const res = await fetch(`${baseUrl}/api/v1/contacts?search=beatrice`, {
        headers: { Authorization: `Bearer ${tokenOne}` },
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.data.contacts.length, 1);
      assert.equal(data.data.contacts[0].name, 'Beatrice Stone');
      assert.equal(data.data.pagination.total, 1);
    });

    it('8. Email search filters case-insensitively', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      const res = await fetch(`${baseUrl}/api/v1/contacts?search=carlos@work`, {
        headers: { Authorization: `Bearer ${tokenOne}` },
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.data.contacts.length, 1);
      assert.equal(data.data.contacts[0].name, 'Carlos Ray');
    });

    it('9. Case-insensitive search on uppercase/lowercase query terms', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      const resUpper = await fetch(`${baseUrl}/api/v1/contacts?search=DIANA`, {
        headers: { Authorization: `Bearer ${tokenOne}` },
      });
      const dataUpper = await resUpper.json();
      assert.equal(dataUpper.data.contacts.length, 1);
      assert.equal(dataUpper.data.contacts[0].name, 'Diana Prince');

      const resLower = await fetch(`${baseUrl}/api/v1/contacts?search=diana`, {
        headers: { Authorization: `Bearer ${tokenOne}` },
      });
      const dataLower = await resLower.json();
      assert.equal(dataLower.data.contacts.length, 1);
      assert.equal(dataLower.data.contacts[0].name, 'Diana Prince');
    });

    it('10. Whitespace-only search is treated as no search', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      const res = await fetch(`${baseUrl}/api/v1/contacts?search=%20%20%20`, {
        headers: { Authorization: `Bearer ${tokenOne}` },
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.data.contacts.length, 7);
      assert.equal(data.data.pagination.total, 7);
    });

    it('11. Regex special characters are escaped and treated literally', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      const literalSearch = encodeURIComponent('Special [Chars]+User.*');
      const res = await fetch(`${baseUrl}/api/v1/contacts?search=${literalSearch}`, {
        headers: { Authorization: `Bearer ${tokenOne}` },
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.data.contacts.length, 1);
      assert.equal(data.data.contacts[0].name, 'Special [Chars]+User.*');
    });

    it('12. Exact email-domain matching does not match substrings or subdomains', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      const res = await fetch(`${baseUrl}/api/v1/contacts?emailDomain=gmail.com`, {
        headers: { Authorization: `Bearer ${tokenOne}` },
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.data.pagination.total, 3);
      assert.equal(data.data.contacts.length, 3);

      // Verify all matched contacts have emails strictly ending in @gmail.com
      for (const c of data.data.contacts) {
        assert.ok(c.email.endsWith('@gmail.com'));
      }

      // Verify notgmail.com and corp.gmail.com are NOT matched
      assert.ok(!data.data.contacts.some((c) => c.name === 'Evan Wright'));
      assert.ok(!data.data.contacts.some((c) => c.name === 'Subdomain Contact'));
    });

    it('13. Malformed email-domain filters return HTTP 400', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      const malformedDomains = [
        'invalid',
        '@gmail.com',
        'gmail..com',
        '.gmail.com',
        'gmail.c',
      ];

      for (const domain of malformedDomains) {
        const res = await fetch(`${baseUrl}/api/v1/contacts?emailDomain=${encodeURIComponent(domain)}`, {
          headers: { Authorization: `Bearer ${tokenOne}` },
        });

        assert.equal(res.status, 400, `Expected 400 for domain: ${domain}`);
        const data = await res.json();
        assert.equal(data.success, false);
      }
    });

    it('14. Search and email-domain filter combined', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      // Search 'Prince' on domain 'work.org' matches Diana Prince
      const res = await fetch(`${baseUrl}/api/v1/contacts?search=Prince&emailDomain=work.org`, {
        headers: { Authorization: `Bearer ${tokenOne}` },
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.data.pagination.total, 1);
      assert.equal(data.data.contacts.length, 1);
      assert.equal(data.data.contacts[0].name, 'Diana Prince');

      // Search 'Prince' on domain 'gmail.com' should yield 0 matches
      const resNone = await fetch(`${baseUrl}/api/v1/contacts?search=Prince&emailDomain=gmail.com`, {
        headers: { Authorization: `Bearer ${tokenOne}` },
      });
      const dataNone = await resNone.json();
      assert.equal(dataNone.data.pagination.total, 0);
      assert.deepEqual(dataNone.data.contacts, []);
    });

    it('15. Pagination applied after search and email-domain filtering', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      // Domain 'gmail.com' matches 3 contacts. Page 1 limit 2 should return 2.
      const resPage1 = await fetch(`${baseUrl}/api/v1/contacts?emailDomain=gmail.com&page=1&limit=2`, {
        headers: { Authorization: `Bearer ${tokenOne}` },
      });
      const dataPage1 = await resPage1.json();
      assert.equal(dataPage1.data.contacts.length, 2);
      assert.equal(dataPage1.data.pagination.total, 3);
      assert.equal(dataPage1.data.pagination.hasNextPage, true);
      assert.equal(dataPage1.data.pagination.hasPrevPage, false);

      // Page 2 limit 2 should return the remaining 1 contact
      const resPage2 = await fetch(`${baseUrl}/api/v1/contacts?emailDomain=gmail.com&page=2&limit=2`, {
        headers: { Authorization: `Bearer ${tokenOne}` },
      });
      const dataPage2 = await resPage2.json();
      assert.equal(dataPage2.data.contacts.length, 1);
      assert.equal(dataPage2.data.pagination.page, 2);
      assert.equal(dataPage2.data.pagination.hasNextPage, false);
      assert.equal(dataPage2.data.pagination.hasPrevPage, true);
    });

    it('16. Accurate count for combined filter', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      const res = await fetch(`${baseUrl}/api/v1/contacts?emailDomain=work.org`, {
        headers: { Authorization: `Bearer ${tokenOne}` },
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.data.pagination.total, 2);
      assert.equal(data.data.pagination.totalPages, 1);
    });

    it("17. Contacts belonging to another user never appear in search/filter results", async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      // Both users have contacts matching 'Alex' and domain 'gmail.com'
      const resOne = await fetch(`${baseUrl}/api/v1/contacts?search=Alex&emailDomain=gmail.com`, {
        headers: { Authorization: `Bearer ${tokenOne}` },
      });
      const dataOne = await resOne.json();
      assert.equal(dataOne.data.contacts.length, 1);
      assert.equal(dataOne.data.contacts[0].name, 'Alex Developer');

      const resTwo = await fetch(`${baseUrl}/api/v1/contacts?search=Alex&emailDomain=gmail.com`, {
        headers: { Authorization: `Bearer ${tokenTwo}` },
      });
      const dataTwo = await resTwo.json();
      assert.equal(dataTwo.data.contacts.length, 1);
      assert.equal(dataTwo.data.contacts[0].name, 'Alex Imposter');
    });

    it('18. Unauthenticated requests to list endpoint are rejected with HTTP 401', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      const res = await fetch(`${baseUrl}/api/v1/contacts?page=1&limit=10&search=Alex`);
      assert.equal(res.status, 401);
      const data = await res.json();
      assert.equal(data.success, false);
    });

    it('19. Cross-user pagination isolation: User A list and totals never include User B contacts or counts', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      // Clear seeded contacts for this test to establish exact known counts
      await Contact.deleteMany({ email: new RegExp(`^${pPrefix}`) });

      // Create exactly 3 contacts owned by User A
      const userAContacts = await Contact.create([
        { userId: userOne._id, name: 'User A One', email: `${pPrefix}-uA-1@example.com` },
        { userId: userOne._id, name: 'User A Two', email: `${pPrefix}-uA-2@example.com` },
        { userId: userOne._id, name: 'User A Three', email: `${pPrefix}-uA-3@example.com` },
      ]);
      const userAIds = new Set(userAContacts.map((c) => c._id.toString()));

      // Create exactly 10 contacts owned by User B
      const userBContactsData = Array.from({ length: 10 }, (_, i) => ({
        userId: userTwo._id,
        name: `User B Contact ${i + 1}`,
        email: `${pPrefix}-uB-${i + 1}@example.com`,
      }));
      const userBContacts = await Contact.create(userBContactsData);
      const userBIds = new Set(userBContacts.map((c) => c._id.toString()));

      // User A requests GET /api/v1/contacts?limit=2
      const res = await fetch(`${baseUrl}/api/v1/contacts?limit=2`, {
        headers: { Authorization: `Bearer ${tokenOne}` },
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.message, 'Contacts retrieved successfully');

      // Assert data.contacts contains exactly 2 contacts
      assert.equal(data.data.contacts.length, 2);
      assert.equal(data.data.count, 2);

      // Assert pagination totals strictly reflect User A's 3 contacts (totalPages = ceil(3 / 2) = 2)
      assert.equal(data.data.pagination.page, 1);
      assert.equal(data.data.pagination.limit, 2);
      assert.equal(data.data.pagination.total, 3);
      assert.equal(data.data.pagination.totalPages, 2);
      assert.equal(data.data.pagination.hasNextPage, true);
      assert.equal(data.data.pagination.hasPrevPage, false);

      // Assert all returned contacts belong exclusively to User A and never User B
      for (const returnedContact of data.data.contacts) {
        assert.ok(userAIds.has(returnedContact.id), `Expected contact ${returnedContact.id} to be User A contact`);
        assert.ok(!userBIds.has(returnedContact.id), `Expected contact ${returnedContact.id} NOT to be User B contact`);
        assert.ok(returnedContact.email.includes(`${pPrefix.toLowerCase()}-ua-`), 'Email must belong to User A prefix');
      }
    });
  });
});
