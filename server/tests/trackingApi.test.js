import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config();

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET =
  process.env.JWT_SECRET || 'deterministic_test_jwt_secret_min_32_characters!';
process.env.JWT_EXPIRES_IN = '15m';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import app from '../src/app.js';
import User from '../src/models/User.js';
import Campaign from '../src/models/Campaign.js';
import TrackingEvent from '../src/models/TrackingEvent.js';
import { connectDB } from '../src/config/db.js';
import { signAccessToken } from '../src/utils/token.js';
import { hashPassword } from '../src/services/password.service.js';
import {
  TRANSPARENT_1X1_GIF,
  createTrackingToken,
} from '../src/services/tracking.service.js';

describe('Tracking API Endpoints (/api/v1/tracking & /api/v1/campaigns/:id/analytics)', () => {
  let server;
  let baseUrl;
  let isDbConnected = false;

  let ownerUser;
  let ownerToken;
  let otherUser;
  let otherToken;
  let testCampaign;

  before(async () => {
    try {
      await connectDB();
      isDbConnected = true;
      await User.init();
      await Campaign.init();
      await TrackingEvent.init();
    } catch (err) {
      isDbConnected = false;
    }

    server = app.listen(0);
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;

    if (isDbConnected) {
      const defaultPasswordHash = await hashPassword('StrongPassword123!');

      ownerUser = await User.create({
        name: 'Owner User',
        email: `tracking-api-owner-${Date.now()}@example.com`,
        passwordHash: defaultPasswordHash,
      });
      ownerToken = signAccessToken(ownerUser);

      otherUser = await User.create({
        name: 'Other User',
        email: `tracking-api-other-${Date.now()}@example.com`,
        passwordHash: defaultPasswordHash,
      });
      otherToken = signAccessToken(otherUser);

      testCampaign = await Campaign.create({
        userId: ownerUser._id,
        name: 'Tracking API Campaign',
        subject: 'Tracking API Subject',
        textContent: 'Content for tracking',
        htmlContent: '<p>HTML for tracking</p>',
        status: 'draft',
        recipientIds: [new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId()],
      });
    }
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    if (isDbConnected) {
      if (testCampaign) {
        await TrackingEvent.deleteMany({ campaignId: testCampaign._id });
        await Campaign.deleteOne({ _id: testCampaign._id });
      }
      if (ownerUser) await User.deleteOne({ _id: ownerUser._id });
      if (otherUser) await User.deleteOne({ _id: otherUser._id });
      await mongoose.connection.close();
    }
  });

  describe('1. GET /api/v1/tracking/open/:token (Public Open Tracking)', () => {
    it('returns 1x1 transparent GIF with anti-cache headers and records open event', async () => {
      if (!isDbConnected) return;

      const token = createTrackingToken({
        campaignId: testCampaign._id,
        recipientEmail: 'open-recipient@example.com',
        eventType: 'open',
      });

      const res = await fetch(`${baseUrl}/api/v1/tracking/open/${token}`, {
        headers: {
          'User-Agent': 'MailPulse-Test-Viewer/1.0',
        },
      });

      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'image/gif');
      assert.match(res.headers.get('cache-control'), /no-store/);
      assert.equal(res.headers.get('pragma'), 'no-cache');

      const buffer = Buffer.from(await res.arrayBuffer());
      assert.deepEqual(buffer, TRANSPARENT_1X1_GIF);

      // Verify open event was logged in DB
      const logged = await TrackingEvent.findOne({
        campaignId: testCampaign._id,
        recipientEmail: 'open-recipient@example.com',
        eventType: 'open',
      });
      assert.ok(logged);
      assert.equal(logged.userAgent, 'MailPulse-Test-Viewer/1.0');
    });

    it('still returns 200 with GIF on invalid token to avoid breaking recipient email display', async () => {
      const res = await fetch(`${baseUrl}/api/v1/tracking/open/invalid-corrupted-token`);

      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'image/gif');
      const buffer = Buffer.from(await res.arrayBuffer());
      assert.deepEqual(buffer, TRANSPARENT_1X1_GIF);
    });
  });

  describe('2. GET /api/v1/tracking/click/:token (Public Click Tracking & Safe Redirect)', () => {
    it('returns 302 redirect to valid target URL and records click event', async () => {
      if (!isDbConnected) return;

      const targetUrl = 'https://mailpulse.io/features';
      const token = createTrackingToken({
        campaignId: testCampaign._id,
        recipientEmail: 'click-recipient@example.com',
        eventType: 'click',
        targetUrl,
      });

      const res = await fetch(`${baseUrl}/api/v1/tracking/click/${token}`, {
        redirect: 'manual', // do not follow redirect to verify 302 and Location
        headers: {
          'User-Agent': 'MailPulse-Clicker/1.0',
        },
      });

      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), targetUrl);
      assert.match(res.headers.get('cache-control'), /no-store/);

      // Verify click event in DB
      const logged = await TrackingEvent.findOne({
        campaignId: testCampaign._id,
        recipientEmail: 'click-recipient@example.com',
        eventType: 'click',
      });
      assert.ok(logged);
      assert.equal(logged.targetUrl, targetUrl);
      assert.equal(logged.userAgent, 'MailPulse-Clicker/1.0');
    });

    it('returns 400 Bad Request on invalid, tampered, or malformed click token', async () => {
      const res = await fetch(`${baseUrl}/api/v1/tracking/click/corrupted-or-tampered-token`, {
        redirect: 'manual',
      });

      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.equal(data.message, 'Invalid or expired tracking link');
    });

    it('returns 400 Bad Request if click token points to non-HTTP protocol (open redirect defense)', async () => {
      const dangerousToken = createTrackingToken({
        campaignId: testCampaign._id,
        recipientEmail: 'victim@example.com',
        eventType: 'click',
        targetUrl: 'javascript:alert(1)',
      });

      const res = await fetch(`${baseUrl}/api/v1/tracking/click/${dangerousToken}`, {
        redirect: 'manual',
      });

      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.equal(data.message, 'Invalid or expired tracking link');
    });
  });

  describe('3. GET /api/v1/campaigns/:id/analytics (Protected Analytics Summary)', () => {
    it('returns 401 when request is unauthenticated', async () => {
      const res = await fetch(`${baseUrl}/api/v1/campaigns/${testCampaign._id}/analytics`);
      assert.equal(res.status, 401);
      const data = await res.json();
      assert.equal(data.success, false);
    });

    it('returns 400 when campaign ID format is invalid', async () => {
      const res = await fetch(`${baseUrl}/api/v1/campaigns/not-a-valid-id/analytics`, {
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.success, false);
    });

    it('returns 404 when querying another user’s campaign (tenant isolation)', async () => {
      const res = await fetch(`${baseUrl}/api/v1/campaigns/${testCampaign._id}/analytics`, {
        headers: { Authorization: `Bearer ${otherToken}` },
      });
      assert.equal(res.status, 404);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.equal(data.message, 'Campaign not found.');
    });

    it('returns 200 with aggregated metrics, link breakdown, and recent activity', async () => {
      if (!isDbConnected) return;

      const res = await fetch(`${baseUrl}/api/v1/campaigns/${testCampaign._id}/analytics`, {
        headers: { Authorization: `Bearer ${ownerToken}` },
      });

      assert.equal(res.status, 200);
      const data = await res.json();

      assert.equal(data.success, true);
      assert.ok(data.data.analytics);
      assert.equal(data.data.analytics.campaignId, testCampaign._id.toString());
      assert.equal(data.data.analytics.campaignName, 'Tracking API Campaign');

      const metrics = data.data.analytics.metrics;
      assert.ok(metrics);
      assert.equal(typeof metrics.totalOpens, 'number');
      assert.equal(typeof metrics.uniqueOpens, 'number');
      assert.equal(typeof metrics.openRate, 'number');
      assert.equal(typeof metrics.totalClicks, 'number');
      assert.equal(typeof metrics.uniqueClicks, 'number');
      assert.equal(typeof metrics.clickThroughRate, 'number');

      assert.ok(Array.isArray(data.data.analytics.linkBreakdown));
      assert.ok(Array.isArray(data.data.analytics.recentActivity));
    });
  });
});
