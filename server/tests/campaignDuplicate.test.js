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

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import app from '../src/app.js';
import User from '../src/models/User.js';
import Contact from '../src/models/Contact.js';
import Campaign from '../src/models/Campaign.js';
import Delivery from '../src/models/Delivery.js';
import { connectDB } from '../src/config/db.js';
import { signAccessToken } from '../src/utils/token.js';
import { hashPassword } from '../src/services/password.service.js';

describe('Campaign duplicate API', () => {
  let server;
  let baseUrl;
  let isDbConnected = false;
  const prefix = `dup-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  let userOne;
  let userTwo;
  let tokenOne;
  let tokenTwo;
  let contact;

  const duplicate = (id, token = tokenOne) =>
    fetch(`${baseUrl}/api/v1/campaigns/${id}/duplicate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
      body: '{}',
    });
  const ids = () => [userOne._id, userTwo._id];

  before(async () => {
    try {
      await connectDB();
      isDbConnected = true;
    } catch (err) {
      console.warn(`[Duplicate Tests] MongoDB unavailable: ${err.message}`);
    }
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    if (isDbConnected) {
      const passwordHash = await hashPassword('StrongPassword123!');
      userOne = await User.create({ name: 'Dup One', email: `${prefix}-1@example.com`, passwordHash });
      userTwo = await User.create({ name: 'Dup Two', email: `${prefix}-2@example.com`, passwordHash });
      tokenOne = signAccessToken(userOne);
      tokenTwo = signAccessToken(userTwo);
      contact = await Contact.create({ userId: userOne._id, name: 'Alice', email: `${prefix}-a@example.com` });
    }
  });

  beforeEach(async () => {
    if (isDbConnected) {
      await Campaign.deleteMany({ userId: { $in: ids() } });
      await Delivery.deleteMany({ userId: { $in: ids() } });
    }
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (isDbConnected) {
      await Campaign.deleteMany({ userId: { $in: ids() } });
      await Delivery.deleteMany({ userId: { $in: ids() } });
      await Contact.deleteMany({ userId: { $in: ids() } });
      await User.deleteMany({ _id: { $in: ids() } });
      await mongoose.disconnect();
    }
  });

  it('copies content and recipients into a clean draft, leaving the original untouched', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const original = await Campaign.create({
      userId: userOne._id,
      name: 'Autumn Launch',
      subject: 'Hello {{firstName}}',
      textContent: 'Text body',
      htmlContent: '<p>HTML</p>',
      recipientIds: [contact._id],
      status: 'sent',
      sendStartedAt: new Date(),
      sendCompletedAt: new Date(),
      stats: { total: 1, sent: 1, failed: 0 },
    });
    await Delivery.create({ campaignId: original._id, userId: userOne._id, contactId: contact._id, email: contact.email, status: 'sent' });

    const res = await duplicate(original._id);
    assert.equal(res.status, 201);
    const copy = (await res.json()).data.campaign;
    assert.notEqual(copy.id, String(original._id));
    assert.equal(copy.name, 'Copy of Autumn Launch');
    assert.equal(copy.status, 'draft');
    assert.equal(copy.subject, 'Hello {{firstName}}');
    assert.equal(copy.textContent, 'Text body');
    assert.equal(copy.htmlContent, '<p>HTML</p>');
    assert.deepEqual(copy.recipientIds, [String(contact._id)]);
    assert.equal(copy.scheduledAt, null);
    assert.equal(copy.sendStartedAt, null);
    assert.deepEqual(copy.stats, { total: 0, sent: 0, failed: 0 });
    assert.equal(await Delivery.countDocuments({ campaignId: copy.id }), 0);

    const untouched = await Campaign.findById(original._id).lean();
    assert.equal(untouched.status, 'sent');
    assert.equal(untouched.name, 'Autumn Launch');
  });

  it('duplicates scheduled campaigns as unscheduled drafts and truncates long names', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const original = await Campaign.create({
      userId: userOne._id,
      name: 'N'.repeat(120),
      subject: 'S',
      status: 'scheduled',
      scheduledAt: new Date(Date.now() + 3600000),
    });
    const copy = (await (await duplicate(original._id)).json()).data.campaign;
    assert.equal(copy.status, 'draft');
    assert.equal(copy.scheduledAt, null);
    assert.equal(copy.name.length, 120);
    assert.ok(copy.name.startsWith('Copy of '));
  });

  it('enforces authentication, id validation and ownership', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const original = await Campaign.create({ userId: userOne._id, name: 'Private', subject: 'S' });
    assert.equal((await duplicate(original._id, null)).status, 401);
    assert.equal((await duplicate('not-an-id')).status, 400);
    assert.equal((await duplicate(original._id, tokenTwo)).status, 404);
    assert.equal(await Campaign.countDocuments({ userId: userTwo._id }), 0);
    assert.equal(await Campaign.countDocuments({ userId: userOne._id }), 1);
  });
});
