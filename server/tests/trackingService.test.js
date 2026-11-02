import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config();

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {
  TRANSPARENT_1X1_GIF,
  TrackingTokenError,
  createTrackingToken,
  verifyTrackingToken,
  createUnsubscribeToken,
  verifyUnsubscribeToken,
  injectOpenTrackingPixel,
  rewriteLinksForClickTracking,
  injectUnsubscribeLinks,
  prepareTrackedEmailHtml,
  recordOpenEvent,
  recordClickEvent,
  recordUnsubscribeEvent,
  getCampaignTrackingSummary,
} from '../src/services/tracking.service.js';
import TrackingEvent from '../src/models/TrackingEvent.js';
import Campaign from '../src/models/Campaign.js';
import User from '../src/models/User.js';
import Contact from '../src/models/Contact.js';
import Suppression from '../src/models/Suppression.js';
import { connectDB } from '../src/config/db.js';

describe('Tracking Service Tests (server/src/services/tracking.service.js)', () => {
  let isDbConnected = false;
  const testSecret = 'deterministic-test-tracking-secret-32-chars!';

  let testUser;
  let testCampaign;

  before(async () => {
    try {
      await connectDB();
      isDbConnected = true;
      await User.init();
      await Campaign.init();
      await TrackingEvent.init();

      testUser = await User.create({
        name: 'Tracking Service User',
        email: `tracking-svc-${Date.now()}@example.com`,
        passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$dummyhashfordbtestingonly',
      });

      testCampaign = await Campaign.create({
        userId: testUser._id,
        name: 'Service Test Campaign',
        subject: 'Service Test Subject',
        textContent: 'Plain body',
        htmlContent: '<p>HTML body</p>',
        status: 'draft',
        recipientIds: [new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId()],
      });
    } catch {
      isDbConnected = false;
    }
  });

  after(async () => {
    if (isDbConnected) {
      if (testCampaign) {
        await TrackingEvent.deleteMany({ campaignId: testCampaign._id });
        await Campaign.deleteOne({ _id: testCampaign._id });
      }
      if (testUser) {
        await User.deleteOne({ _id: testUser._id });
      }
      await mongoose.connection.close();
    }
  });

  describe('1. Token Signing & Verification', () => {
    it('creates and verifies a valid open tracking token', () => {
      const campaignId = '672000000000000000000001';
      const token = createTrackingToken(
        {
          campaignId,
          recipientEmail: 'Recipient@Example.Com',
          eventType: 'open',
        },
        testSecret
      );

      assert.equal(typeof token, 'string');
      assert.ok(token.includes('.'));

      const verified = verifyTrackingToken(token, testSecret);
      assert.equal(verified.campaignId, campaignId);
      assert.equal(verified.recipientEmail, 'recipient@example.com');
      assert.equal(verified.eventType, 'open');
      assert.equal(verified.targetUrl, null);
    });

    it('creates and verifies a valid click tracking token with targetUrl', () => {
      const campaignId = '672000000000000000000002';
      const token = createTrackingToken(
        {
          campaignId,
          recipientId: '672000000000000000000003',
          recipientEmail: 'clicker@example.com',
          eventType: 'click',
          targetUrl: 'https://mailpulse.io/product?utm_source=email',
        },
        testSecret
      );

      const verified = verifyTrackingToken(token, testSecret);
      assert.equal(verified.campaignId, campaignId);
      assert.equal(verified.recipientId, '672000000000000000000003');
      assert.equal(verified.recipientEmail, 'clicker@example.com');
      assert.equal(verified.eventType, 'click');
      assert.equal(verified.targetUrl, 'https://mailpulse.io/product?utm_source=email');
    });

    it('rejects tampered token signature', () => {
      const token = createTrackingToken(
        {
          campaignId: '672000000000000000000001',
          recipientEmail: 'user@example.com',
          eventType: 'open',
        },
        testSecret
      );

      const [payload, sig] = token.split('.');
      const tamperedToken = `${payload}.${sig.slice(0, -4)}abcd`;

      assert.throws(() => verifyTrackingToken(tamperedToken, testSecret), {
        name: 'TrackingTokenError',
        message: /Invalid tracking token signature/,
      });
    });

    it('rejects token signed with a different secret', () => {
      const token = createTrackingToken(
        {
          campaignId: '672000000000000000000001',
          recipientEmail: 'user@example.com',
          eventType: 'open',
        },
        'wrong-secret-key-that-does-not-match'
      );

      assert.throws(() => verifyTrackingToken(token, testSecret), {
        name: 'TrackingTokenError',
        message: /Invalid tracking token signature/,
      });
    });

    it('rejects malformed token strings without dot delimiter', () => {
      assert.throws(() => verifyTrackingToken('not-a-valid-token', testSecret), {
        name: 'TrackingTokenError',
        message: /Invalid tracking token format/,
      });
    });
  });

  describe('2. Open Tracking Pixel Injection', () => {
    it('injects 1x1 tracking pixel immediately before </body> tag', () => {
      const html = '<html><body><h1>Hello World</h1><p>Welcome</p></body></html>';
      const tracked = injectOpenTrackingPixel(html, {
        campaignId: '672000000000000000000001',
        recipientEmail: 'user@example.com',
        baseUrl: 'http://localhost:5000',
        secret: testSecret,
      });

      assert.match(tracked, /<img src="http:\/\/localhost:5000\/api\/v1\/tracking\/open\/[^"]+" width="1" height="1"/);
      assert.match(tracked, /<\/body><\/html>$/);
      // Ensure pixel comes before </body>
      const pixelIndex = tracked.indexOf('<img src="http://localhost:5000/api/v1/tracking/open/');
      const bodyIndex = tracked.indexOf('</body>');
      assert.ok(pixelIndex < bodyIndex, 'Pixel must precede closing body tag');
    });

    it('appends tracking pixel to the end of HTML if </body> is not present', () => {
      const html = '<div>Snippet without body tag</div>';
      const tracked = injectOpenTrackingPixel(html, {
        campaignId: '672000000000000000000001',
        recipientEmail: 'user@example.com',
        baseUrl: 'https://api.mailpulse.io',
        secret: testSecret,
      });

      assert.ok(tracked.startsWith('<div>Snippet without body tag</div>'));
      assert.match(tracked, /<img src="https:\/\/api\.mailpulse\.io\/api\/v1\/tracking\/open\//);
    });

    it('returns empty string when given non-string or empty input', () => {
      assert.equal(injectOpenTrackingPixel('', {}), '');
      assert.equal(injectOpenTrackingPixel('   ', {}), '   ');
      assert.equal(injectOpenTrackingPixel(null, {}), '');
    });
  });

  describe('3. Link Rewriting for Click Tracking', () => {
    it('rewrites HTTP and HTTPS anchor links with tracking redirects', () => {
      const html = `
        <div>
          <a href="https://example.com/promo">Check Promo</a>
          <a class="cta" href="http://example.com/login" target="_blank">Login</a>
        </div>
      `;

      const rewritten = rewriteLinksForClickTracking(html, {
        campaignId: '672000000000000000000001',
        recipientEmail: 'clicker@example.com',
        baseUrl: 'http://localhost:5000',
        secret: testSecret,
      });

      assert.doesNotMatch(rewritten, /href="https:\/\/example\.com\/promo"/);
      assert.doesNotMatch(rewritten, /href="http:\/\/example\.com\/login"/);
      assert.match(rewritten, /href="http:\/\/localhost:5000\/api\/v1\/tracking\/click\/[^"]+"/);
      assert.match(rewritten, /class="cta"/);
      assert.match(rewritten, /target="_blank"/);
    });

    it('preserves mailto, tel, anchor fragments, and relative links without rewriting', () => {
      const html = `
        <div>
          <a href="mailto:support@mailpulse.io">Email Us</a>
          <a href="tel:+18005550199">Call Support</a>
          <a href="#section-2">Jump to Section</a>
          <a href="https://example.com/real-link">Real Link</a>
        </div>
      `;

      const rewritten = rewriteLinksForClickTracking(html, {
        campaignId: '672000000000000000000001',
        recipientEmail: 'user@example.com',
        baseUrl: 'http://localhost:5000',
        secret: testSecret,
      });

      assert.match(rewritten, /href="mailto:support@mailpulse\.io"/);
      assert.match(rewritten, /href="tel:\+18005550199"/);
      assert.match(rewritten, /href="#section-2"/);
      // Real link was rewritten
      assert.match(rewritten, /href="http:\/\/localhost:5000\/api\/v1\/tracking\/click\//);
    });

    it('prepareTrackedEmailHtml executes both link rewriting and pixel injection', () => {
      const html = '<html><body><a href="https://mailpulse.io">Visit</a></body></html>';
      const prepared = prepareTrackedEmailHtml(html, {
        campaignId: '672000000000000000000001',
        recipientEmail: 'combo@example.com',
        baseUrl: 'http://localhost:5000',
        secret: testSecret,
      });

      assert.match(prepared, /tracking\/click\//);
      assert.match(prepared, /tracking\/open\//);
      assert.match(prepared, /<\/body><\/html>$/);
    });
  });

  describe('4. Event Recording & Open-Redirect Defense', () => {
    it('records open event into TrackingEvent collection', async () => {
      if (!isDbConnected) return;

      const token = createTrackingToken(
        {
          campaignId: testCampaign._id,
          recipientEmail: 'open-recorder@example.com',
          eventType: 'open',
        },
        testSecret
      );

      const event = await recordOpenEvent(
        token,
        { ip: '192.168.1.1', userAgent: 'MailPulse Test Client' },
        testSecret
      );

      assert.ok(event._id);
      assert.equal(event.eventType, 'open');
      assert.equal(event.recipientEmail, 'open-recorder@example.com');
      assert.equal(event.ip, '192.168.1.1');
    });

    it('records click event and returns safe target URL', async () => {
      if (!isDbConnected) return;

      const targetUrl = 'https://mailpulse.io/dashboard';
      const token = createTrackingToken(
        {
          campaignId: testCampaign._id,
          recipientEmail: 'click-recorder@example.com',
          eventType: 'click',
          targetUrl,
        },
        testSecret
      );

      const result = await recordClickEvent(
        token,
        { ip: '10.0.0.1', userAgent: 'Chrome Browser' },
        testSecret
      );

      assert.equal(result.targetUrl, targetUrl);
      assert.ok(result.event._id);
      assert.equal(result.event.eventType, 'click');
      assert.equal(result.event.targetUrl, targetUrl);
    });

    it('rejects open-redirect attack with javascript: protocol in click token', async () => {
      const maliciousToken = createTrackingToken(
        {
          campaignId: testCampaign._id,
          recipientEmail: 'victim@example.com',
          eventType: 'click',
          targetUrl: 'javascript:alert(document.cookie)',
        },
        testSecret
      );

      await assert.rejects(
        () => recordClickEvent(maliciousToken, {}, testSecret),
        {
          name: 'TrackingTokenError',
          message: /Invalid destination URL protocol; must be HTTP or HTTPS/,
        }
      );
    });
  });

  describe('5. Campaign Tracking Summary Aggregation', () => {
    it('aggregates total opens, unique opens, clicks, CTR, and link breakdown', async () => {
      if (!isDbConnected) return;

      const campaignId = testCampaign._id;
      await TrackingEvent.deleteMany({ campaignId });

      // Create synthetic events:
      // User 1 opens twice, User 2 opens once -> totalOpens: 3, uniqueOpens: 2
      // User 1 clicks link A twice, User 2 clicks link B once -> totalClicks: 3, uniqueClicks: 2
      await TrackingEvent.create([
        { campaignId, recipientEmail: 'user1@example.com', eventType: 'open' },
        { campaignId, recipientEmail: 'user1@example.com', eventType: 'open' },
        { campaignId, recipientEmail: 'user2@example.com', eventType: 'open' },
        {
          campaignId,
          recipientEmail: 'user1@example.com',
          eventType: 'click',
          targetUrl: 'https://site.com/a',
        },
        {
          campaignId,
          recipientEmail: 'user1@example.com',
          eventType: 'click',
          targetUrl: 'https://site.com/a',
        },
        {
          campaignId,
          recipientEmail: 'user2@example.com',
          eventType: 'click',
          targetUrl: 'https://site.com/b',
        },
      ]);

      const summary = await getCampaignTrackingSummary(campaignId, testUser._id);

      assert.equal(summary.campaignId, campaignId.toString());
      assert.equal(summary.metrics.totalOpens, 3);
      assert.equal(summary.metrics.uniqueOpens, 2);
      assert.equal(summary.metrics.totalClicks, 3);
      assert.equal(summary.metrics.uniqueClicks, 2);

      // Total recipients on testCampaign = 2
      assert.equal(summary.metrics.openRate, 100); // 2 unique / 2 total recipients
      assert.equal(summary.metrics.clickThroughRate, 100); // 2 unique clicks / 2 unique opens

      // Link breakdown
      assert.equal(summary.linkBreakdown.length, 2);
      const linkA = summary.linkBreakdown.find((l) => l.url === 'https://site.com/a');
      assert.ok(linkA);
      assert.equal(linkA.totalClicks, 2);
      assert.equal(linkA.uniqueClicks, 1);
    });

    it('enforces tenant isolation and returns 404 for cross-tenant access', async () => {
      if (!isDbConnected) return;

      const otherUserId = new mongoose.Types.ObjectId();
      await assert.rejects(
        () => getCampaignTrackingSummary(testCampaign._id, otherUserId),
        {
          statusCode: 404,
          message: 'Campaign not found.',
        }
      );
    });
  });

  describe('6. Unsubscribe Tokens & Link Injection', () => {
    it('creates and verifies a valid HMAC unsubscribe token', () => {
      const payload = {
        campaignId: testCampaign._id,
        recipientId: new mongoose.Types.ObjectId(),
        recipientEmail: 'Recipient@Example.com',
        userId: testUser._id,
      };

      const token = createUnsubscribeToken(payload, testSecret);
      assert.ok(typeof token === 'string');
      assert.ok(token.includes('.'));

      const verified = verifyUnsubscribeToken(token, testSecret);
      assert.equal(verified.campaignId, testCampaign._id.toString());
      assert.equal(verified.recipientEmail, 'recipient@example.com');
      assert.equal(verified.userId, testUser._id.toString());
      assert.equal(verified.eventType, 'unsubscribe');
    });

    it('rejects tampered unsubscribe token signature', () => {
      const token = createUnsubscribeToken(
        { recipientEmail: 'a@example.com', userId: testUser._id },
        testSecret
      );
      const [payloadPart, sigPart] = token.split('.');
      const tampered = `${payloadPart}.${sigPart.slice(0, -2)}xx`;

      assert.throws(() => verifyUnsubscribeToken(tampered, testSecret), {
        name: 'TrackingTokenError',
        message: 'Invalid unsubscribe token signature',
      });
    });

    it('replaces {{unsubscribeUrl}} and {{unsubscribe}} in HTML and text', () => {
      const html = '<p>Hello <a href="{{unsubscribeUrl}}">Unsub</a> or {{unsubscribe}}</p>';
      const text = 'Hello visit {{unsubscribeUrl}} to leave';
      const unsubUrl = 'https://mailpulse.local/api/v1/tracking/unsubscribe/tok123';

      const result = injectUnsubscribeLinks(html, text, {
        unsubscribeUrl: unsubUrl,
        appendToText: true,
      });
      assert.ok(!result.html.includes('{{unsubscribeUrl}}'));
      assert.ok(!result.html.includes('{{unsubscribe}}'));
      assert.ok(result.html.includes(unsubUrl));
      assert.ok(result.text.includes(unsubUrl));
      assert.ok(!result.text.includes('{{unsubscribeUrl}}'));
    });

    it('appends compliant footer if no placeholder is present', () => {
      const html = '<html><body><h1>Hello World</h1></body></html>';
      const text = 'Hello World plain text';
      const unsubUrl = 'https://mailpulse.local/api/v1/tracking/unsubscribe/tok123';

      const result = injectUnsubscribeLinks(html, text, {
        unsubscribeUrl: unsubUrl,
        appendToText: true,
      });
      assert.ok(result.html.includes('mailpulse-unsubscribe-footer'));
      assert.ok(result.html.includes(unsubUrl));
      assert.ok(result.html.includes('</body>'));
      assert.ok(result.text.includes('To unsubscribe, please visit: ' + unsubUrl));
    });

    it('prepareTrackedEmailHtml includes unsubscribe footer when unsubscribeUrl option is provided', () => {
      const html = '<p>Check <a href="https://example.com/shop">shop</a></p>';
      const unsubUrl = 'https://mailpulse.local/api/v1/tracking/unsubscribe/tok123';

      const result = prepareTrackedEmailHtml(html, {
        campaignId: testCampaign._id,
        recipientEmail: 'user@example.com',
        baseUrl: 'http://localhost:5000',
        unsubscribeUrl: unsubUrl,
      });

      assert.ok(result.includes('/api/v1/tracking/open/'));
      assert.ok(result.includes('/api/v1/tracking/click/'));
      assert.ok(result.includes(unsubUrl));
    });
  });

  describe('7. Unsubscribe Event Recording & Suppression Sync', () => {
    it('marks contact unsubscribed and creates a persistent suppression record', async () => {
      if (!isDbConnected) return;

      const testEmail = `optout-${Date.now()}@example.com`;
      const contact = await Contact.create({
        userId: testUser._id,
        name: 'Unsub Tester',
        email: testEmail,
      });

      const token = createUnsubscribeToken({
        campaignId: testCampaign._id,
        recipientId: contact._id,
        recipientEmail: testEmail,
        userId: testUser._id,
      });

      const outcome = await recordUnsubscribeEvent(token, {
        ip: '192.168.1.1',
        userAgent: 'TestBrowser',
        reason: 'Too frequent',
        source: 'link',
      });

      assert.equal(outcome.success, true);
      assert.equal(outcome.email, testEmail);

      // Verify Contact is marked unsubscribed
      const updatedContact = await Contact.findById(contact._id);
      assert.equal(updatedContact.isUnsubscribed, true);
      assert.ok(updatedContact.unsubscribedAt instanceof Date);
      assert.equal(updatedContact.unsubscribeReason, 'Too frequent');

      // Verify Suppression record is persisted
      const suppression = await Suppression.findOne({
        userId: testUser._id,
        email: testEmail,
      });
      assert.ok(suppression);
      assert.equal(suppression.reason, 'Too frequent');
      assert.equal(suppression.source, 'link');

      // Verify TrackingEvent was logged
      const trackingEvt = await TrackingEvent.findOne({
        campaignId: testCampaign._id,
        recipientEmail: testEmail,
        eventType: 'unsubscribe',
      });
      assert.ok(trackingEvt);
    });
  });
});
