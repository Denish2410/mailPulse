import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config();

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET =
  process.env.JWT_SECRET || 'deterministic_test_jwt_secret_min_32_characters!';
delete process.env.TRACKING_SECRET;

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import TrackingEvent from '../src/models/TrackingEvent.js';
import { connectDB } from '../src/config/db.js';
import {
  hashIp,
  getTrackingSecret,
  createTrackingToken,
  recordOpenEvent,
  recordClickEvent,
} from '../src/services/tracking.service.js';

describe('hashIp (no DB)', () => {
  it('is deterministic, hides the address and differs per address', () => {
    const a = hashIp('203.0.113.7');
    assert.equal(a, hashIp('203.0.113.7'));
    assert.notEqual(a, hashIp('203.0.113.8'));
    assert.match(a, /^[0-9a-f]{32}$/);
    assert.ok(!a.includes('203'));
  });

  it('returns null without an IP and depends on the server secret', () => {
    assert.equal(hashIp(null), null);
    assert.equal(hashIp(''), null);
    const before = hashIp('198.51.100.1');
    const saved = process.env.JWT_SECRET;
    process.env.JWT_SECRET = 'a_completely_different_secret_value_32chars_x';
    try {
      assert.notEqual(hashIp('198.51.100.1'), before, 'cannot be recomputed without the secret');
    } finally {
      process.env.JWT_SECRET = saved;
    }
  });

  it('fails closed instead of using a built-in secret', () => {
    const jwt = process.env.JWT_SECRET;
    delete process.env.JWT_SECRET;
    try {
      assert.throws(() => getTrackingSecret(), /must be set/);
      assert.throws(() => hashIp('1.2.3.4'), /must be set/);
      assert.equal(getTrackingSecret('explicit-override'), 'explicit-override');
    } finally {
      process.env.JWT_SECRET = jwt;
    }
  });
});

describe('Tracking events never store raw IPs', () => {
  let isDbConnected = false;
  const campaignId = new mongoose.Types.ObjectId();
  const email = `ip-privacy-${Date.now()}@example.com`;

  before(async () => {
    try {
      await connectDB();
      isDbConnected = true;
    } catch (err) {
      console.warn(`[IP Privacy Tests] MongoDB unavailable: ${err.message}`);
    }
  });

  after(async () => {
    if (isDbConnected) {
      await TrackingEvent.deleteMany({ campaignId });
      await mongoose.disconnect();
    }
  });

  it('stores only the hash for opens and clicks', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const open = createTrackingToken({ campaignId: String(campaignId), recipientEmail: email, eventType: 'open' });
    const click = createTrackingToken({ campaignId: String(campaignId), recipientEmail: email, eventType: 'click', targetUrl: 'https://example.com' });
    await recordOpenEvent(open, { ip: '203.0.113.50', userAgent: 'UA' });
    await recordClickEvent(click, { ip: '203.0.113.50', userAgent: 'UA' });

    const raw = await TrackingEvent.collection.find({ campaignId }).toArray();
    assert.equal(raw.length, 2);
    for (const doc of raw) {
      assert.equal(doc.ipHash, hashIp('203.0.113.50'));
      assert.ok(doc.ip === undefined || doc.ip === null, 'no raw ip field value');
      assert.ok(!JSON.stringify(doc).includes('203.0.113.50'));
    }
  });

  it('the anonymize script converts legacy raw IPs and is safe to re-run', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    await TrackingEvent.collection.insertMany([
      { campaignId, recipientEmail: email, eventType: 'open', ip: '192.0.2.10', timestamp: new Date() },
      { campaignId, recipientEmail: email, eventType: 'open', ip: '192.0.2.11', timestamp: new Date() },
      { campaignId, recipientEmail: email, eventType: 'open', ip: null, timestamp: new Date() },
    ]);
    const run = (...args) =>
      spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/anonymize-tracking-ips.js'), ...args], {
        env: { ...process.env, MONGODB_URI: mongoose.connection.client.s.url },
        encoding: 'utf8',
      });

    const dry = run('--dry-run');
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /Dry run/);
    assert.equal(await TrackingEvent.collection.countDocuments({ campaignId, ip: '192.0.2.10' }), 1);

    const real = run();
    assert.equal(real.status, 0, real.stderr);
    assert.match(real.stdout, /Anonymized/);
    const converted = await TrackingEvent.collection.findOne({ campaignId, ipHash: hashIp('192.0.2.10') });
    assert.ok(converted);
    assert.equal(converted.ip, undefined);
    assert.equal(await TrackingEvent.collection.countDocuments({ campaignId, ip: { $type: 'string' } }), 0);

    assert.match(run().stdout, /0 event\(s\) still hold a raw IP/);
  });
});
