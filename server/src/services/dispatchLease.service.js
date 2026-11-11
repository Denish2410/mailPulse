import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import Campaign from '../models/Campaign.js';

/**
 * Dispatch leases: which application instance is currently sending a campaign.
 *
 * With several instances, "no dispatch is running in THIS process" no longer means a campaign
 * is stalled: another instance may be sending it. Every campaign in 'sending' therefore carries
 * a lease that its owner keeps renewing. Recovery (startup resume and the watchdog) only takes
 * campaigns whose lease is free or expired.
 *
 * REQUIREMENTS AND SEMANTICS
 * - MongoDB >= 4.2. Every lease decision (is it free? is it expired? when does it end?) is made by
 *   the database using its own clock (`$$NOW` inside atomic update pipelines). Application server
 *   clocks are never used for lease correctness, so a host with a wrong clock cannot take a live
 *   lease or hold a dead one.
 * - Ownership identity is the pair (owner, epoch). `dispatchLeaseOwner` is this process
 *   (INSTANCE_ID, for diagnostics); `dispatchLeaseEpoch` is a counter that increases by one every
 *   time ownership changes hands. A worker keeps the epoch it was granted, and every check or
 *   update it makes is conditional on it, so a stale worker is recognised by a different epoch
 *   even if the same process later holds the lease again. The epoch is never reset.
 * - Acquisition succeeds only when the lease is absent, released or expired (server time) and
 *   exactly one of several concurrent callers wins (single atomic update).
 * - TAKEOVER ORDER: a taker first reads the expired lease and computes the next epoch, then runs
 *   `beforeAcquire` (the dispatcher uses it to raise the `fence` of every pending delivery to that
 *   epoch), and only then performs the atomic acquire. A failure in that step means the lease is
 *   NOT acquired. See campaignDispatch.service.js for why this closes the stale-claim race.
 * - Renewal is STRICT: it succeeds only for the matching owner AND epoch AND only while the lease
 *   is still unexpired (database time). An expired lease can never be revived, even if nobody has
 *   taken it yet; the worker that lost it stays fenced.
 *
 * SELF-FENCING
 * A worker holds a LeaseSession. If it cannot confirm within the lease window that it still owns
 * the lease (renewal failed, the database was unreachable, or the process stalled), it fences
 * itself permanently: it stops claiming deliveries and never un-fences, even if the database comes
 * back. Local elapsed time (monotonic clock) is used only for this "I can no longer prove I own
 * it" decision, never to decide whether a lease has expired.
 *
 * WHAT THIS CANNOT GUARANTEE
 * MongoDB and SMTP are not one transaction. A worker may verify its lease, stall, lose the lease,
 * and still complete an SMTP send it had already started. Fencing bounds this to the deliveries
 * that were already past their last check (at most the configured concurrency) and stops all new
 * claims; it cannot close that window. Per-recipient at-most-once comes from the atomic delivery
 * claim and the "never resend an uncertain delivery" rule, not from the lease.
 */

export const DEFAULT_LEASE_MS = 60 * 1000;
const MIN_LEASE_MS = 3000;

/** Identifies this process among all application instances (diagnostics only; see epoch). */
export const INSTANCE_ID = crypto.randomUUID();

/**
 * @param {object} [env=process.env]
 * @returns {number} Lease length in ms (CAMPAIGN_LEASE_MS, default 60s, minimum 3s)
 */
export const getLeaseMs = (env = process.env) => {
  const value = Number(String(env.CAMPAIGN_LEASE_MS ?? '').trim());
  return Number.isInteger(value) && value >= MIN_LEASE_MS ? value : DEFAULT_LEASE_MS;
};

/**
 * Fields for a `$set` pipeline stage that make this process the owner under a NEW epoch, with the
 * lease ending `leaseMs` after MongoDB's current time. Use only inside an update pipeline.
 */
export const leaseTakeoverFields = (leaseMs = getLeaseMs()) => ({
  dispatchLeaseEpoch: { $add: [{ $ifNull: ['$dispatchLeaseEpoch', 0] }, 1] },
  dispatchLeaseOwner: INSTANCE_ID,
  dispatchLeaseUntil: { $add: ['$$NOW', leaseMs] },
});

