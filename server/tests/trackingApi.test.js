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
import Delivery from '../src/models/Delivery.js';
import Contact from '../src/models/Contact.js';
import Suppression from '../src/models/Suppression.js';
import TrackingEvent from '../src/models/TrackingEvent.js';
import { connectDB } from '../src/config/db.js';
import { signAccessToken } from '../src/utils/token.js';
import { hashPassword } from '../src/services/password.service.js';
import {
  TRANSPARENT_1X1_GIF,
  createTrackingToken,
  createUnsubscribeToken,
} from '../src/services/tracking.service.js';
import { processNextDelivery } from '../src/services/campaignDispatch.service.js';
import { evaluateCampaignReadiness } from '../src/services/campaignReadiness.service.js';

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

  describe('4. Campaign Dispatch Integration with Open & Click Tracking', () => {
    it('dispatches campaign email with open tracking pixel and click tracking links injected', async () => {
      if (!isDbConnected) return;

      const mockTransport = {
        sentEmails: [],
        async sendMail(opts) {
          this.sentEmails.push(opts);
          return { messageId: '<tracked-1@mailpulse.local>' };
        },
      };

      const emailService = {
        async sendEmail(opts) {
          return mockTransport.sendMail(opts);
        },
      };

      await Delivery.create({
        campaignId: testCampaign._id,
        userId: ownerUser._id,
        contactId: new mongoose.Types.ObjectId(),
        email: 'delivery-tracked@example.com',
        name: 'Tracked Recipient',
        status: 'pending',
      });

      const message = {
        subject: 'Tracked Message',
        text: 'Text version',
        html: '<p>Visit <a href="https://example.com/special">Special Offer</a></p>',
      };

      const hadWork = await processNextDelivery(
        testCampaign._id,
        message,
        emailService
      );

      assert.equal(hadWork, true);
      assert.equal(mockTransport.sentEmails.length, 1);
      const sent = mockTransport.sentEmails[0];
      assert.equal(sent.to, 'delivery-tracked@example.com');
      assert.ok(sent.html.includes('/api/v1/tracking/open/'), 'HTML must include open tracking pixel URL');
      assert.ok(sent.html.includes('/api/v1/tracking/click/'), 'HTML must include rewritten click tracking URL');
      assert.ok(!sent.html.includes('href="https://example.com/special"'), 'Raw destination URL must be rewritten');
      assert.ok(sent.html.includes('/api/v1/tracking/unsubscribe/'), 'HTML must include unsubscribe URL');
      assert.ok(sent.headers['List-Unsubscribe'], 'Headers must include List-Unsubscribe');
      assert.equal(sent.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
    });
  });

  describe('5. Public Unsubscribe Endpoints (/api/v1/tracking/unsubscribe/:token)', () => {
    it('GET returns 400 for an invalid or tampered unsubscribe token', async () => {
      const res = await fetch(`${baseUrl}/api/v1/tracking/unsubscribe/invalid-token-123.fake-signature`, {
        headers: { Accept: 'application/json' },
      });

      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.message, /Invalid or expired unsubscribe link/i);
    });

    it('GET returns 200 with HTML confirmation page for a valid token', async () => {
      if (!isDbConnected) return;

      const token = createUnsubscribeToken({
        campaignId: testCampaign._id,
        recipientEmail: 'unsub-get-user@example.com',
        userId: ownerUser._id,
      });

      const res = await fetch(`${baseUrl}/api/v1/tracking/unsubscribe/${token}`, {
        headers: { Accept: 'text/html' },
      });

      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(text.includes('Confirm Unsubscribe'));
      assert.ok(text.includes('unsub-get-user@example.com'));
      assert.ok(text.includes(`<form method="POST" action="/api/v1/tracking/unsubscribe/${token}">`));
    });

    it('GET returns 200 JSON when format=json query parameter is present', async () => {
      if (!isDbConnected) return;

      const token = createUnsubscribeToken({
        campaignId: testCampaign._id,
        recipientEmail: 'unsub-json@example.com',
        userId: ownerUser._id,
      });

      const res = await fetch(`${baseUrl}/api/v1/tracking/unsubscribe/${token}?format=json`);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.email, 'unsub-json@example.com');
    });

    it('POST processes unsubscribe request via web form and updates models', async () => {
      if (!isDbConnected) return;

      const testEmail = `unsub-post-${Date.now()}@example.com`;
      const contact = await Contact.create({
        userId: ownerUser._id,
        name: 'Unsub Web User',
        email: testEmail,
      });

      const token = createUnsubscribeToken({
        campaignId: testCampaign._id,
        recipientId: contact._id,
        recipientEmail: testEmail,
        userId: ownerUser._id,
      });

      const res = await fetch(`${baseUrl}/api/v1/tracking/unsubscribe/${token}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'text/html',
        },
        body: 'reason=Not+interested+anymore',
      });

      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(text.includes('You have been unsubscribed'));
      assert.ok(text.includes(testEmail));

      // Verify contact updated
      const updated = await Contact.findById(contact._id);
      assert.equal(updated.isUnsubscribed, true);
      assert.ok(updated.unsubscribedAt instanceof Date);

      // Verify suppression created
      const suppression = await Suppression.findOne({
        userId: ownerUser._id,
        email: testEmail,
      });
      assert.ok(suppression);
      assert.equal(suppression.source, 'link');
    });

    it('POST processes RFC 8058 One-Click unsubscribe header request', async () => {
      if (!isDbConnected) return;

      const testEmail = `oneclick-${Date.now()}@example.com`;
      await Contact.create({
        userId: ownerUser._id,
        name: 'One Click User',
        email: testEmail,
      });

      const token = createUnsubscribeToken({
        campaignId: testCampaign._id,
        recipientEmail: testEmail,
        userId: ownerUser._id,
      });

      const res = await fetch(`${baseUrl}/api/v1/tracking/unsubscribe/${token}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'List-Unsubscribe=One-Click',
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.email, testEmail);

      const suppression = await Suppression.findOne({
        userId: ownerUser._id,
        email: testEmail,
      });
      assert.ok(suppression);
      assert.equal(suppression.source, 'one-click-header');
    });
  });

  describe('6. Suppression Enforcement in Campaign Readiness and Dispatch', () => {
    it('readiness evaluation filters out unsubscribed contacts and increments unsubscribedRecipientsCount', async () => {
      if (!isDbConnected) return;

      const activeContact = await Contact.create({
        userId: ownerUser._id,
        name: 'Active Contact',
        email: `active-${Date.now()}@example.com`,
      });

      const unsubContact = await Contact.create({
        userId: ownerUser._id,
        name: 'Unsubscribed Contact',
        email: `unsub-${Date.now()}@example.com`,
        isUnsubscribed: true,
        unsubscribedAt: new Date(),
      });

      const campaign = {
        name: 'Readiness Suppression Campaign',
        subject: 'Subject Line',
        textContent: 'Content',
        status: 'draft',
        recipientIds: [activeContact._id, unsubContact._id],
      };

      const readiness = await evaluateCampaignReadiness(campaign, ownerUser._id);
      assert.equal(readiness.isReady, true);
      assert.equal(readiness.summary.totalRecipients, 2);
      assert.equal(readiness.summary.eligibleRecipientsCount, 1);
      assert.equal(readiness.summary.unsubscribedRecipientsCount, 1);
      assert.equal(readiness.eligibleContacts[0]._id.toString(), activeContact._id.toString());
    });

    it('dispatch skips suppressed contact and marks delivery status failed with SUPPRESSED error code', async () => {
      if (!isDbConnected) return;

      const suppressedEmail = `suppressed-${Date.now()}@example.com`;
      await Suppression.create({
        userId: ownerUser._id,
        email: suppressedEmail,
        source: 'link',
      });

      const delivery = await Delivery.create({
        campaignId: testCampaign._id,
        userId: ownerUser._id,
        contactId: new mongoose.Types.ObjectId(),
        email: suppressedEmail,
        name: 'Suppressed Recipient',
        status: 'pending',
      });

      const mockEmailService = {
        sent: [],
        async sendEmail(opts) {
          this.sent.push(opts);
          return { messageId: '<should-not-be-called>' };
        },
      };

      const hadWork = await processNextDelivery(
        testCampaign._id,
        { subject: 'Subj', text: 'Text', html: '<p>HTML</p>' },
        mockEmailService
      );

      assert.equal(hadWork, true);
      assert.equal(mockEmailService.sent.length, 0, 'Must NOT attempt to send email to suppressed recipient');

      const updated = await Delivery.findById(delivery._id);
      assert.equal(updated.status, 'failed');
      assert.equal(updated.errorCode, 'SUPPRESSED');
      assert.ok(updated.failedAt instanceof Date);
    });
  });
});

