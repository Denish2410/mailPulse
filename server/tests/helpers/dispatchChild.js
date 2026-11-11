/**
 * Child-process harness for the multi-process lease tests (NOT a test file).
 *
 * Each child is a real, separate Node.js process running the real dispatch and lease code against
 * the database named by MONGODB_URI. It never sends email: its transport is a mock that records
 * "sends" into a collection. The parent drives it over Node's IPC channel and can pause it with
 * SIGSTOP/SIGCONT, cut its database connection and skew its clock.
 */
import mongoose from 'mongoose';

// Fail fast instead of queueing operations while disconnected (this is how an outage is simulated)
mongoose.set('bufferCommands', false);

const uri = process.env.MONGODB_URI;
await mongoose.connect(uri);

const dispatch = await import('../../src/services/campaignDispatch.service.js');
const lease = await import('../../src/services/dispatchLease.service.js');
const { createEmailService } = await import('../../src/services/email.service.js');
const { default: Delivery } = await import('../../src/models/Delivery.js');

const quiet = { log() {}, warn() {}, error() {} };
const sessions = new Map();
let gate = null;

/** Mock transport: optionally blocks every send until the parent opens the gate; records sends. */
const makeEmailService = ({ gated = false, delayMs = 0 } = {}) => {
  if (gated) {
    let open;
    gate = { promise: new Promise((resolve) => (open = resolve)), open };
  }
  const transport = {
    name: 'child-mock',
    async sendMail(message) {
      // Barrier for tests: the worker is now INSIDE the transport call (past every pre-send check)
      process.send({ event: 'in-send', to: message.to });
      if (gate) await gate.promise;
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      await mongoose.connection.collection('probe_sends').insertOne({ to: message.to, pid: process.pid, at: new Date() });
      return { messageId: `<child-${process.pid}-${Date.now()}@mock.test>` };
    },
  };
  return createEmailService({ transport, from: 'Probe <probe@mailpulse.test>' });
};

const announceWhenDone = (campaignId) => {
  dispatch.waitForCampaignDispatch(campaignId).then(() => process.send({ event: 'dispatch-finished', campaignId: String(campaignId) }));
};

