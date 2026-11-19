import SenderUsage from '../models/SenderUsage.js';
import { createSendThrottle } from './sendThrottle.service.js';

/**
 * Conservative per-sender limits for campaign mail sent through a customer's Gmail account.
 *
 * Google publishes sending ceilings for Gmail accounts. They are hard limits, NOT targets: a
 * mailbox that sends near them is far more likely to be throttled or flagged. MailPulse therefore
 * applies much lower limits of its own, per sender account:
 *
 *   - a daily cap (GMAIL_SENDER_DAILY_LIMIT, default 150, never above 400), counted per UTC day
 *     in MongoDB so it holds across worker processes. Every send ATTEMPT counts, including ones
 *     that ended uncertain or rejected, because Gmail may have counted them too;
 *   - an even pacing (GMAIL_SENDER_RATE_PER_MINUTE, default 10, never above 60) inside one
 *     process, on top of the global CAMPAIGN_SEND_RATE_PER_MINUTE.
 *
 * Reaching the cap pauses the campaign (explicit resume); it never moves the campaign to another
 * sender account and never spreads one campaign over several accounts. These limits are per
 * account and exist to be gentle, not to be worked around: using several accounts to exceed them
 * is exactly what this product does not do.
 */

export const DEFAULT_DAILY_LIMIT = 150;
export const MAX_DAILY_LIMIT = 400;
export const DEFAULT_RATE_PER_MINUTE = 10;
export const MAX_RATE_PER_MINUTE = 60;

const readInteger = (raw, fallback, max) => {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const value = Number(String(raw).trim());
  if (!Number.isInteger(value) || value < 1) return fallback;
  return Math.min(value, max);
};

/** @returns {{ dailyLimit: number, ratePerMinute: number }} */
export const getSenderLimits = (env = process.env) => ({
  dailyLimit: readInteger(env.GMAIL_SENDER_DAILY_LIMIT, DEFAULT_DAILY_LIMIT, MAX_DAILY_LIMIT),
  ratePerMinute: readInteger(env.GMAIL_SENDER_RATE_PER_MINUTE, DEFAULT_RATE_PER_MINUTE, MAX_RATE_PER_MINUTE),
});

export const utcDay = (date = new Date()) => date.toISOString().slice(0, 10);

const expiryFor = (date) => new Date(date.getTime() + 3 * 24 * 3600 * 1000);

/**
 * Reserves one send slot for today. Atomic: concurrent callers can never take more than `limit`.
 *
 * @returns {Promise<{ ok: boolean, used: number, limit: number, day: string }>}
 */
export const reserveDailySlot = async (senderAccountId, { now = new Date(), env = process.env } = {}) => {
  const { dailyLimit } = getSenderLimits(env);
  const day = utcDay(now);
  try {
    const doc = await SenderUsage.findOneAndUpdate(
      { senderAccountId, day, count: { $lt: dailyLimit } },
      { $inc: { count: 1 }, $setOnInsert: { expiresAt: expiryFor(now) } },
      { upsert: true, new: true }
    );
    return { ok: true, used: doc.count, limit: dailyLimit, day };
  } catch (error) {
    // The (account, day) document exists and is at the limit: the upsert tried to insert a twin
    if (error?.code === 11000) return { ok: false, used: dailyLimit, limit: dailyLimit, day };
    throw error;
  }
};

/** Gives a reserved slot back (nothing was attempted after all). Best effort. */
export const releaseDailySlot = async (senderAccountId, { now = new Date() } = {}) => {
  try {
    await SenderUsage.updateOne({ senderAccountId, day: utcDay(now), count: { $gt: 0 } }, { $inc: { count: -1 } });
  } catch {
    // A slot that is not given back only makes the cap more conservative
  }
};

const pacers = new Map();

/**
 * Waits for this sender's next send slot (evenly spaced, in this process).
 */
export const waitForSenderSlot = async (senderAccountId, { env = process.env } = {}) => {
  const { ratePerMinute } = getSenderLimits(env);
  const key = String(senderAccountId);
  let pacer = pacers.get(key);
  if (!pacer || pacer.ratePerMinute !== ratePerMinute) {
    pacer?.cancel();
    pacer = createSendThrottle(ratePerMinute);
    pacers.set(key, pacer);
  }
  await pacer.wait();
};

/** Releases everyone waiting for a sender slot (shutdown). */
export const cancelSenderPacers = () => {
  for (const pacer of pacers.values()) pacer.cancel();
  pacers.clear();
};

export default {
  DEFAULT_DAILY_LIMIT,
  MAX_DAILY_LIMIT,
  DEFAULT_RATE_PER_MINUTE,
  MAX_RATE_PER_MINUTE,
  getSenderLimits,
  utcDay,
  reserveDailySlot,
  releaseDailySlot,
  waitForSenderSlot,
  cancelSenderPacers,
};
