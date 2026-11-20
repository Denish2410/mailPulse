import crypto from 'node:crypto';
import SenderSendWindow from '../models/SenderSendWindow.js';
import { createSendThrottle } from './sendThrottle.service.js';

/**
 * Conservative per-sender limits for campaign mail sent through a customer's Gmail account.
 *
 * Google publishes sending ceilings for Gmail accounts. They are hard limits, NOT targets: a
 * mailbox that sends near them is far more likely to be throttled or flagged. MailPulse therefore
 * applies much lower limits of its own, per sender account:
 *
 *   - a cap on the sends of any rolling 24 hours (GMAIL_SENDER_DAILY_LIMIT, default 150, never
 *     above 400), counted in MongoDB so it holds across worker processes. It is a sliding window,
 *     not a calendar day: there is no midnight at which the allowance resets, so a burst can never
 *     add up to twice the cap. Every send ATTEMPT counts, including ones that ended uncertain or
 *     rejected, because Gmail may have counted them too;
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

/** The per-minute pacing: 0 switches the extra pacing off (automated tests); unset means the default. */
const readRate = (raw) => (String(raw ?? '').trim() === '0' ? 0 : readInteger(raw, DEFAULT_RATE_PER_MINUTE, MAX_RATE_PER_MINUTE));

/** @returns {{ dailyLimit: number, ratePerMinute: number }} */
export const getSenderLimits = (env = process.env) => ({
  dailyLimit: readInteger(env.GMAIL_SENDER_DAILY_LIMIT, DEFAULT_DAILY_LIMIT, MAX_DAILY_LIMIT),
  ratePerMinute: readRate(env.GMAIL_SENDER_RATE_PER_MINUTE),
});

export const WINDOW_MS = 24 * 60 * 60 * 1000;

/** The reference time of the update: the database's own clock, or a fixed instant in tests. */
const nowExpr = (now) => (now ? { $literal: now } : '$$NOW');

const pruneStage = (now) => ({
  $set: {
    sends: {
      $filter: {
        input: { $ifNull: ['$sends', []] },
        as: 'entry',
        cond: { $gt: ['$$entry.at', { $subtract: [nowExpr(now), WINDOW_MS] }] },
      },
    },
  },
});

/**
 * Reserves one send slot in the rolling 24 hours. One atomic update on the sender's single window
 * document (server time): it drops entries older than 24 hours, then appends this reservation only
 * if fewer than `limit` remain. Concurrent callers, in any process, can never take more than the
 * limit, and a caller learns whether it won by its own token.
 *
 * @returns {Promise<{ ok: boolean, used: number, limit: number, token: string|null }>}
 */
export const reserveDailySlot = async (senderAccountId, { now = null, env = process.env } = {}) => {
  const { dailyLimit } = getSenderLimits(env);
  const token = crypto.randomBytes(12).toString('hex');
  const pipeline = [
    pruneStage(now),
    {
      $set: {
        lastToken: { $cond: [{ $lt: [{ $size: '$sends' }, dailyLimit] }, token, '$lastToken'] },
        sends: {
          $cond: [
            { $lt: [{ $size: '$sends' }, dailyLimit] },
            { $concatArrays: ['$sends', [{ at: nowExpr(now), k: token }]] },
            '$sends',
          ],
        },
      },
    },
  ];
  const run = () => SenderSendWindow.findOneAndUpdate({ senderAccountId }, pipeline, { upsert: true, new: true });
  let doc;
  try {
    doc = await run();
  } catch (error) {
    if (error?.code !== 11000) throw error;
    // Two first reservations raced to create the document; the loser simply updates it
    doc = await run();
  }
  const won = doc.lastToken === token;
  return { ok: won, used: doc.sends.length, limit: dailyLimit, token: won ? token : null };
};

/** Gives a reservation back (no delivery was claimed after all). Best effort. */
export const releaseDailySlot = async (senderAccountId, token) => {
  if (!token) return;
  try {
    await SenderSendWindow.updateOne({ senderAccountId }, [
      { $set: { sends: { $filter: { input: { $ifNull: ['$sends', []] }, as: 'entry', cond: { $ne: ['$$entry.k', token] } } } } },
    ]);
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
  WINDOW_MS,
  reserveDailySlot,
  releaseDailySlot,
  waitForSenderSlot,
  cancelSenderPacers,
};
