import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config();

// Ensure deterministic test environment variables
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET =
  process.env.JWT_SECRET || 'deterministic_test_jwt_secret_min_32_characters!';
process.env.JWT_EXPIRES_IN = '15m';

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';

import app from '../src/app.js';
import User from '../src/models/User.js';
import Contact from '../src/models/Contact.js';
import Campaign from '../src/models/Campaign.js';
import { connectDB } from '../src/config/db.js';
import { signAccessToken } from '../src/utils/token.js';
import { getAuthConfig } from '../src/config/auth.js';
import { hashPassword } from '../src/services/password.service.js';

describe('Campaign CRUD APIs (/api/v1/campaigns)', () => {
  let server;
  let baseUrl;
  let isDbConnected = false;
  const testPrefix = `campaignapitest-${Date.now()}-${Math.floor(Math.random() * 10000)}`;

  let userOne;
  let tokenOne;
  let userTwo;
  let tokenTwo;

  // Contacts created for User One
  let contactOneA;
  let contactOneB;

  // Contact created for User Two
  let contactTwoA;

  const assertCampaignShape = (campaign) => {
    assert.ok(campaign);
    assert.equal(typeof campaign.id, 'string');
    assert.ok(mongoose.isValidObjectId(campaign.id));
    assert.equal(typeof campaign.name, 'string');
    assert.equal(typeof campaign.subject, 'string');
    assert.equal(typeof campaign.textContent, 'string');
    assert.equal(typeof campaign.htmlContent, 'string');
    assert.equal(campaign.status, 'draft');
    assert.ok(Array.isArray(campaign.recipientIds));
    assert.equal(typeof campaign.recipientsCount, 'number');
    assert.equal(campaign.recipientsCount, campaign.recipientIds.length);
    assert.ok(campaign.createdAt);
    assert.ok(campaign.updatedAt);

    // CRITICAL: Ensure internal database fields and owner identity are never leaked
    assert.equal(campaign._id, undefined, '_id must not be exposed');
    assert.equal(campaign.__v, undefined, '__v must not be exposed');
    assert.equal(campaign.userId, undefined, 'userId must not be exposed');
  };

  before(async () => {
    try {
      await connectDB();
      isDbConnected = true;
      await User.init();
      await Contact.init();
      await Campaign.init();
    } catch (err) {
      console.warn(`[Campaign API Tests] MongoDB unavailable: ${err.message}`);
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

      // Seed contacts for userOne
      contactOneA = await Contact.create({
        userId: userOne._id,
        name: 'Contact One A',
        email: `${testPrefix}-c1a@example.com`,
      });

      contactOneB = await Contact.create({
        userId: userOne._id,
        name: 'Contact One B',
        email: `${testPrefix}-c1b@example.com`,
      });

      // Seed contact for userTwo
      contactTwoA = await Contact.create({
        userId: userTwo._id,
        name: 'Contact Two A',
        email: `${testPrefix}-c2a@example.com`,
      });
    }
  });

  beforeEach(async () => {
    if (isDbConnected) {
      await Campaign.deleteMany({ userId: { $in: [userOne._id, userTwo._id] } });
    }
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    if (isDbConnected) {
      await Campaign.deleteMany({ userId: { $in: [userOne._id, userTwo._id] } });
      await Contact.deleteMany({ userId: { $in: [userOne._id, userTwo._id] } });
      await User.deleteMany({ _id: { $in: [userOne._id, userTwo._id] } });
      await mongoose.disconnect();
    }
  });

  describe('1. Authentication Guard', () => {
    it('Unauthenticated requests are rejected with HTTP 401 across all campaign endpoints', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      const dummyId = new mongoose.Types.ObjectId().toString();

      // POST /campaigns without auth
      const postRes = await fetch(`${baseUrl}/api/v1/campaigns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Unauth Campaign', subject: 'Subject' }),
      });
      assert.equal(postRes.status, 401);
      const postData = await postRes.json();
      assert.equal(postData.success, false);

      // GET /campaigns without auth
      const getListRes = await fetch(`${baseUrl}/api/v1/campaigns`);
      assert.equal(getListRes.status, 401);

      // GET /campaigns/:id without auth
      const getOneRes = await fetch(`${baseUrl}/api/v1/campaigns/${dummyId}`);
      assert.equal(getOneRes.status, 401);

      // PATCH /campaigns/:id without auth
      const patchRes = await fetch(`${baseUrl}/api/v1/campaigns/${dummyId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated' }),
      });
      assert.equal(patchRes.status, 401);

      // DELETE /campaigns/:id without auth
      const deleteRes = await fetch(`${baseUrl}/api/v1/campaigns/${dummyId}`, {
        method: 'DELETE',
      });
      assert.equal(deleteRes.status, 401);

      // Request with invalid token string
      const invalidTokenRes = await fetch(`${baseUrl}/api/v1/campaigns`, {
        headers: { Authorization: 'Bearer invalid.jwt.token' },
      });
      assert.equal(invalidTokenRes.status, 401);
    });

    it('Expired JWT access token on campaign endpoint returns HTTP 401', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      const config = getAuthConfig();
      const expiredToken = signAccessToken(userOne, { ...config, expiresIn: '1ms' });
      await new Promise((resolve) => setTimeout(resolve, 50));

      const res = await fetch(`${baseUrl}/api/v1/campaigns`, {
        headers: { Authorization: `Bearer ${expiredToken}` },
      });

      assert.equal(res.status, 401);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.equal(data.message, 'Authentication required. Invalid or missing authorization token.');
    });

    it('Invalid JWT signature on campaign endpoint returns HTTP 401', async (t) => {
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

      const res = await fetch(`${baseUrl}/api/v1/campaigns`, {
        headers: { Authorization: `Bearer ${invalidSigToken}` },
      });

      assert.equal(res.status, 401);
      const data = await res.json();
      assert.equal(data.success, false);
    });

    it('Correctly signed token with non-ObjectId userId returns HTTP 401 from controller guard', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      const config = getAuthConfig();
      const malformedIdToken = signAccessToken('not-an-object-id', config);

      const res = await fetch(`${baseUrl}/api/v1/campaigns`, {
        headers: { Authorization: `Bearer ${malformedIdToken}` },
      });

      assert.equal(res.status, 401);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.equal(data.message, 'Authentication required. Invalid user identity.');
    });
  });

  describe('2. POST /api/v1/campaigns (Create Campaign Draft)', () => {
    it('An authenticated user can create a valid campaign draft with defaults', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      const res = await fetch(`${baseUrl}/api/v1/campaigns`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenOne}`,
        },
        body: JSON.stringify({
          name: '  Fall Promotional Campaign  ',
          subject: '  Fall Savings Are Here!  ',
        }),
      });

      assert.equal(res.status, 201);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.message, 'Campaign draft created successfully');

      const c = data.data.campaign;
      assertCampaignShape(c);
      assert.equal(c.name, 'Fall Promotional Campaign');
      assert.equal(c.subject, 'Fall Savings Are Here!');
      assert.equal(c.textContent, '');
      assert.equal(c.htmlContent, '');
      assert.equal(c.status, 'draft');
      assert.deepEqual(c.recipientIds, []);
      assert.equal(c.recipientsCount, 0);

      // Verify persisted in DB with correct owner
      const inDb = await Campaign.findById(c.id);
      assert.ok(inDb);
      assert.equal(inDb.userId.toString(), userOne._id.toString());
    });

    it('Creates campaign with textContent, htmlContent, and verified recipientIds', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      const res = await fetch(`${baseUrl}/api/v1/campaigns`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenOne}`,
        },
        body: JSON.stringify({
          name: 'Newsletter #42',
          subject: 'Monthly Digest',
          textContent: 'Hello, read our updates.',
          htmlContent: '<h1>Hello</h1><p>Read our updates.</p>',
          recipientIds: [contactOneA._id.toString(), contactOneB._id.toString()],
        }),
      });

      assert.equal(res.status, 201);
      const data = await res.json();
      const c = data.data.campaign;
      assertCampaignShape(c);
      assert.equal(c.textContent, 'Hello, read our updates.');
      assert.equal(c.htmlContent, '<h1>Hello</h1><p>Read our updates.</p>');
      assert.equal(c.recipientIds.length, 2);
      assert.equal(c.recipientsCount, 2);
      assert.ok(c.recipientIds.includes(contactOneA._id.toString()));
      assert.ok(c.recipientIds.includes(contactOneB._id.toString()));
    });

    it('Deduplicates duplicate recipient IDs in request payload transparently', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      const res = await fetch(`${baseUrl}/api/v1/campaigns`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenOne}`,
        },
        body: JSON.stringify({
          name: 'Deduplication Test',
          subject: 'Subject',
          recipientIds: [
            contactOneA._id.toString(),
            contactOneA._id.toString(),
            contactOneB._id.toString(),
            contactOneA._id.toString(),
          ],
        }),
      });

      assert.equal(res.status, 201);
      const data = await res.json();
      const c = data.data.campaign;
      assert.equal(c.recipientIds.length, 2);
      assert.equal(c.recipientsCount, 2);
    });

    it('Rejects attempt to select a recipient ID belonging to another user with HTTP 400', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      // User One tries to include contactTwoA (owned by User Two)
      const res = await fetch(`${baseUrl}/api/v1/campaigns`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenOne}`,
        },
        body: JSON.stringify({
          name: 'Cross-Tenant Injection Attempt',
          subject: 'Subject',
          recipientIds: [contactOneA._id.toString(), contactTwoA._id.toString()],
        }),
      });

      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.message, /invalid or not owned by you/i);
    });

    it('Rejects attempt to select a nonexistent valid ObjectId recipient with HTTP 400', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      const nonExistentContactId = new mongoose.Types.ObjectId().toString();

      const res = await fetch(`${baseUrl}/api/v1/campaigns`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenOne}`,
        },
        body: JSON.stringify({
          name: 'Nonexistent Recipient Campaign',
          subject: 'Subject',
          recipientIds: [nonExistentContactId],
        }),
      });

      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.message, /invalid or not owned by you/i);
    });

    it('Rejects request containing protected or unknown fields (_id, userId, status) with HTTP 400', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      const res = await fetch(`${baseUrl}/api/v1/campaigns`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenOne}`,
        },
        body: JSON.stringify({
          name: 'Hacked Campaign',
          subject: 'Subject',
          userId: userTwo._id.toString(),
          status: 'sent',
          _id: new mongoose.Types.ObjectId().toString(),
        }),
      });

      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.message, /validation failed/i);
    });

    it('Rejects invalid campaign name lengths and whitespace-only names with HTTP 400', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      // Too short name (< 2)
      const shortRes = await fetch(`${baseUrl}/api/v1/campaigns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenOne}` },
        body: JSON.stringify({ name: 'A', subject: 'Subject' }),
      });
      assert.equal(shortRes.status, 400);

      // Whitespace-only name
      const wsRes = await fetch(`${baseUrl}/api/v1/campaigns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenOne}` },
        body: JSON.stringify({ name: '    ', subject: 'Subject' }),
      });
      assert.equal(wsRes.status, 400);

      // Too long name (> 120)
      const longRes = await fetch(`${baseUrl}/api/v1/campaigns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenOne}` },
        body: JSON.stringify({ name: 'N'.repeat(121), subject: 'Subject' }),
      });
      assert.equal(longRes.status, 400);
    });

    it('Rejects invalid subject lengths and whitespace-only subjects with HTTP 400', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      // Whitespace-only subject
      const wsRes = await fetch(`${baseUrl}/api/v1/campaigns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenOne}` },
        body: JSON.stringify({ name: 'Valid Name', subject: '    ' }),
      });
      assert.equal(wsRes.status, 400);

      // Too long subject (> 200)
      const longRes = await fetch(`${baseUrl}/api/v1/campaigns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenOne}` },
        body: JSON.stringify({ name: 'Valid Name', subject: 'S'.repeat(201) }),
      });
      assert.equal(longRes.status, 400);
    });

    it('Rejects malformed recipient ID format with HTTP 400', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      const res = await fetch(`${baseUrl}/api/v1/campaigns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenOne}` },
        body: JSON.stringify({
          name: 'Valid Name',
          subject: 'Valid Subject',
          recipientIds: ['not-a-valid-mongo-id'],
        }),
      });

      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.success, false);
    });
  });

  describe('3. GET /api/v1/campaigns (List Campaigns)', () => {
    beforeEach(async () => {
      if (!isDbConnected) return;

      // Seed 5 campaigns for User One
      for (let i = 1; i <= 5; i++) {
        await Campaign.create({
          userId: userOne._id,
          name: `User One Campaign ${i}`,
          subject: i % 2 === 0 ? `Special Offer ${i}` : `General News ${i}`,
          textContent: `Body ${i}`,
        });
        await new Promise((r) => setTimeout(r, 2));
      }

      // Seed 2 campaigns for User Two
      for (let i = 1; i <= 2; i++) {
        await Campaign.create({
          userId: userTwo._id,
          name: `User Two Campaign ${i}`,
          subject: `User Two Subject ${i}`,
        });
      }
    });

    it('Returns authenticated user campaigns with default pagination (limit 20, page 1) and stable sorting', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      const res = await fetch(`${baseUrl}/api/v1/campaigns`, {
        headers: { Authorization: `Bearer ${tokenOne}` },
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.message, 'Campaigns retrieved successfully');
      assert.equal(data.data.campaigns.length, 5);
      assert.equal(data.data.count, 5);
      assert.equal(data.data.pagination.total, 5);
      assert.equal(data.data.pagination.totalPages, 1);
      assert.equal(data.data.pagination.page, 1);
      assert.equal(data.data.pagination.limit, 20);

      // All returned campaigns must belong to User One
      for (const camp of data.data.campaigns) {
        assertCampaignShape(camp);
        assert.ok(camp.name.startsWith('User One Campaign'));
      }

      // Verify newest-first order
      const firstDate = new Date(data.data.campaigns[0].createdAt).getTime();
      const lastDate = new Date(data.data.campaigns[4].createdAt).getTime();
      assert.ok(firstDate >= lastDate);
    });

    it('Enforces cross-tenant isolation: User A list never exposes User B campaigns or count totals', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      const resUserTwo = await fetch(`${baseUrl}/api/v1/campaigns`, {
        headers: { Authorization: `Bearer ${tokenTwo}` },
      });

      assert.equal(resUserTwo.status, 200);
      const dataTwo = await resUserTwo.json();
      assert.equal(dataTwo.data.campaigns.length, 2);
      assert.equal(dataTwo.data.pagination.total, 2);

      for (const camp of dataTwo.data.campaigns) {
        assert.ok(camp.name.startsWith('User Two Campaign'));
      }
    });

    it('Custom pagination parameters (page=2, limit=2) correctly paginate results', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      const res = await fetch(`${baseUrl}/api/v1/campaigns?page=2&limit=2`, {
        headers: { Authorization: `Bearer ${tokenOne}` },
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.data.campaigns.length, 2);
      assert.equal(data.data.pagination.page, 2);
      assert.equal(data.data.pagination.limit, 2);
      assert.equal(data.data.pagination.total, 5);
      assert.equal(data.data.pagination.totalPages, 3);
      assert.equal(data.data.pagination.hasNextPage, true);
      assert.equal(data.data.pagination.hasPrevPage, true);
    });

    it('Search filters case-insensitively by campaign name or subject', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      // Search by subject term "special offer"
      const resSubject = await fetch(`${baseUrl}/api/v1/campaigns?search=special%20offer`, {
        headers: { Authorization: `Bearer ${tokenOne}` },
      });
      assert.equal(resSubject.status, 200);
      const dataSubject = await resSubject.json();
      assert.equal(dataSubject.data.campaigns.length, 2);
      assert.ok(dataSubject.data.campaigns.every((c) => c.subject.includes('Special Offer')));

      // Search by name term "campaign 5"
      const resName = await fetch(`${baseUrl}/api/v1/campaigns?search=campaign%205`, {
        headers: { Authorization: `Bearer ${tokenOne}` },
      });
      assert.equal(resName.status, 200);
      const dataName = await resName.json();
      assert.equal(dataName.data.campaigns.length, 1);
      assert.equal(dataName.data.campaigns[0].name, 'User One Campaign 5');
    });

    it('Rejects invalid pagination values (page=0, limit=101, non-numeric) with HTTP 400', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      const resLimitTooHigh = await fetch(`${baseUrl}/api/v1/campaigns?limit=101`, {
        headers: { Authorization: `Bearer ${tokenOne}` },
      });
      assert.equal(resLimitTooHigh.status, 400);

      const resPageZero = await fetch(`${baseUrl}/api/v1/campaigns?page=0`, {
        headers: { Authorization: `Bearer ${tokenOne}` },
      });
      assert.equal(resPageZero.status, 400);

      const resStringPage = await fetch(`${baseUrl}/api/v1/campaigns?page=abc`, {
        headers: { Authorization: `Bearer ${tokenOne}` },
      });
      assert.equal(resStringPage.status, 400);
    });
  });

  describe('4. GET /api/v1/campaigns/:id (Get Single Campaign)', () => {
    it('An authenticated user can retrieve their own campaign by ID', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      const campaign = await Campaign.create({
        userId: userOne._id,
        name: 'Single Campaign Retrieval',
        subject: 'Single Subject',
        textContent: 'Detailed plain text',
        htmlContent: '<p>Detailed HTML</p>',
        recipientIds: [contactOneA._id],
      });

      const res = await fetch(`${baseUrl}/api/v1/campaigns/${campaign._id}`, {
        headers: { Authorization: `Bearer ${tokenOne}` },
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.message, 'Campaign retrieved successfully');

      const c = data.data.campaign;
      assertCampaignShape(c);
      assert.equal(c.id, campaign._id.toString());
      assert.equal(c.name, 'Single Campaign Retrieval');
      assert.equal(c.subject, 'Single Subject');
      assert.equal(c.textContent, 'Detailed plain text');
      assert.equal(c.htmlContent, '<p>Detailed HTML</p>');
      assert.equal(c.recipientIds.length, 1);
      assert.equal(c.recipientsCount, 1);
      assert.equal(c.recipientIds[0], contactOneA._id.toString());
    });

    it('Invalid campaign ID format returns HTTP 400', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      const res = await fetch(`${baseUrl}/api/v1/campaigns/not-a-valid-id`, {
        headers: { Authorization: `Bearer ${tokenOne}` },
      });

      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.message, /validation failed/i);
    });

    it('Non-existent valid ObjectId returns HTTP 404', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      const nonExistentId = new mongoose.Types.ObjectId().toString();

      const res = await fetch(`${baseUrl}/api/v1/campaigns/${nonExistentId}`, {
        headers: { Authorization: `Bearer ${tokenOne}` },
      });

      assert.equal(res.status, 404);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.equal(data.message, 'Campaign not found.');
    });

    it('One user cannot retrieve another user campaign by ID (returns HTTP 404)', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      // Create campaign owned by User Two
      const userTwoCampaign = await Campaign.create({
        userId: userTwo._id,
        name: 'Secret User Two Campaign',
        subject: 'Confidential',
      });

      // User One attempts to read User Two's campaign
      const res = await fetch(`${baseUrl}/api/v1/campaigns/${userTwoCampaign._id}`, {
        headers: { Authorization: `Bearer ${tokenOne}` },
      });

      assert.equal(res.status, 404);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.equal(data.message, 'Campaign not found.');
    });
  });

  describe('5. PATCH /api/v1/campaigns/:id (Update Campaign Draft)', () => {
    it('An authenticated user can update name and subject of their draft', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      const campaign = await Campaign.create({
        userId: userOne._id,
        name: 'Original Name',
        subject: 'Original Subject',
        textContent: 'Original Content',
        recipientIds: [contactOneA._id],
      });

      const res = await fetch(`${baseUrl}/api/v1/campaigns/${campaign._id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenOne}`,
        },
        body: JSON.stringify({
          name: '  Updated Name  ',
          subject: '  Updated Subject  ',
        }),
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.message, 'Campaign updated successfully');

      const c = data.data.campaign;
      assertCampaignShape(c);
      assert.equal(c.name, 'Updated Name');
      assert.equal(c.subject, 'Updated Subject');
      // Preserved fields
      assert.equal(c.textContent, 'Original Content');
      assert.equal(c.recipientIds.length, 1);
      assert.equal(c.recipientIds[0], contactOneA._id.toString());
    });

    it('Permits explicit empty string to clear textContent and htmlContent in a draft', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      const campaign = await Campaign.create({
        userId: userOne._id,
        name: 'Content Clear Test',
        subject: 'Subject',
        textContent: 'Some text',
        htmlContent: '<p>Some html</p>',
      });

      const res = await fetch(`${baseUrl}/api/v1/campaigns/${campaign._id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenOne}`,
        },
        body: JSON.stringify({
          textContent: '',
          htmlContent: '',
        }),
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      const c = data.data.campaign;
      assert.equal(c.textContent, '');
      assert.equal(c.htmlContent, '');
    });

    it('Permits explicit empty array to clear recipientIds in a draft', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      const campaign = await Campaign.create({
        userId: userOne._id,
        name: 'Recipient Clear Test',
        subject: 'Subject',
        recipientIds: [contactOneA._id, contactOneB._id],
      });

      const res = await fetch(`${baseUrl}/api/v1/campaigns/${campaign._id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenOne}`,
        },
        body: JSON.stringify({
          recipientIds: [],
        }),
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      const c = data.data.campaign;
      assert.deepEqual(c.recipientIds, []);
      assert.equal(c.recipientsCount, 0);
    });

    it('Updates recipientIds with deduplication and ownership verification', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      const campaign = await Campaign.create({
        userId: userOne._id,
        name: 'Recipient Update Test',
        subject: 'Subject',
        recipientIds: [contactOneA._id],
      });

      const res = await fetch(`${baseUrl}/api/v1/campaigns/${campaign._id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenOne}`,
        },
        body: JSON.stringify({
          recipientIds: [
            contactOneB._id.toString(),
            contactOneA._id.toString(),
            contactOneB._id.toString(), // Duplicate
          ],
        }),
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      const c = data.data.campaign;
      assert.equal(c.recipientIds.length, 2);
      assert.equal(c.recipientsCount, 2);
    });

    it('Rejects update attempting to include another user contact ID with HTTP 400', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      const campaign = await Campaign.create({
        userId: userOne._id,
        name: 'Clean Campaign',
        subject: 'Subject',
        recipientIds: [contactOneA._id],
      });

      const res = await fetch(`${baseUrl}/api/v1/campaigns/${campaign._id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenOne}`,
        },
        body: JSON.stringify({
          recipientIds: [contactTwoA._id.toString()],
        }),
      });

      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.message, /invalid or not owned by you/i);

      // Verify original recipients remained intact
      const preserved = await Campaign.findById(campaign._id);
      assert.equal(preserved.recipientIds.length, 1);
      assert.equal(preserved.recipientIds[0].toString(), contactOneA._id.toString());
    });

    it('Rejects empty PATCH body with HTTP 400', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      const campaign = await Campaign.create({
        userId: userOne._id,
        name: 'Target Campaign',
        subject: 'Subject',
      });

      const res = await fetch(`${baseUrl}/api/v1/campaigns/${campaign._id}`, {
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
      assert.match(data.message, /validation failed/i);
      assert.ok(data.errors.some((e) => e.message.includes('At least one field')));
    });

    it('Rejects attempt to modify protected fields (_id, userId, status) during PATCH with HTTP 400', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      const campaign = await Campaign.create({
        userId: userOne._id,
        name: 'Target Campaign',
        subject: 'Subject',
      });

      const res = await fetch(`${baseUrl}/api/v1/campaigns/${campaign._id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenOne}`,
        },
        body: JSON.stringify({
          status: 'sent',
        }),
      });

      assert.equal(res.status, 400);
    });

    it('One user cannot update another user campaign (returns HTTP 404)', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      const userTwoCampaign = await Campaign.create({
        userId: userTwo._id,
        name: 'User Two Original Name',
        subject: 'Subject',
      });

      const res = await fetch(`${baseUrl}/api/v1/campaigns/${userTwoCampaign._id}`, {
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

      // Verify User Two's campaign was not modified
      const preserved = await Campaign.findById(userTwoCampaign._id);
      assert.equal(preserved.name, 'User Two Original Name');
    });
  });

  describe('6. DELETE /api/v1/campaigns/:id (Delete Campaign Draft)', () => {
    it('An authenticated user can delete their campaign draft', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      const campaign = await Campaign.create({
        userId: userOne._id,
        name: 'To Be Deleted',
        subject: 'Subject',
      });

      const res = await fetch(`${baseUrl}/api/v1/campaigns/${campaign._id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${tokenOne}` },
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.message, 'Campaign deleted successfully');

      // Verify removed from database
      const inDb = await Campaign.findById(campaign._id);
      assert.equal(inDb, null);
    });

    it('Deleting non-existent campaign returns HTTP 404', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      const randomValidId = new mongoose.Types.ObjectId().toString();

      const res = await fetch(`${baseUrl}/api/v1/campaigns/${randomValidId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${tokenOne}` },
      });

      assert.equal(res.status, 404);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.equal(data.message, 'Campaign not found.');
    });

    it('One user cannot delete another user campaign (returns HTTP 404, preserving campaign)', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      const userTwoCampaign = await Campaign.create({
        userId: userTwo._id,
        name: 'Preserved Campaign',
        subject: 'Subject',
      });

      // User One tries to delete User Two's campaign
      const res = await fetch(`${baseUrl}/api/v1/campaigns/${userTwoCampaign._id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${tokenOne}` },
      });

      assert.equal(res.status, 404);

      // Verify campaign still exists in DB
      const preserved = await Campaign.findById(userTwoCampaign._id);
      assert.ok(preserved);
      assert.equal(preserved.name, 'Preserved Campaign');
    });
  });

  describe('7. Contact Deletion Retention on Campaign Drafts', () => {
    it('Deleting a Contact does not cascade or alter the stored recipient IDs in draft campaigns', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      // Create a transient contact for User One
      const tempContact = await Contact.create({
        userId: userOne._id,
        name: 'Temporary Contact',
        email: `${testPrefix}-temp@example.com`,
      });

      // Create a campaign with this contact
      const campaign = await Campaign.create({
        userId: userOne._id,
        name: 'Draft With Temp Contact',
        subject: 'Subject',
        recipientIds: [tempContact._id],
      });

      // Verify campaign has 1 recipient initially
      const initialFetch = await fetch(`${baseUrl}/api/v1/campaigns/${campaign._id}`, {
        headers: { Authorization: `Bearer ${tokenOne}` },
      });
      const initialData = await initialFetch.json();
      assert.equal(initialData.data.campaign.recipientIds.length, 1);
      assert.equal(initialData.data.campaign.recipientIds[0], tempContact._id.toString());

      // Delete the contact
      await Contact.deleteOne({ _id: tempContact._id });

      // Re-fetch the campaign: contact ID remains preserved in draft's recipientIds
      const postDeleteFetch = await fetch(`${baseUrl}/api/v1/campaigns/${campaign._id}`, {
        headers: { Authorization: `Bearer ${tokenOne}` },
      });
      const postDeleteData = await postDeleteFetch.json();
      assert.equal(postDeleteData.data.campaign.recipientIds.length, 1);
      assert.equal(postDeleteData.data.campaign.recipientIds[0], tempContact._id.toString());
      assert.equal(postDeleteData.data.campaign.recipientsCount, 1);
    });

    it('Updating unrelated field on draft referencing a deleted contact succeeds without recipient re-validation error', async (t) => {
      if (!isDbConnected) return t.skip('MongoDB required');

      // 1. Create contact for User One
      const tempContact = await Contact.create({
        userId: userOne._id,
        name: 'Contact To Be Deleted',
        email: `${testPrefix}-patch-after-del@example.com`,
      });

      // 2. Create Campaign draft referencing that Contact
      const campaign = await Campaign.create({
        userId: userOne._id,
        name: 'Original Campaign Name Before Deletion',
        subject: 'Original Subject',
        recipientIds: [tempContact._id],
      });

      // 3. Delete the Contact
      await Contact.deleteOne({ _id: tempContact._id });

      // 4. PATCH the Campaign with only a valid name field, omitting recipientIds
      const patchRes = await fetch(`${baseUrl}/api/v1/campaigns/${campaign._id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenOne}`,
        },
        body: JSON.stringify({
          name: 'Updated Campaign Name After Contact Deletion',
        }),
      });

      // 5. Assert HTTP 200, name updated, recipient ID retained, recipientsCount consistent
      assert.equal(patchRes.status, 200);
      const patchData = await patchRes.json();
      assert.equal(patchData.success, true);
      assert.equal(patchData.message, 'Campaign updated successfully');

      const c = patchData.data.campaign;
      assert.equal(c.name, 'Updated Campaign Name After Contact Deletion');
      assert.equal(c.recipientIds.length, 1);
      assert.equal(c.recipientIds[0], tempContact._id.toString());
      assert.equal(c.recipientsCount, 1);

      // Verify DB persistence
      const inDb = await Campaign.findById(campaign._id);
      assert.ok(inDb);
      assert.equal(inDb.name, 'Updated Campaign Name After Contact Deletion');
      assert.equal(inDb.recipientIds.length, 1);
      assert.equal(inDb.recipientIds[0].toString(), tempContact._id.toString());
    });
  });

  // ==========================================
  // Campaign Send-Readiness API (GET /:id/readiness)
  // ==========================================
  describe('GET /api/v1/campaigns/:id/readiness (Campaign Send-Readiness Evaluation)', () => {
    it('1. Returns isReady: true for a valid draft with non-empty content and an owned contact', async () => {
      const campaign = await Campaign.create({
        userId: userOne._id,
        name: 'Ready Campaign',
        subject: 'Product Announcement',
        textContent: 'Hello, here is your product announcement.',
        htmlContent: '<p>Hello, here is your product announcement.</p>',
        status: 'draft',
        recipientIds: [contactOneA._id],
      });

      const res = await fetch(`${baseUrl}/api/v1/campaigns/${campaign._id}/readiness`, {
        headers: { Authorization: `Bearer ${tokenOne}` },
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.data.isReady, true);
      assert.deepEqual(data.data.issues, []);

      const summary = data.data.summary;
      assert.equal(summary.totalRecipients, 1);
      assert.equal(summary.eligibleRecipientsCount, 1);
      assert.equal(summary.missingRecipientsCount, 0);
      assert.equal(summary.hasTextContent, true);
      assert.equal(summary.hasHtmlContent, true);
      assert.equal(summary.status, 'draft');
      assert.equal(summary.eligibleRecipients[0].id, contactOneA._id.toString());
      assert.equal(summary.eligibleRecipients[0].name, contactOneA.name);
      assert.equal(summary.eligibleRecipients[0].email, contactOneA.email);
    });

    it('2. Returns isReady: false when both textContent and htmlContent are empty', async () => {
      const campaign = await Campaign.create({
        userId: userOne._id,
        name: 'Empty Content Campaign',
        subject: 'No Content Here',
        textContent: '',
        htmlContent: '',
        status: 'draft',
        recipientIds: [contactOneA._id],
      });

      const res = await fetch(`${baseUrl}/api/v1/campaigns/${campaign._id}/readiness`, {
        headers: { Authorization: `Bearer ${tokenOne}` },
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.data.isReady, false);
      assert.ok(data.data.issues.includes('Campaign must have non-empty text content or HTML content.'));
      assert.equal(data.data.summary.hasTextContent, false);
      assert.equal(data.data.summary.hasHtmlContent, false);
    });

    it('3. Treats whitespace-only content as empty and returns isReady: false', async () => {
      const campaign = await Campaign.create({
        userId: userOne._id,
        name: 'Whitespace Content Campaign',
        subject: 'Whitespace Only',
        textContent: '   \n\t  ',
        htmlContent: '   ',
        status: 'draft',
        recipientIds: [contactOneA._id],
      });

      const res = await fetch(`${baseUrl}/api/v1/campaigns/${campaign._id}/readiness`, {
        headers: { Authorization: `Bearer ${tokenOne}` },
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.data.isReady, false);
      assert.ok(data.data.issues.includes('Campaign must have non-empty text content or HTML content.'));
      assert.equal(data.data.summary.hasTextContent, false);
      assert.equal(data.data.summary.hasHtmlContent, false);
    });

    it('4. Returns isReady: false when recipientIds is empty', async () => {
      const campaign = await Campaign.create({
        userId: userOne._id,
        name: 'No Recipients Campaign',
        subject: 'Subject Line',
        textContent: 'Valid text content',
        status: 'draft',
        recipientIds: [],
      });

      const res = await fetch(`${baseUrl}/api/v1/campaigns/${campaign._id}/readiness`, {
        headers: { Authorization: `Bearer ${tokenOne}` },
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.data.isReady, false);
      assert.ok(data.data.issues.includes('Campaign must have at least one eligible recipient.'));
      assert.equal(data.data.summary.totalRecipients, 0);
      assert.equal(data.data.summary.eligibleRecipientsCount, 0);
      assert.equal(data.data.summary.missingRecipientsCount, 0);
      assert.deepEqual(data.data.summary.eligibleRecipients, []);
    });

    it('5. Counts deleted selected contact as missing and does not return as eligible', async () => {
      // Create contact and campaign, then delete contact
      const tempContact = await Contact.create({
        userId: userOne._id,
        name: 'Soon Deleted',
        email: `${testPrefix}-readiness-del@example.com`,
      });

      const campaign = await Campaign.create({
        userId: userOne._id,
        name: 'Deleted Recipient Campaign',
        subject: 'Subject Line',
        textContent: 'Valid text content',
        status: 'draft',
        recipientIds: [tempContact._id, contactOneA._id],
      });

      await Contact.deleteOne({ _id: tempContact._id });

      const res = await fetch(`${baseUrl}/api/v1/campaigns/${campaign._id}/readiness`, {
        headers: { Authorization: `Bearer ${tokenOne}` },
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      // Because contactOneA is still eligible, isReady is true
      assert.equal(data.data.isReady, true);
      assert.equal(data.data.summary.totalRecipients, 2);
      assert.equal(data.data.summary.eligibleRecipientsCount, 1);
      assert.equal(data.data.summary.missingRecipientsCount, 1);
      assert.equal(data.data.summary.eligibleRecipients[0].id, contactOneA._id.toString());
    });

    it('6. Does not return cross-tenant contact ID as eligible and prevents data disclosure', async () => {
      // User Two owns contactTwoA; User One creates campaign referencing contactTwoA directly in DB
      const campaign = await Campaign.create({
        userId: userOne._id,
        name: 'Cross Tenant Recipient Campaign',
        subject: 'Subject Line',
        textContent: 'Valid text content',
        status: 'draft',
        recipientIds: [contactTwoA._id],
      });

      const res = await fetch(`${baseUrl}/api/v1/campaigns/${campaign._id}/readiness`, {
        headers: { Authorization: `Bearer ${tokenOne}` },
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.data.isReady, false);
      assert.ok(data.data.issues.includes('Campaign must have at least one eligible recipient.'));
      assert.equal(data.data.summary.totalRecipients, 1);
      assert.equal(data.data.summary.eligibleRecipientsCount, 0);
      assert.equal(data.data.summary.missingRecipientsCount, 1);
      // ContactTwoA info must NEVER be disclosed in eligibleRecipients
      assert.deepEqual(data.data.summary.eligibleRecipients, []);
    });

    it('7. Returns 404 when attempting to access another user’s campaign', async () => {
      // User One creates campaign; User Two attempts to check readiness
      const campaign = await Campaign.create({
        userId: userOne._id,
        name: 'User One Campaign',
        subject: 'Private Subject',
        textContent: 'Private text',
        status: 'draft',
        recipientIds: [contactOneA._id],
      });

      const res = await fetch(`${baseUrl}/api/v1/campaigns/${campaign._id}/readiness`, {
        headers: { Authorization: `Bearer ${tokenTwo}` },
      });

      assert.equal(res.status, 404);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.equal(data.message, 'Campaign not found.');
    });

    it('8. Returns 401 when request is unauthenticated', async () => {
      const campaign = await Campaign.create({
        userId: userOne._id,
        name: 'Auth Test Campaign',
        subject: 'Subject Line',
        textContent: 'Valid text',
        recipientIds: [contactOneA._id],
      });

      const res = await fetch(`${baseUrl}/api/v1/campaigns/${campaign._id}/readiness`);
      assert.equal(res.status, 401);
      const data = await res.json();
      assert.equal(data.success, false);
    });

    it('9. Returns 400 when campaign ID format is invalid', async () => {
      const res = await fetch(`${baseUrl}/api/v1/campaigns/not-a-valid-objectid/readiness`, {
        headers: { Authorization: `Bearer ${tokenOne}` },
      });

      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.ok(data.errors);
    });

    it('10. Does not mutate the stored campaign document or its recipientIds', async () => {
      const tempContact = await Contact.create({
        userId: userOne._id,
        name: 'Temp Before Mutate Check',
        email: `${testPrefix}-readiness-no-mut@example.com`,
      });

      const campaign = await Campaign.create({
        userId: userOne._id,
        name: 'No Mutation Campaign',
        subject: 'Subject Line',
        textContent: 'Valid text',
        status: 'draft',
        recipientIds: [tempContact._id],
      });

      // Delete contact to trigger missing recipient in readiness check
      await Contact.deleteOne({ _id: tempContact._id });

      const res = await fetch(`${baseUrl}/api/v1/campaigns/${campaign._id}/readiness`, {
        headers: { Authorization: `Bearer ${tokenOne}` },
      });

      assert.equal(res.status, 200);

      // Verify the campaign document in MongoDB was NOT changed/pruned
      const unchangedCampaign = await Campaign.findById(campaign._id);
      assert.ok(unchangedCampaign);
      assert.equal(unchangedCampaign.name, 'No Mutation Campaign');
      assert.equal(unchangedCampaign.recipientIds.length, 1);
      assert.equal(unchangedCampaign.recipientIds[0].toString(), tempContact._id.toString());
      assert.equal(unchangedCampaign.status, 'draft');
    });
  });
});
