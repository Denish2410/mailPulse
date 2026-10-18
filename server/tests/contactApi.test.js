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
});