/**
 * Mongo `$unset` fields that clear a lease. The epoch is deliberately NOT cleared: it must keep
 * increasing across releases so a stale worker can never match a later acquisition.
 */
export const LEASE_UNSET = { dispatchLeaseOwner: '', dispatchLeaseUntil: '' };

/** Filter fragment: the lease is absent/released, or has expired according to MongoDB's clock. */
const LEASE_IS_FREE = {
  $or: [{ dispatchLeaseUntil: null }, { $expr: { $lte: ['$dispatchLeaseUntil', '$$NOW'] } }],
};

/**
 * Filter fragment: the stored epoch is exactly `epoch`. An absent or null epoch (a campaign that
 * has never been leased, or one from before epochs existed) is epoch 0; `$in: [null, 0]` matches a
 * missing field, a null and a literal 0.
 */
const epochIs = (epoch) => (epoch === 0 ? { dispatchLeaseEpoch: { $in: [null, 0] } } : { dispatchLeaseEpoch: epoch });

/**
 * Takes the lease of a campaign in 'sending' when it is free or expired (server time). The final
 * step is one atomic update: of several concurrent callers exactly one wins, and the epoch
 * increases by one.
 *
 * Takeover sequence (used when `beforeAcquire` is given):
 *   1. read the campaign if its lease is free/expired by DATABASE time and remember the EXACT
 *      epoch observed (absent/null counts as 0);
 *   2. target epoch = observed + 1;
 *   3. `await beforeAcquire({ nextEpoch })`, which must complete successfully. If it throws, the
 *      error propagates and NOTHING is acquired;
 *   4. the atomic acquire, a compare-and-swap: it only matches while the epoch is STILL exactly the
 *      one observed in step 1 AND the lease is still free/expired by database time. It then sets
 *      epoch = observed + 1.
 * Why the compare-and-swap: the fence applied in step 3 targets observed + 1. If another taker
 * changed the epoch meanwhile (took the lease and let it lapse), an acquire without the
 * comparison would grant a HIGHER epoch than the one the deliveries were fenced to, leaving a
 * window in which the intermediate (now stale) owner could still claim. With it, such a taker gets
 * null, changes nothing, and simply retries from a fresh read at its next sweep. Several takers
 * may run step 3 concurrently; only one wins step 4.
 *
 * The epoch granted on success therefore always equals `nextEpoch`, the value the deliveries
 * were fenced to.
 *
 * @param {import('mongoose').Types.ObjectId|string} campaignId
 * @param {{ leaseMs?: number, beforeAcquire?: (info: { nextEpoch: number }) => Promise<void> }} [options]
 * @returns {Promise<{ epoch: number }|null>} The granted epoch, or null while another owner holds it
 *   or after losing the compare-and-swap
 */
export const acquireLease = async (campaignId, { leaseMs = getLeaseMs(), beforeAcquire } = {}) => {
  let observedEpoch = null;
  if (beforeAcquire) {
    const eligible = await Campaign.findOne({ _id: campaignId, status: 'sending', ...LEASE_IS_FREE })
      .select('dispatchLeaseEpoch')
      .lean();
    if (!eligible) return null;
    observedEpoch = eligible.dispatchLeaseEpoch ?? 0;
    await beforeAcquire({ nextEpoch: observedEpoch + 1 });
  }

  const doc = await Campaign.findOneAndUpdate(
    {
      _id: campaignId,
      status: 'sending',
      ...LEASE_IS_FREE,
      ...(observedEpoch === null ? {} : epochIs(observedEpoch)),
    },
    [{ $set: leaseTakeoverFields(leaseMs) }],
    { new: true, projection: { dispatchLeaseEpoch: 1 } }
  ).lean();
  return doc ? { epoch: doc.dispatchLeaseEpoch } : null;
};

/**
 * Extends the lease (server time). STRICT: only for the exact owner and epoch that were granted it,
 * and only while the lease is still unexpired by database time. An expired lease is never revived,
 * even when nobody has taken it yet (that is what lets a taker fence deliveries safely first).
 *
 * @returns {Promise<boolean>} False when the lease is no longer ours: another epoch, another owner,
 *   released, expired, or the campaign left 'sending'
 */
