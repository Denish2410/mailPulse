import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config();

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import TrackingEvent from '../src/models/TrackingEvent.js';
import { connectDB } from '../src/config/db.js';

describe('TrackingEvent Model Tests (server/src/models/TrackingEvent.js)', () => {
  let isDbConnected = false;

  before(async () => {
    try {
      await connectDB();
      isDbConnected = true;
      await TrackingEvent.init();
    } catch {
      isDbConnected = false;
    }
  });

  after(async () => {
    if (isDbConnected) {
      await TrackingEvent.deleteMany({ recipientEmail: /@trackingmodel-test\.com$/i });
      await mongoose.connection.close();
    }
  });

  describe('1. Schema Validation (Offline / Unit)', () => {
    it('validates a correct TrackingEvent for an open event', () => {
      const validOpen = new TrackingEvent({
        campaignId: new mongoose.Types.ObjectId(),
        recipientEmail: 'user@example.com',
        eventType: 'open',
      });

      const err = validOpen.validateSync();
      assert.equal(err, undefined);
      assert.equal(validOpen.eventType, 'open');
      assert.equal(validOpen.recipientEmail, 'user@example.com');
      assert.ok(validOpen.timestamp instanceof Date);
    });

    it('validates a correct TrackingEvent for a click event with targetUrl', () => {
      const validClick = new TrackingEvent({
        campaignId: new mongoose.Types.ObjectId(),
        recipientId: new mongoose.Types.ObjectId(),
        recipientEmail: 'clicker@example.com',
        eventType: 'click',
        targetUrl: 'https://example.com/promo-page',
        ip: '127.0.0.1',
        userAgent: 'Mozilla/5.0 Test Agent',
      });

      const err = validClick.validateSync();
      assert.equal(err, undefined);
      assert.equal(validClick.eventType, 'click');
      assert.equal(validClick.targetUrl, 'https://example.com/promo-page');
      assert.equal(validClick.userAgent, 'Mozilla/5.0 Test Agent');
    });

    it('fails validation when required fields are missing', () => {
      const emptyDoc = new TrackingEvent({});
      const err = emptyDoc.validateSync();

      assert.ok(err);
      assert.ok(err.errors.campaignId, 'campaignId is required');
      assert.ok(err.errors.recipientEmail, 'recipientEmail is required');
      assert.ok(err.errors.eventType, 'eventType is required');
    });

    it('fails validation when eventType is not "open" or "click"', () => {
      const invalidType = new TrackingEvent({
        campaignId: new mongoose.Types.ObjectId(),
        recipientEmail: 'user@example.com',
        eventType: 'delivered',
      });

      const err = invalidType.validateSync();
      assert.ok(err);
      assert.ok(err.errors.eventType);
      assert.match(err.errors.eventType.message, /Event type must be either open or click/);
    });

    it('normalizes recipientEmail by trimming and lowercasing', () => {
      const doc = new TrackingEvent({
        campaignId: new mongoose.Types.ObjectId(),
        recipientEmail: '  User.Test+Tracking@Example.COM  ',
        eventType: 'open',
      });

      assert.equal(doc.recipientEmail, 'user.test+tracking@example.com');
    });

    it('enforces string length constraints on email, targetUrl, ip, and userAgent', () => {
      const oversizedDoc = new TrackingEvent({
        campaignId: new mongoose.Types.ObjectId(),
        recipientEmail: 'a'.repeat(255),
        eventType: 'click',
        targetUrl: 'https://example.com/' + 'x'.repeat(2048),
        ip: 'i'.repeat(101),
        userAgent: 'u'.repeat(501),
      });

      const err = oversizedDoc.validateSync();
      assert.ok(err);
      assert.ok(err.errors.recipientEmail);
      assert.ok(err.errors.targetUrl);
      assert.ok(err.errors.ip);
      assert.ok(err.errors.userAgent);
    });
  });

  describe('2. Database Integration & Persistence', () => {
    it('saves open and click events to MongoDB when connected', async () => {
      if (!isDbConnected) return;

      const campaignId = new mongoose.Types.ObjectId();
      const openEvent = await TrackingEvent.create({
        campaignId,
        recipientEmail: 'test1@trackingmodel-test.com',
        eventType: 'open',
      });

      assert.ok(openEvent._id);
      assert.equal(openEvent.eventType, 'open');

      const clickEvent = await TrackingEvent.create({
        campaignId,
        recipientEmail: 'test1@trackingmodel-test.com',
        eventType: 'click',
        targetUrl: 'https://example.com/docs',
      });

      assert.ok(clickEvent._id);
      assert.equal(clickEvent.targetUrl, 'https://example.com/docs');

      const foundEvents = await TrackingEvent.find({ campaignId });
      assert.equal(foundEvents.length, 2);
    });
  });
});
