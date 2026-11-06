import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import BounceEvent, { BOUNCE_PROVIDERS, BOUNCE_EVENT_TYPES } from '../src/models/BounceEvent.js';
import Suppression from '../src/models/Suppression.js';

const valid = () => ({
  userId: new mongoose.Types.ObjectId(),
  campaignId: new mongoose.Types.ObjectId(),
  deliveryId: new mongoose.Types.ObjectId(),
  email: ' Bounce@Example.COM ',
  provider: 'sendgrid',
  eventType: 'hard_bounce',
  providerEventId: 'evt-1',
});

describe('BounceEvent model (offline)', () => {
  it('accepts a valid event and normalizes the email', () => {
    const doc = new BounceEvent(valid());
    assert.equal(doc.validateSync(), undefined);
    assert.equal(doc.email, 'bounce@example.com');
    assert.equal(doc.contactId, null);
  });

  it('requires ownership, linkage, provider and idempotency key', () => {
    const doc = new BounceEvent({});
    const errors = doc.validateSync().errors;
    for (const field of ['userId', 'campaignId', 'deliveryId', 'email', 'provider', 'eventType', 'providerEventId']) {
      assert.ok(errors[field], `${field} should be required`);
    }
  });

  it('rejects unknown providers and event types', () => {
    assert.deepEqual(BOUNCE_PROVIDERS, ['sendgrid', 'mailgun', 'ses']);
    assert.deepEqual(BOUNCE_EVENT_TYPES, ['hard_bounce', 'soft_bounce', 'complaint']);
    const doc = new BounceEvent({ ...valid(), provider: 'postmark', eventType: 'open' });
    const errors = doc.validateSync().errors;
    assert.ok(errors.provider);
    assert.ok(errors.eventType);
  });

  it('bounds the stored reason length', () => {
    const doc = new BounceEvent({ ...valid(), reason: 'x'.repeat(201) });
    assert.ok(doc.validateSync().errors.reason);
  });

  it('declares a unique provider/event index for idempotent retries', () => {
    const unique = BounceEvent.schema.indexes().find(([fields]) => fields.provider === 1 && fields.providerEventId === 1);
    assert.ok(unique);
    assert.equal(unique[1].unique, true);
  });
});

describe('Suppression sources for bounces', () => {
  it('accepts bounce and complaint sources', () => {
    for (const source of ['bounce', 'complaint']) {
      const doc = new Suppression({ userId: new mongoose.Types.ObjectId(), email: 'a@b.co', source });
      assert.equal(doc.validateSync(), undefined, source);
    }
    const bad = new Suppression({ userId: new mongoose.Types.ObjectId(), email: 'a@b.co', source: 'nope' });
    assert.ok(bad.validateSync().errors.source);
  });
});