export const renewLease = async (campaignId, epoch, { leaseMs = getLeaseMs() } = {}) => {
  const result = await Campaign.updateOne(
    {
      _id: campaignId,
      status: 'sending',
      dispatchLeaseOwner: INSTANCE_ID,
      dispatchLeaseEpoch: epoch,
      $expr: { $gt: ['$dispatchLeaseUntil', '$$NOW'] },
    },
    [{ $set: { dispatchLeaseUntil: { $add: ['$$NOW', leaseMs] } } }]
  );
  return result.matchedCount > 0;
};

/**
 * The indexed read performed before every delivery claim: is this exact (owner, epoch) still the
 * current, unexpired (server time) lease of a campaign that is still sending?
 *
 * @returns {Promise<boolean>}
 */
export const verifyLease = async (campaignId, epoch) => {
  const found = await Campaign.findOne({
    _id: campaignId,
    status: 'sending',
    dispatchLeaseOwner: INSTANCE_ID,
    dispatchLeaseEpoch: epoch,
    $expr: { $gt: ['$dispatchLeaseUntil', '$$NOW'] },
  })
    .select('_id')
    .lean();
  return Boolean(found);
};

/**
 * Pipeline that releases a lease: it ends NOW (MongoDB time) and the owner is cleared. A released
 * lease is simply an expired one, so the normal "expired" rules apply: any instance may take it at
 * once, and the watchdog lists it at its next sweep. The epoch is kept.
 */
const RELEASE_PIPELINE = [{ $set: { dispatchLeaseUntil: '$$NOW' } }, { $unset: 'dispatchLeaseOwner' }];

/**
 * Releases a lease, but only if it is still the given epoch's (a no-op, never an error, when a
 * newer owner holds it).
 */
export const releaseLease = (campaignId, epoch) =>
  Campaign.updateOne(
    { _id: campaignId, status: 'sending', dispatchLeaseOwner: INSTANCE_ID, dispatchLeaseEpoch: epoch },
    RELEASE_PIPELINE
  );

/**
 * Releases every lease this instance still holds (graceful shutdown), so a peer's watchdog can
 * recover those campaigns at its next sweep instead of waiting for the stall timeout.
 */
export const releaseAllLeases = () =>
  Campaign.updateMany({ dispatchLeaseOwner: INSTANCE_ID, status: 'sending' }, RELEASE_PIPELINE);

/**
 * One worker's grip on one campaign's lease: its epoch, a heartbeat that keeps the lease alive, and
 * the self-fencing rule (see the file header). Once fenced it stays fenced.
 */
export class LeaseSession {
  /**
   * @param {import('mongoose').Types.ObjectId|string} campaignId
   * @param {number} epoch - The epoch granted to this worker
   * @param {object} options
   * @param {number} options.confirmedAt - Monotonic ms (performance.now) captured BEFORE the request
   *   that granted or last renewed the lease, so the window below is conservative
   * @param {number} [options.leaseMs]
   * @param {number} [options.heartbeatMs]
   * @param {() => number} [options.now] - Monotonic clock (injectable for tests)
   * @param {(reason: string) => void} [options.onFenced]
   * @param {Function} [options.renew] - Renewal call (injectable for tests); defaults to renewLease
   */
  constructor(
    campaignId,
    epoch,
    { confirmedAt, leaseMs = getLeaseMs(), heartbeatMs, now = () => performance.now(), onFenced, renew = renewLease } = {}
  ) {
    this.campaignId = campaignId;
    this.epoch = epoch;
    this.leaseMs = leaseMs;
    this.heartbeatMs = heartbeatMs ?? Math.max(1000, Math.floor(leaseMs / 3));
    // The lease is only treated as ours while the last confirmation is younger than this. The
    // margin leaves room for the stall to be noticed before the database could hand it to a peer.
    this.validWindowMs = leaseMs - Math.floor(leaseMs / 4);
    this.now = now;
    this.renew = renew;
    this.lastConfirmedAt = confirmedAt ?? now();
    this.onFenced = onFenced;
    this.fenceReason = null;
    this.timer = null;
    this.tickRunning = false;
  }

