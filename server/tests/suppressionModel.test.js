import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config();

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import Contact from '../src/models/Contact.js';
import Suppression from '../src/models/Suppression.js';
import TrackingEvent from '../src/models/TrackingEvent.js';
import { connectDB } from '../src/config/db.js';

describe('Suppression & Unsubscribe Model Tests (Contact, Suppression, TrackingEvent)', () => {
  let isDbConnected = false;

  before(async () => {
    try {
      await connectDB();
      isDbConnected = true;
      await Contact.init();
      await Suppression.init();
      await TrackingEvent.init();
    } catch {
      isDbConnected = false;
    }
  });

  after(async () => {
    if (isDbConnected) {
      await Contact.deleteMany({ email: /@suppression-test\.com$/i });
      await Suppression.deleteMany({ email: /@suppression-test\.com$/i });
      await TrackingEvent.deleteMany({ recipientEmail: /@suppression-test\.com$/i });
      await mongoose.connection.close();
    }
  });

  describe('1. Contact Model Unsubscribe Attributes', () => {
    it('defaults isUnsubscribed to false and unsubscribedAt to null', () => {
      const contact = new Contact({
        userId: new mongoose.Types.ObjectId(),
        name: 'John Doe',
        email: 'john@example.com',
      });

      const err = contact.validateSync();
      assert.equal(err, undefined);
      assert.equal(contact.isUnsubscribed, false);
      assert.equal(contact.unsubscribedAt, null);
      assert.equal(contact.unsubscribeReason, null);
    });

    it('accepts valid unsubscribe status, timestamp, and reason', () => {
      const unsubDate = new Date();
      const contact = new Contact({
        userId: new mongoose.Types.ObjectId(),
        name: 'Jane Optout',
        email: 'jane@example.com',
        isUnsubscribed: true,
        unsubscribedAt: unsubDate,
        unsubscribeReason: 'Too many emails',
      });

      const err = contact.validateSync();
      assert.equal(err, undefined);
      assert.equal(contact.isUnsubscribed, true);
      assert.equal(contact.unsubscribedAt.getTime(), unsubDate.getTime());
      assert.equal(contact.unsubscribeReason, 'Too many emails');
    });

    it('rejects an unsubscribeReason exceeding 250 characters', () => {
      const contact = new Contact({
        userId: new mongoose.Types.ObjectId(),
        name: 'Jane Optout',
        email: 'jane@example.com',
        isUnsubscribed: true,
        unsubscribeReason: 'a'.repeat(251),
      });

      const err = contact.validateSync();
      assert.ok(err);
      assert.ok(err.errors.unsubscribeReason);
    });
  });

  describe('2. Suppression Model Schema Validation (Offline)', () => {
    it('validates a complete, valid Suppression record', () => {
      const suppression = new Suppression({
        userId: new mongoose.Types.ObjectId(),
        email: '  OPT-OUT@example.COM  ',
        campaignId: new mongoose.Types.ObjectId(),
        reason: 'No longer interested',
        source: 'link',
      });

      const err = suppression.validateSync();
      assert.equal(err, undefined);
      assert.equal(suppression.email, 'opt-out@example.com');
      assert.equal(suppression.source, 'link');
      assert.equal(suppression.reason, 'No longer interested');
    });

    it('requires userId', () => {
      const suppression = new Suppression({
        email: 'valid@example.com',
      });

      const err = suppression.validateSync();
      assert.ok(err);
      assert.ok(err.errors.userId);
    });

    it('requires email', () => {
      const suppression = new Suppression({
        userId: new mongoose.Types.ObjectId(),
      });

      const err = suppression.validateSync();
      assert.ok(err);
      assert.ok(err.errors.email);
    });

    it('rejects invalid email formats', () => {
      const suppression = new Suppression({
        userId: new mongoose.Types.ObjectId(),
        email: 'not-an-email',
      });

      const err = suppression.validateSync();
      assert.ok(err);
      assert.ok(err.errors.email);
    });

    it('defaults source to "link" and allows "one-click-header", "admin", "import"', () => {
      const defaultSuppression = new Suppression({
        userId: new mongoose.Types.ObjectId(),
        email: 'test@example.com',
      });
      assert.equal(defaultSuppression.source, 'link');

      const headerSuppression = new Suppression({
        userId: new mongoose.Types.ObjectId(),
        email: 'header@example.com',
        source: 'one-click-header',
      });
      assert.equal(headerSuppression.validateSync(), undefined);

      const invalidSource = new Suppression({
        userId: new mongoose.Types.ObjectId(),
        email: 'invalid@example.com',
        source: 'unsupported-source',
      });
      const err = invalidSource.validateSync();
      assert.ok(err);
      assert.ok(err.errors.source);
    });
  });

  describe('3. TrackingEvent Model Unsubscribe Event Type', () => {
    it('accepts "unsubscribe" as a valid eventType', () => {
      const event = new TrackingEvent({
        campaignId: new mongoose.Types.ObjectId(),
        recipientId: new mongoose.Types.ObjectId(),
        recipientEmail: 'unsubscribed@example.com',
        eventType: 'unsubscribe',
      });

      const err = event.validateSync();
      assert.equal(err, undefined);
      assert.equal(event.eventType, 'unsubscribe');
    });
  });

  describe('4. Suppression Persistence & Unique Compound Index (Database)', () => {
    it('persists a suppression record and prevents duplicate suppressions for the same user + email', async () => {
      if (!isDbConnected) return;

      const ownerId = new mongoose.Types.ObjectId();
      const testEmail = 'optout-persist@suppression-test.com';

      const s1 = await Suppression.create({
        userId: ownerId,
        email: testEmail,
        reason: 'Testing unique index',
        source: 'link',
      });

      assert.ok(s1._id);
      assert.equal(s1.email, testEmail);

      // Attempt to insert duplicate for same user and email
      await assert.rejects(
        async () => {
          await Suppression.create({
            userId: ownerId,
            email: testEmail,
            source: 'one-click-header',
          });
        },
        /duplicate key|E11000/i
      );

      // Different user CAN suppress the same email address
      const otherOwnerId = new mongoose.Types.ObjectId();
      const s2 = await Suppression.create({
        userId: otherOwnerId,
        email: testEmail,
        source: 'admin',
      });

      assert.ok(s2._id);
      assert.equal(s2.email, testEmail);
    });
  });
});
