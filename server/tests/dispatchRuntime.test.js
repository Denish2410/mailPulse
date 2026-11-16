/**
 * The dispatch runtime module groups every background job that sends campaigns (startup resume,
 * watchdog, scheduler). These tests pin its behaviour so moving it out of the API process later
 * cannot silently change it: what it starts, that it is idempotent, that it resumes and schedules
 * real campaigns, and that it stops the scheduler before the dispatches.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config();

import { isolatedMongoUri } from './helpers/isolatedDb.js';

process.env.MONGODB_URI = isolatedMongoUri('dispatchruntime');
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET =
  process.env.JWT_SECRET || 'deterministic_test_jwt_secret_min_32_characters!';
process.env.CAMPAIGN_SCHEDULER_INTERVAL_MS = '1000';
delete process.env.SMTP_HOST;

import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import User from '../src/models/User.js';
import Contact from '../src/models/Contact.js';
import Campaign from '../src/models/Campaign.js';
import Delivery from '../src/models/Delivery.js';
import { connectDB } from '../src/config/db.js';
import { createEmailService, createMockTransport } from '../src/services/email.service.js';
import {
  startDispatchRuntime,
  stopDispatchRuntime,
  isDispatchRuntimeRunning,
} from '../src/services/dispatchRuntime.service.js';
import { isCampaignSchedulerRunning } from '../src/services/campaignScheduler.service.js';
import {
  resetDispatcherState,
  waitForCampaignDispatch,
} from '../src/services/campaignDispatch.service.js';
import { startServer } from '../src/server.js';
import { manifestFieldsFor } from './helpers/manifest.js';
import { waitFor } from './helpers/childHarness.js';

const quiet = { log() {}, warn() {}, error() {} };

describe('Dispatch runtime', () => {
  let isDbConnected = false;
  let owner;

  const makeContacts = (n) =>
    Contact.insertMany(
      Array.from({ length: n }, (_, i) => ({ userId: owner._id, name: `Runtime ${i}`, email: `rt${i}-${new mongoose.Types.ObjectId()}@example.com` }))
    );

  const mockService = () => {
    const transport = createMockTransport();
    return { transport, emailService: createEmailService({ transport, from: 'MailPulse <no-reply@example.test>' }) };
  };

  before(async () => {
    try {
      await connectDB();
      isDbConnected = true;
      await Promise.all([User.init(), Contact.init(), Campaign.init(), Delivery.init()]);
      owner = await User.create({ name: 'Runtime Owner', email: `rt-${Date.now()}@example.com`, passwordHash: 'x'.repeat(20) });
    } catch (err) {
      console.warn(`[Dispatch runtime tests] MongoDB unavailable: ${err.message}`);
    }
  });

  afterEach(async () => {
    await stopDispatchRuntime();
    resetDispatcherState();
    if (isDbConnected) {
      await Delivery.deleteMany({});
      await Campaign.deleteMany({});
      await Contact.deleteMany({});
    }
  });

  after(async () => {
    if (isDbConnected) {
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  });

  it('starts the scheduler, is idempotent, and stops cleanly', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const { emailService } = mockService();
    assert.equal(isDispatchRuntimeRunning(), false);
    assert.equal(isCampaignSchedulerRunning(), false);

    assert.equal(startDispatchRuntime({ emailService, logger: quiet }), true);
    assert.equal(startDispatchRuntime({ emailService, logger: quiet }), false, 'a second start does nothing');
    assert.equal(isDispatchRuntimeRunning(), true);
    assert.equal(isCampaignSchedulerRunning(), true);

    await stopDispatchRuntime();
    assert.equal(isDispatchRuntimeRunning(), false);
    assert.equal(isCampaignSchedulerRunning(), false);
  });

  it('resumes an orphaned campaign at start and dispatches a due scheduled campaign', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const { emailService, transport } = mockService();

    const orphanContacts = await makeContacts(2);
    const orphan = await Campaign.create({
      userId: owner._id,
      name: 'Orphan',
      subject: 'Hello',
      textContent: 'Body',
      status: 'sending',
      sendStartedAt: new Date(),
      recipientIds: orphanContacts.map((c) => c._id),
      dispatchLeaseOwner: 'dead',
      dispatchLeaseEpoch: 1,
      dispatchLeaseUntil: new Date(Date.now() - 5000),
      ...manifestFieldsFor(orphanContacts),
    });
    const dueContacts = await makeContacts(3);
    const due = await Campaign.create({
      userId: owner._id,
      name: 'Due',
      subject: 'Hello',
      textContent: 'Body',
      status: 'scheduled',
      scheduledAt: new Date(Date.now() - 1000),
      recipientIds: dueContacts.map((c) => c._id),
    });

    startDispatchRuntime({ emailService, logger: quiet });
    await waitFor(async () => (await Campaign.findById(orphan._id).lean()).status === 'sent', { label: 'orphan resumed', timeoutMs: 10000 });
    await waitFor(async () => (await Campaign.findById(due._id).lean()).status === 'sent', { label: 'due campaign sent', timeoutMs: 10000 });
    await waitForCampaignDispatch(due._id);

    assert.deepEqual(
      transport.sentEmails.map((m) => m.to).sort(),
      [...orphanContacts, ...dueContacts].map((c) => c.email).sort()
    );
  });

  it('stopping waits for an in-flight send and releases the lease; nothing is cancelled', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const contacts = await makeContacts(2);
    const inner = createMockTransport();
    let open;
    const gate = new Promise((resolve) => (open = resolve));
    let inSend;
    const sending = new Promise((resolve) => (inSend = resolve));
    const emailService = createEmailService({
      transport: {
        async sendMail(message) {
          inSend();
          await gate;
          return inner.sendMail(message);
        },
      },
      from: 'MailPulse <no-reply@example.test>',
    });
    const campaign = await Campaign.create({
      userId: owner._id,
      name: 'In flight at stop',
      subject: 'Hello',
      textContent: 'Body',
      status: 'scheduled',
      scheduledAt: new Date(Date.now() - 1000),
      recipientIds: contacts.map((c) => c._id),
    });

    startDispatchRuntime({ emailService, logger: quiet });
    await sending;
    const stopped = stopDispatchRuntime();
    await new Promise((resolve) => setTimeout(resolve, 100));
    open();
    await stopped;

    const deliveries = await Delivery.find({ campaignId: campaign._id }).lean();
    assert.equal(deliveries.length, 2);
    assert.equal(deliveries.filter((d) => d.status === 'processing').length, 0, 'the in-flight send was completed, not cancelled');
    assert.equal(deliveries.filter((d) => d.status === 'sent').length, inner.count);
    const stored = await Campaign.findById(campaign._id).lean();
    if (stored.status === 'sending') {
      assert.ok(stored.dispatchLeaseUntil <= new Date(), 'lease released for the next owner');
    }
  });

  it('startServer starts the runtime only when dispatches are enabled', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const noop = async () => {};

    const without = await startServer({ port: 0, connectDB: noop, exitFn: () => {}, resumeDispatches: false, validateConfig: false });
    try {
      assert.equal(isDispatchRuntimeRunning(), false);
      assert.equal(isCampaignSchedulerRunning(), false);
    } finally {
      await new Promise((resolve) => without.close(resolve));
    }

    const withRuntime = await startServer({ port: 0, connectDB: noop, exitFn: () => {}, resumeDispatches: true, validateConfig: false });
    try {
      assert.equal(isDispatchRuntimeRunning(), true);
      assert.equal(isCampaignSchedulerRunning(), true);
    } finally {
      await new Promise((resolve) => withRuntime.close(resolve));
      await stopDispatchRuntime();
    }
  });
});