  /** Starts the renewal heartbeat (does not keep the process alive). */
  start() {
    if (this.timer || this.fenceReason) return this;
    this.timer = setInterval(() => {
      this.#tick();
    }, this.heartbeatMs);
    this.timer.unref?.();
    return this;
  }

  /** Stops the heartbeat. Does not release the lease. */
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * True once this worker may no longer claim work: the lease was lost, ownership could not be
   * verified, or the last confirmation is older than the lease window. Never reverts to false.
   */
  isFenced() {
    if (!this.fenceReason && this.now() - this.lastConfirmedAt >= this.validWindowMs) {
      this.#fence('unconfirmed');
    }
    return Boolean(this.fenceReason);
  }

  get fencedBecause() {
    return this.fenceReason;
  }

  /**
   * Fences this worker for a reason it discovered itself, e.g. every remaining delivery refuses
   * its epoch because a newer owner raised their fence. Permanent, like every other fence.
   */
  fenceNow(reason) {
    this.#fence(reason);
  }

  /**
   * Called before every delivery claim: one indexed database read confirming this exact owner and
   * epoch still hold an unexpired lease. A failed or impossible check fences the worker for good.
   *
   * @returns {Promise<boolean>} True only when it is safe to claim one more delivery
   */
  async canClaim() {
    if (this.isFenced()) return false;
    try {
      if (!(await verifyLease(this.campaignId, this.epoch))) {
        this.#fence('lost');
        return false;
      }
    } catch {
      this.#fence('verification-failed');
      return false;
    }
    return !this.isFenced();
  }

  /**
   * Gives the lease up (conditional on our epoch, so it can never disturb a newer owner) and stops
   * the heartbeat. Bounded in time so shutdown cannot hang on an unreachable database.
   */
  async release({ timeoutMs = 2000 } = {}) {
    this.stop();
    await Promise.race([
      releaseLease(this.campaignId, this.epoch).catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, timeoutMs).unref?.()),
    ]);
  }

  #fence(reason) {
    if (this.fenceReason) return;
    this.fenceReason = reason;
    this.stop();
    try {
      this.onFenced?.(reason);
    } catch {
      // a logging callback must never break fencing
    }
  }

  async #tick() {
    if (this.tickRunning || this.isFenced()) return;
    this.tickRunning = true;
    const startedAt = this.now();
    try {
      if (await this.renew(this.campaignId, this.epoch, { leaseMs: this.leaseMs })) {
        // The lease now runs at least until startedAt + leaseMs: confirm from the START of the call
        if (!this.fenceReason) this.lastConfirmedAt = startedAt;
      } else {
        this.#fence('lost');
      }
    } catch {
      // Could not confirm this time. Not fatal yet: if confirmation stays impossible the window in
      // isFenced() fences the worker. A recovered database never un-fences it.
    } finally {
      this.tickRunning = false;
    }
  }
}

/**
 * Acquires a campaign's lease and returns the worker's session, or null while another owner holds it.
 * `beforeAcquire` (see acquireLease) runs before ownership changes; if it throws, so does this.
 *
 * @param {import('mongoose').Types.ObjectId|string} campaignId
 * @param {{ leaseMs?: number, heartbeatMs?: number, now?: () => number, onFenced?: Function, renew?: Function, beforeAcquire?: Function }} [options]
 * @returns {Promise<LeaseSession|null>}
 */
export const acquireLeaseSession = async (campaignId, options = {}) => {
  const { beforeAcquire, ...sessionOptions } = options;
  const now = sessionOptions.now ?? (() => performance.now());
  const confirmedAt = now(); // before the request: conservative
  const acquired = await acquireLease(campaignId, { leaseMs: sessionOptions.leaseMs, beforeAcquire });
  if (!acquired) return null;
  return new LeaseSession(campaignId, acquired.epoch, { ...sessionOptions, confirmedAt, now }).start();
};

/**
 * Wraps a lease that was granted as part of another atomic update (the draft -> sending
 * transition), so the worker starts with the right epoch and a running heartbeat.
 */
export const adoptLease = (campaignId, epoch, options = {}) =>
  new LeaseSession(campaignId, epoch, options).start();
