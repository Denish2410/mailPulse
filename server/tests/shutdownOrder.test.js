/**
 * Shutdown order: the scheduled-campaign poller is stopped (and its in-flight poll awaited) BEFORE
 * the dispatches are stopped, and both before MongoDB is closed. A poll that is locking a campaign
 * and generating its deliveries therefore completes with the database open, and the dispatch it
 * starts is part of the set the dispatch stop awaits.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config();

import { isolatedMongoUri } from './helpers/isolatedDb.js';

process.env.MONGODB_URI = isolatedMongoUri('shutdownorder');
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET =
  process.env.JWT_SECRET || 'deterministic_test_jwt_secret_min_32_characters!';
delete process.env.SMTP_HOST;

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import { createShutdownHandler } from '../src/server.js';
import User from '../src/models/User.js';
import Contact from '../src/models/Contact.js';
import Campaign from '../src/models/Campaign.js';
import { installAutoSender } from './helpers/sender.js';
installAutoSender(Campaign);
import Delivery from '../src/models/Delivery.js';
import { connectDB } from '../src/config/db.js';
import { createEmailService, createMockTransport } from '../src/services/email.service.js';
import {
  startCampaignScheduler,
  stopCampaignScheduler,
} from '../src/services/campaignScheduler.service.js';
import {
  stopAllDispatches,
  resetDispatcherState,
  isDispatchActive,
} from '../src/services/campaignDispatch.service.js';

const quiet = { log() {}, warn() {}, error() {} };

describe('Shutdown order (no DB)', () => {
  it('stops the scheduler, then the dispatches, then closes MongoDB, then exits 0', async () => {
    const order = [];
    const mockMongoose = {
      connection: {
        readyState: 1,
        close: async () => {
          order.push('mongodb');
          mockMongoose.connection.readyState = 0;
        },
      },
    };
    let exitCode = null;
    const shutdown = createShutdownHandler({
      serverGetter: () => null,
      mongooseInstance: mockMongoose,
      timeoutMs: 2000,
      exitFn: (code) => {
        order.push(`exit:${code}`);
        exitCode = code;
      },
      logger: quiet,
      stopScheduler: async () => {
        order.push('scheduler:start');
        await new Promise((resolve) => setTimeout(resolve, 50)); // an in-flight poll
        order.push('scheduler:done');
      },
      stopDispatches: async () => {
        order.push('dispatches:start');
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push('dispatches:done');
      },
    });

    await shutdown('SIGTERM');
    assert.deepEqual(order, ['scheduler:start', 'scheduler:done', 'dispatches:start', 'dispatches:done', 'mongodb', 'exit:0']);
    assert.equal(exitCode, 0);
  });
});

describe('Shutdown during an in-flight scheduler poll (real scheduler and dispatcher)', () => {
  let isDbConnected = false;
  let owner;

  before(async () => {
    try {
      await connectDB();
      isDbConnected = true;
      await Promise.all([User.init(), Contact.init(), Campaign.init(), Delivery.init()]);
      owner = await User.create({ name: 'Shutdown Owner', email: `sd-${Date.now()}@example.com`, passwordHash: 'x'.repeat(20) });
    } catch (err) {
      console.warn(`[Shutdown order tests] MongoDB unavailable: ${err.message}`);
    }
  });

  after(async () => {
    resetDispatcherState();
    if (isDbConnected) {
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  });

  it('a poll generating deliveries finishes, and its dispatch is stopped and released, before the database closes', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const contacts = await Contact.insertMany(
      Array.from({ length: 4 }, (_, i) => ({ userId: owner._id, name: `Due ${i}`, email: `due${i}-${new mongoose.Types.ObjectId()}@example.com` }))
    );
    const campaign = await Campaign.create({
      userId: owner._id,
      name: 'Due at shutdown',
      subject: 'Hello',
      textContent: 'Body',
      htmlContent: '<p>Body</p>',
      status: 'scheduled',
      scheduledAt: new Date(Date.now() - 1000),
      recipientIds: contacts.map((c) => c._id),
    });

    // Slow delivery generation so the poll is still in flight when the shutdown starts
    const realInsertMany = Delivery.insertMany.bind(Delivery);
    let generationStarted;
    const started = new Promise((resolve) => (generationStarted = resolve));
    t.mock.method(Delivery, 'insertMany', async (...args) => {
      generationStarted();
      await new Promise((resolve) => setTimeout(resolve, 300));
      return realInsertMany(...args);
    });

    const transport = createMockTransport();
    const emailService = createEmailService({ transport, from: 'MailPulse <no-reply@example.test>' });
    startCampaignScheduler({ emailService, intervalMs: 20, logger: quiet });
    await started;

    const events = [];
    let dbOpenWhenSchedulerDone = null;
    let activeWhenDispatchesDone = null;
    const fakeMongoose = {
      connection: {
        readyState: 1,
        close: async () => {
          events.push('mongodb');
          fakeMongoose.connection.readyState = 0;
        },
      },
    };
    const shutdown = createShutdownHandler({
      serverGetter: () => null,
      mongooseInstance: fakeMongoose,
      timeoutMs: 10_000,
      exitFn: (code) => events.push(`exit:${code}`),
      logger: quiet,
      stopScheduler: async () => {
        await stopCampaignScheduler();
        dbOpenWhenSchedulerDone = mongoose.connection.readyState === 1;
        events.push('scheduler');
      },
      stopDispatches: async () => {
        await stopAllDispatches();
        activeWhenDispatchesDone = isDispatchActive(campaign._id);
        events.push('dispatches');
      },
    });

    await shutdown('SIGTERM');
    t.mock.restoreAll();

    assert.deepEqual(events, ['scheduler', 'dispatches', 'mongodb', 'exit:0']);
    assert.equal(dbOpenWhenSchedulerDone, true, 'the in-flight poll finished while MongoDB was open');
    assert.equal(activeWhenDispatchesDone, false, "the poll's dispatch was awaited by the dispatch stop");

    // The dispatch may have sent some (or all) recipients before the stop; what matters is that
    // nothing was left half-done: generation complete, nothing in flight, every send recorded.
    const stored = await Campaign.findById(campaign._id).lean();
    assert.ok(['sending', 'sent'].includes(stored.status), `accepted, not lost (status ${stored.status})`);
    assert.equal(stored.dispatchManifestCount, 4);
    assert.equal(await Delivery.countDocuments({ campaignId: campaign._id }), 4, 'generation completed');
    assert.equal(await Delivery.countDocuments({ campaignId: campaign._id, status: 'processing' }), 0, 'no send left in flight');
    assert.equal(await Delivery.countDocuments({ campaignId: campaign._id, status: 'sent' }), transport.count, 'every send recorded');
    if (stored.status === 'sending') {
      assert.ok(stored.dispatchLeaseUntil <= new Date(), 'its lease was released for the next owner');
    }
  });
});
