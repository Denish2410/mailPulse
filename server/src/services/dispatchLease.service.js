import crypto from 'node:crypto';
import Campaign from '../models/Campaign.js';

/**
 * Dispatch leases: which application instance is currently sending a campaign.
 *
 * With several instances, "no dispatch is running in THIS process" no longer means a campaign
 * is stalled: another instance may be sending it. Every campaign in 'sending' therefore carries
 * a lease (`dispatchLeaseOwner` + `dispatchLeaseUntil`) that its owner renews with a heartbeat.
 * Recovery (startup resume and the watchdog) only touches campaigns whose lease is free or
 * expired, so a live dispatch is never failed by a peer, while a crashed instance's campaigns
 * are picked up as soon as its lease runs out.
 *
 * Leases need no extra infrastructure: they live on the Campaign document and are taken with one
 * atomic MongoDB update. Delivery claiming was already atomic, so at-most-once still holds even
 * in the worst case of two instances briefly working one campaign.
 */

export const DEFAULT_LEASE_MS = 60 * 1000;
const MIN_LEASE_MS = 3000;

/** Identifies this process among all application instances. */
export const INSTANCE_ID = crypto.randomUUID();

/**
 * @param {object} [env=process.env]
 * @returns {number} Lease length in ms (CAMPAIGN_LEASE_MS, default 60s, minimum 3s)
 */
export const getLeaseMs = (env = process.env) => {
  const value = Number(String(env.CAMPAIGN_LEASE_MS ?? '').trim());
  return Number.isInteger(value) && value >= MIN_LEASE_MS ? value : DEFAULT_LEASE_MS;
};

/** Mongo `$set` fields that make this instance the lease holder from `now`. */
export const leaseFields = (now = Date.now(), leaseMs = getLeaseMs()) => ({
  dispatchLeaseOwner: INSTANCE_ID,
  dispatchLeaseUntil: new Date(now + leaseMs),
});

/** Mongo `$unset` fields that clear a lease. */
export const LEASE_UNSET = { dispatchLeaseOwner: '', dispatchLeaseUntil: '' };

/**
 * Takes or renews the lease for a campaign that is in 'sending'. Succeeds when the lease is
 * free (never set, or expired) or already ours; fails while another instance holds it.
 *
 * @param {import('mongoose').Types.ObjectId|string} campaignId
 * @param {{ now?: number, leaseMs?: number }} [options]
 * @returns {Promise<boolean>}
 */
export const acquireLease = async (campaignId, { now = Date.now(), leaseMs = getLeaseMs() } = {}) => {
  const result = await Campaign.updateOne(
    {
      _id: campaignId,
      status: 'sending',
      $or: [
        { dispatchLeaseUntil: null },
        { dispatchLeaseUntil: { $lte: new Date(now) } },
        { dispatchLeaseOwner: INSTANCE_ID },
      ],
    },
    { $set: leaseFields(now, leaseMs) }
  );
  return result.matchedCount > 0;
};

/**
 * Releases this instance's lease on one campaign (no-op when it is not ours).
 */
export const releaseLease = (campaignId) =>
  Campaign.updateOne({ _id: campaignId, dispatchLeaseOwner: INSTANCE_ID }, { $unset: LEASE_UNSET });

/**
 * Releases every lease this instance still holds, so peers can resume its campaigns at once
 * (called during graceful shutdown).
 */
export const releaseAllLeases = () =>
  Campaign.updateMany({ dispatchLeaseOwner: INSTANCE_ID }, { $unset: LEASE_UNSET });

/**
 * Keeps the lease alive while a dispatch runs. Renews every third of the lease length; when a
 * renewal finds another instance holding the lease, `onLost` is called once and the heartbeat
 * stops. Database hiccups are tolerated: the lease is only treated as lost on a definite "held by
 * someone else" answer.
 *
 * @param {import('mongoose').Types.ObjectId|string} campaignId
 * @param {{ onLost: () => void, leaseMs?: number }} options
 * @returns {() => void} Stops the heartbeat
 */
export const startLeaseHeartbeat = (campaignId, { onLost, leaseMs = getLeaseMs() }) => {
  let running = true;
  const timer = setInterval(async () => {
    if (!running) return;
    try {
      const stillOurs = await acquireLease(campaignId, { leaseMs });
      if (!stillOurs && running) {
        running = false;
        clearInterval(timer);
        onLost();
      }
    } catch {
      // Could not reach the database this tick; try again on the next one
    }
  }, Math.max(1000, Math.floor(leaseMs / 3)));
  timer.unref?.();

  return () => {
    running = false;
    clearInterval(timer);
  };
};