const handlers = {
  info: async () => ({ pid: process.pid, instanceId: lease.INSTANCE_ID }),

  /** Take a campaign's lease and keep it (heartbeat running). */
  acquire: async ({ campaignId, startAt }) => {
    if (startAt) await new Promise((resolve) => setTimeout(resolve, Math.max(0, startAt - Date.now())));
    const session = await lease.acquireLeaseSession(campaignId);
    if (session) sessions.set(campaignId, session);
    return { acquired: Boolean(session), epoch: session?.epoch ?? null };
  },
  sessionState: async ({ campaignId }) => {
    const session = sessions.get(campaignId);
    return { exists: Boolean(session), fenced: session ? session.isFenced() : null, reason: session?.fencedBecause ?? null };
  },
  releaseSession: async ({ campaignId }) => {
    await sessions.get(campaignId)?.release();
    return true;
  },

  startDispatch: async ({ campaignId, gated, delayMs, concurrency = 1 }) => {
    const emailService = makeEmailService({ gated, delayMs });
    dispatch.scheduleCampaignProcessing(campaignId, { emailService, concurrency, logger: quiet });
    announceWhenDone(campaignId);
    return true;
  },
  recover: async ({ campaignId, gated, delayMs, concurrency = 1, failFencing = false, startAt }) => {
    if (startAt) await new Promise((resolve) => setTimeout(resolve, Math.max(0, startAt - Date.now())));
    const emailService = makeEmailService({ gated, delayMs });
    // Optionally make the fencing step fail (once), to prove a takeover then changes nothing
    const realUpdateMany = Delivery.updateMany.bind(Delivery);
    let failed = false;
    const errors = [];
    if (failFencing) {
      Delivery.updateMany = (filter, update, options) => {
        if (update?.$max?.fence !== undefined && !failed) {
          failed = true;
          return Promise.reject(new Error('simulated fencing failure'));
        }
        return realUpdateMany(filter, update, options);
      };
    }
    const logger = { log() {}, warn() {}, error: (m) => errors.push(m) };
    let outcome;
    try {
      outcome = await dispatch.recoverCampaign(campaignId, { emailService, concurrency, logger });
    } finally {
      Delivery.updateMany = realUpdateMany;
    }
    announceWhenDone(campaignId);
    return { outcome, errors };
  },
  reap: async ({ stallTimeoutMs, delayMs, campaignId }) => {
    const emailService = makeEmailService({ delayMs });
    const recovered = await dispatch.reapStalledCampaigns({ emailService, logger: quiet, stallTimeoutMs });
    if (campaignId) announceWhenDone(campaignId); // the sweep starts the dispatch itself
    return { recovered };
  },
  /** Take over a campaign exactly as recovery does: fence pending deliveries, THEN acquire. */
  takeover: async ({ campaignId, startAt }) => {
    if (startAt) await new Promise((resolve) => setTimeout(resolve, Math.max(0, startAt - Date.now())));
    const session = await lease.acquireLeaseSession(campaignId, { beforeAcquire: dispatch.fenceDeliveriesBeforeTakeover(campaignId) });
    if (session) sessions.set(campaignId, session);
    return { acquired: Boolean(session), epoch: session?.epoch ?? null };
  },
  /**
   * A takeover that freezes itself (SIGSTOP) at a chosen point: 'before-fencing' = after it has
   * decided the next epoch but before touching any delivery; 'after-fencing' = deliveries fenced,
   * lease not yet acquired. The result arrives as a 'takeover-finished' event after SIGCONT.
   */
  takeoverFrozen: async ({ campaignId, at }) => {
    const freeze = async (point) => {
      await new Promise((resolve) => process.send({ event: point }, resolve));
      process.kill(process.pid, 'SIGSTOP');
    };
    (async () => {
      const fencer = dispatch.fenceDeliveriesBeforeTakeover(campaignId);
      const session = await lease.acquireLeaseSession(campaignId, {
        beforeAcquire: async (info) => {
          if (at === 'before-fencing') await freeze('in-takeover-before-fencing');
          await fencer(info);
          if (at === 'after-fencing') await freeze('in-takeover-after-fencing');
        },
      });
      if (session) sessions.set(campaignId, session);
      process.send({ event: 'takeover-finished', acquired: Boolean(session), epoch: session?.epoch ?? null });
    })().catch((error) => process.send({ event: 'takeover-error', error: error.message }));
    return true;
  },
  /**
   * The exact stale-claim race: verify the lease, freeze BETWEEN that verification and the delivery
   * claim, then (after SIGCONT) attempt the claim. The local clock is frozen and no heartbeat runs,
   * so this worker cannot notice a takeover by itself (as after a VM freeze/suspend).
   */
  claimFrozen: async ({ campaignId }) => {
    (async () => {
      const session = await lease.acquireLeaseSession(campaignId, { now: () => 0, heartbeatMs: 3_600_000 });
      sessions.set(campaignId, session);
      const fence = {
        epoch: session.epoch,
        isFenced: () => session.isFenced(),
        fenceNow: (reason) => session.fenceNow(reason),
        async canClaim() {
          const ok = await session.canClaim(); // the verification succeeds: we ARE the owner right now
          await new Promise((resolve) => process.send({ event: 'verified', epoch: session.epoch }, resolve));
          process.kill(process.pid, 'SIGSTOP'); // frozen between verification and claim
          return ok;
        },
      };
      const emailService = makeEmailService({});
      const returned = await dispatch.processNextDelivery(campaignId, { subject: 'S', text: 'T', html: '<p>T</p>' }, emailService, quiet, fence);
      process.send({ event: 'claim-finished', returned, fenced: session.isFenced(), reason: session.fencedBecause });
    })().catch((error) => process.send({ event: 'claim-error', error: error.message }));
    return true;
  },
  /**
   * A worker that holds a real lease and CLAIMS one delivery, but whose fence trips before the SMTP
   * call (isFenced: false right after the claim, true just before sending). Nothing must be sent
   * and the delivery must stay 'processing'. Reported as a 'claim-tripped' event.
   */
  claimThenTrip: async ({ campaignId }) => {
    const session = await lease.acquireLeaseSession(campaignId, { heartbeatMs: 3_600_000 });
    sessions.set(campaignId, session);
    let calls = 0;
    const fence = {
      epoch: session.epoch,
      canClaim: () => session.canClaim(),
      isFenced: () => calls++ >= 1,
      fenceNow: (reason) => session.fenceNow(reason),
    };
    const emailService = makeEmailService({});
    const returned = await dispatch.processNextDelivery(campaignId, { subject: 'S', text: 'T', html: '<p>T</p>' }, emailService, quiet, fence);
    process.send({ event: 'claim-tripped', returned, epoch: session.epoch });
    return true;
  },
  /** The live owner claims and sends exactly one delivery through its existing session. */
  claimWithSession: async ({ campaignId }) => {
    const session = sessions.get(campaignId);
    const emailService = makeEmailService({});
    const returned = await dispatch.processNextDelivery(campaignId, { subject: 'S', text: 'T', html: '<p>T</p>' }, emailService, quiet, session);
    return { returned, fenced: session.isFenced(), reason: session.fencedBecause };
  },
  openGate: async () => {
    gate?.open();
    return true;
  },
  stopAll: async () => {
    await dispatch.stopAllDispatches();
    return true;
  },
  /** finalizeCampaign as THIS process, claiming to hold `epoch` (it does not). */
  finalizeAs: async ({ campaignId, epoch }) => ({ finalized: Boolean(await dispatch.finalizeCampaign(campaignId, { epoch })) }),

  disconnect: async () => {
    await mongoose.connection.close();
    return true;
  },
  reconnect: async () => {
    await mongoose.connect(uri);
    return true;
  },
  /** Shift this process's wall clock. Lease decisions must not care (they use database time). */
  skewClock: async ({ ms }) => {
    const real = Date.now.bind(Date);
    Date.now = () => real() + ms;
    return true;
  },
};

process.on('message', async ({ id, cmd, args }) => {
  try {
    process.send({ id, ok: true, result: await handlers[cmd](args || {}) });
  } catch (error) {
    process.send({ id, ok: false, error: error?.message || String(error) });
  }
});

process.send({ event: 'ready' });
