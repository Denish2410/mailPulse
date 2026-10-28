import mongoose from 'mongoose';
import Campaign from '../models/Campaign.js';
import Delivery from '../models/Delivery.js';
import {
  EmailServiceError,
  InvalidMessageError,
  EmailConfigurationError,
  EmailTransportError,
} from './email.service.js';

/**
 * MailPulse Campaign Dispatcher (Phase 5)
 *
 * Sends a campaign to its recipients, one Delivery record per recipient, in the background.
 *
 * Lifecycle:
 * 1. `startCampaignDispatch` atomically moves the campaign from 'draft' to 'sending'. The update
 *    is conditioned on the exact draft version that passed readiness (`updatedAt`), so two
 *    concurrent send requests, or an edit racing a send, can never both win.
 * 2. One 'pending' Delivery per eligible recipient is created with a snapshot of the address.
 * 3. A bounded pool of workers claims deliveries one at a time ('pending' -> 'processing'),
 *    sends exactly one message per recipient, and records 'sent' or 'failed'.
 * 4. When no work remains the campaign is finalized: 'sent' if at least one message was
 *    accepted by the transport, otherwise 'failed'. `stats` is recomputed from Delivery records.
 *
 * Reliability:
 * - Graceful shutdown (`stopAllDispatches`) stops workers from claiming new deliveries and waits
 *   for in-flight sends. Remaining 'pending' deliveries are resumed on the next start.
 * - On start (`resumeInterruptedDispatches`) deliveries stuck in 'processing' are marked
 *   failed with 'INTERRUPTED' rather than re-sent (the transport may have accepted them), and
 *   pending work continues.
 * - While running, a watchdog (`startDispatchWatchdog`) recovers campaigns wedged in 'sending'
 *   whose dispatch halted (e.g. on a database error), so they do not wait for a restart.
 * - Errors are recorded as codes only; transport messages and credentials are never stored.
 *   A database failure after the transport accepted a message is recorded as 'PERSIST_ERROR',
 *   never as a transport failure.
 *
 * Delivery guarantee: AT MOST ONCE per recipient per campaign (atomic claim + never re-sending
 * 'INTERRUPTED' or 'PERSIST_ERROR'). It is not exactly-once: Delivery records are a lower bound
 * on what was accepted, since a crash or write failure after acceptance is recorded as failed.
 *
 * DEPLOYMENT: SINGLE APPLICATION INSTANCE ONLY. Dispatch bookkeeping (`activeDispatches`,
 * `stopRequested`) lives in process memory. With several instances, startup recovery or the
 * watchdog on one instance can fail deliveries that another instance is still sending.
 */

export const DEFAULT_SEND_CONCURRENCY = 5;
export const MAX_SEND_CONCURRENCY = 20;

/**
 * Resolves worker concurrency from CAMPAIGN_SEND_CONCURRENCY (1..20, default 5).
 *
 * @param {object} [env=process.env]
 * @returns {number}
 */
export const getSendConcurrency = (env = process.env) => {
  const raw = env.CAMPAIGN_SEND_CONCURRENCY;
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return DEFAULT_SEND_CONCURRENCY;
  }
  const value = Number(String(raw).trim());
  if (!Number.isInteger(value) || value < 1) {
    return DEFAULT_SEND_CONCURRENCY;
  }
  return Math.min(value, MAX_SEND_CONCURRENCY);
};

/**
 * Maps an error thrown by the email service to a stored, sanitized delivery error code.
 *
 * @param {unknown} error
 * @returns {'INVALID_MESSAGE'|'CONFIGURATION_ERROR'|'TRANSPORT_ERROR'|'UNKNOWN_ERROR'}
 */
export const toDeliveryErrorCode = (error) => {
  if (error instanceof InvalidMessageError) return 'INVALID_MESSAGE';
  if (error instanceof EmailConfigurationError) return 'CONFIGURATION_ERROR';
  if (error instanceof EmailTransportError) return 'TRANSPORT_ERROR';
  if (error instanceof EmailServiceError && typeof error.code === 'string') {
    return ['INVALID_MESSAGE', 'CONFIGURATION_ERROR', 'TRANSPORT_ERROR'].includes(error.code)
      ? error.code
      : 'UNKNOWN_ERROR';
  }
  return 'UNKNOWN_ERROR';
};

/**
 * In-flight dispatches keyed by campaign ID string.
 * @type {Map<string, Promise<void>>}
 */
const activeDispatches = new Map();

/**
 * Campaign IDs currently being recovered in this process. Together with `activeDispatches` this
 * makes recovery mutually exclusive per campaign, so an overlapping startup recovery and watchdog
 * sweep can never fail a delivery that the other has already handed to a worker.
 * @type {Set<string>}
 */
const recoveringCampaigns = new Set();

/**
 * Set when the process is shutting down; workers stop claiming new deliveries.
 */
let stopRequested = false;

/**
 * Logs a warning, falling back to `error` for loggers without `warn`. Logging must never be
 * able to throw inside a worker.
 */
const logWarning = (logger, message) => {
  if (typeof logger?.warn === 'function') {
    logger.warn(message);
  } else if (typeof logger?.error === 'function') {
    logger.error(message);
  }
};

/**
 * @returns {boolean} True while a dispatch for the campaign is running in this process
 */
export const isDispatchActive = (campaignId) => activeDispatches.has(String(campaignId));

/**
 * Resolves when the campaign's in-flight dispatch (if any) has finished. Useful for tests and
 * for composition roots that need deterministic completion.
 *
 * @param {string|import('mongoose').Types.ObjectId} campaignId
 * @returns {Promise<void>}
 */
export const waitForCampaignDispatch = (campaignId) =>
  activeDispatches.get(String(campaignId)) || Promise.resolve();

/**
 * Asks every running dispatch to stop claiming new work and waits for in-flight sends.
 * Campaigns left in 'sending' are picked up by `resumeInterruptedDispatches` on next start.
 *
 * @returns {Promise<void>}
 */
export const stopAllDispatches = async () => {
  stopRequested = true;
  stopDispatchWatchdog();
  await Promise.allSettled([...activeDispatches.values()]);
};

/**
 * Re-enables dispatching after `stopAllDispatches` (used by tests and in-process restarts).
 */
export const resetDispatcherState = () => {
  stopRequested = false;
};

/**
 * Recomputes per-status delivery counts for a campaign.
 *
 * @param {import('mongoose').Types.ObjectId|string} campaignId
 * @returns {Promise<{ total: number, pending: number, processing: number, sent: number, failed: number }>}
 */
export const getDeliveryCounts = async (campaignId) => {
  const campaignObjectId =
    typeof campaignId === 'string' ? new mongoose.Types.ObjectId(campaignId) : campaignId;

  const rows = await Delivery.aggregate([
    { $match: { campaignId: campaignObjectId } },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);

  const counts = { total: 0, pending: 0, processing: 0, sent: 0, failed: 0 };
  for (const row of rows) {
    if (Object.prototype.hasOwnProperty.call(counts, row._id)) {
      counts[row._id] = row.count;
    }
    counts.total += row.count;
  }
  return counts;
};

/**
 * Finalizes a campaign whose deliveries have all been processed.
 * Does nothing while pending/processing deliveries remain (e.g. after a shutdown request).
 *
 * @param {import('mongoose').Types.ObjectId|string} campaignId
 * @returns {Promise<object|null>} Updated campaign, or null if not finalized
 */
export const finalizeCampaign = async (campaignId) => {
  const counts = await getDeliveryCounts(campaignId);

  if (counts.pending > 0 || counts.processing > 0) {
    return null;
  }

  return Campaign.findOneAndUpdate(
    { _id: campaignId, status: 'sending' },
    {
      $set: {
        status: counts.sent > 0 ? 'sent' : 'failed',
        sendCompletedAt: new Date(),
        'stats.total': counts.total,
        'stats.sent': counts.sent,
        'stats.failed': counts.failed,
      },
    },
    { new: true }
  );
};

/**
 * Normalizes a transport message ID for storage.
 *
 * @param {object} result - Value returned by `emailService.sendEmail`
 * @returns {string|null}
 */
const toStoredMessageId = (result) =>
  typeof result?.messageId === 'string' ? result.messageId.slice(0, 998) : null;

/**
 * Records that the transport accepted a delivery.
 */
const markDeliverySent = (deliveryId, result) =>
  Delivery.updateOne(
    { _id: deliveryId, status: 'processing' },
    {
      $set: {
        status: 'sent',
        messageId: toStoredMessageId(result),
        sentAt: new Date(),
        errorCode: null,
      },
    }
  );

/**
 * Increments a denormalized campaign counter. Failures are logged and ignored: `stats` is
 * recomputed from Delivery records when the campaign finalizes, so a missed increment must never
 * change how the delivery itself is recorded.
 */
const incrementCampaignStat = async (campaignId, field, logger) => {
  try {
    await Campaign.updateOne({ _id: campaignId }, { $inc: { [`stats.${field}`]: 1 } });
  } catch (error) {
    logWarning(
      logger,
      `[Dispatcher] Campaign ${String(campaignId)} stats.${field} update skipped: ${error?.name || 'Error'}`
    );
  }
};

/**
 * Claims, sends, and records one delivery. Returns false when no pending work remains.
 *
 * Only errors raised while handing the message to the transport are recorded as delivery
 * failures. Once the transport has accepted a message, a database error is a *persistence*
 * failure: the recipient was very likely emailed, so the delivery is recorded as
 * `PERSIST_ERROR` (never as a transport failure) and is never retried.
 *
 * Rejects only when the database is unavailable even for recording a failure; the dispatch then
 * halts and the watchdog or the next startup recovers the campaign.
 *
 * @returns {Promise<boolean>}
 */
export const processNextDelivery = async (campaignId, message, emailService, logger = console) => {
  const delivery = await Delivery.findOneAndUpdate(
    { campaignId, status: 'pending' },
    { $set: { status: 'processing' }, $inc: { attempts: 1 } },
    { new: true, sort: { _id: 1 } }
  );

  if (!delivery) {
    return false;
  }

  // 1. Hand the message to the transport
  let result;
  try {
    result = await emailService.sendEmail({
      to: delivery.email,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
  } catch (error) {
    await Delivery.updateOne(
      { _id: delivery._id, status: 'processing' },
      {
        $set: {
          status: 'failed',
          errorCode: toDeliveryErrorCode(error),
          failedAt: new Date(),
        },
      }
    );
    await incrementCampaignStat(campaignId, 'failed', logger);
    return true;
  }

  // 2. The transport accepted the message: record it, retrying once for transient write errors
  try {
    await markDeliverySent(delivery._id, result);
  } catch {
    try {
      await markDeliverySent(delivery._id, result);
    } catch (persistError) {
      logger.error(
        `[Dispatcher] Campaign ${String(campaignId)} delivery ${String(delivery._id)} was accepted by the transport but could not be recorded: ${persistError?.name || 'Error'}`
      );
      await Delivery.updateOne(
        { _id: delivery._id, status: 'processing' },
        {
          $set: {
            status: 'failed',
            errorCode: 'PERSIST_ERROR',
            messageId: toStoredMessageId(result),
            failedAt: new Date(),
          },
        }
      );
      await incrementCampaignStat(campaignId, 'failed', logger);
      return true;
    }
  }

  await incrementCampaignStat(campaignId, 'sent', logger);
  return true;
};

/**
 * Processes every pending delivery of a campaign with bounded concurrency, then finalizes it.
 * Never rejects: unexpected failures are logged (without message content or addresses) and the
 * campaign is left in 'sending' for resumption.
 *
 * @param {import('mongoose').Types.ObjectId|string} campaignId
 * @param {object} options
 * @param {{ sendEmail: Function }} options.emailService
 * @param {number} [options.concurrency]
 * @param {object} [options.logger=console]
 * @returns {Promise<void>}
 */
export const processCampaignDeliveries = async (
  campaignId,
  { emailService, concurrency = getSendConcurrency(), logger = console } = {}
) => {
  try {
    const campaign = await Campaign.findOne({ _id: campaignId, status: 'sending' })
      .select('subject textContent htmlContent')
      .lean();

    if (!campaign) {
      return;
    }

    const message = {
      subject: campaign.subject,
      text: campaign.textContent ?? '',
      html: campaign.htmlContent ?? '',
    };

    const workerCount = Math.max(1, Math.min(Number(concurrency) || 1, MAX_SEND_CONCURRENCY));

    const worker = async () => {
      while (!stopRequested) {
        const hadWork = await processNextDelivery(campaignId, message, emailService, logger);
        if (!hadWork) {
          return;
        }
      }
    };

    // allSettled (not all): if one worker rejects, the others keep running, and this dispatch
    // must stay tracked in `activeDispatches` until every one of them has stopped, so the
    // watchdog can never treat a still-running campaign as stalled.
    const outcomes = await Promise.allSettled(
      Array.from({ length: workerCount }, () => worker())
    );

    const failure = outcomes.find((outcome) => outcome.status === 'rejected');
    if (failure) {
      logger.error(
        `[Dispatcher] Campaign ${String(campaignId)} dispatch halted: ${failure.reason?.name || 'Error'}. It will be recovered by the watchdog or on restart.`
      );
      return;
    }

    if (!stopRequested) {
      await finalizeCampaign(campaignId);
    }
  } catch (error) {
    logger.error(
      `[Dispatcher] Campaign ${String(campaignId)} dispatch halted: ${error?.name || 'Error'}`
    );
  }
};

/**
 * Runs `processCampaignDeliveries` in the background and tracks it so it can be awaited.
 * A campaign already being processed in this process is not started twice.
 *
 * @returns {Promise<void>}
 */
export const scheduleCampaignProcessing = (campaignId, options = {}) => {
  const key = String(campaignId);
  const existing = activeDispatches.get(key);
  if (existing) {
    return existing;
  }

  const run = new Promise((resolve) => setImmediate(resolve))
    .then(() => processCampaignDeliveries(campaignId, options))
    .finally(() => {
      activeDispatches.delete(key);
    });

  activeDispatches.set(key, run);
  return run;
};

/**
 * Locks a ready draft into 'sending', creates its Delivery records, and starts background
 * processing. The caller is responsible for authentication, readiness evaluation, and
 * verifying that the email service is configured.
 *
 * @param {object} params
 * @param {object} params.campaign - The draft exactly as it was evaluated for readiness
 * @param {string} params.userId - Authenticated owner
 * @param {Array<{ _id: any, name: string, email: string }>} params.eligibleContacts
 * @param {{ sendEmail: Function }} params.emailService
 * @param {number} [params.concurrency]
 * @param {object} [params.logger]
 * @returns {Promise<object|null>} The campaign in 'sending' state, or null when the draft
 *   changed or was already sent since it was evaluated (caller should respond 409).
 */
export const startCampaignDispatch = async ({
  campaign,
  userId,
  eligibleContacts,
  emailService,
  concurrency,
  logger = console,
}) => {
  if (!Array.isArray(eligibleContacts) || eligibleContacts.length === 0) {
    throw new Error('startCampaignDispatch requires at least one eligible contact.');
  }

  const now = new Date();

  // 1. Atomic draft -> sending transition on the exact evaluated version
  const locked = await Campaign.findOneAndUpdate(
    {
      _id: campaign._id,
      userId,
      status: 'draft',
      updatedAt: campaign.updatedAt,
    },
    {
      $set: {
        status: 'sending',
        sendStartedAt: now,
        sendCompletedAt: null,
        'stats.total': eligibleContacts.length,
        'stats.sent': 0,
        'stats.failed': 0,
      },
    },
    { new: true }
  );

  if (!locked) {
    return null;
  }

  // 2. One pending delivery per eligible recipient (address snapshot)
  try {
    await Delivery.insertMany(
      eligibleContacts.map((contact) => ({
        campaignId: locked._id,
        userId: locked.userId,
        contactId: contact._id,
        email: contact.email,
        name: typeof contact.name === 'string' ? contact.name.slice(0, 100) : '',
        status: 'pending',
      })),
      { ordered: false }
    );
  } catch (error) {
    // Roll back so the user can retry; nothing has been sent yet
    await Delivery.deleteMany({ campaignId: locked._id, status: 'pending' });
    await Campaign.updateOne(
      { _id: locked._id, status: 'sending' },
      {
        $set: {
          status: 'draft',
          sendStartedAt: null,
          'stats.total': 0,
          'stats.sent': 0,
          'stats.failed': 0,
        },
      }
    );
    throw error;
  }

  // 3. Background processing
  scheduleCampaignProcessing(locked._id, { emailService, concurrency, logger });

  return locked;
};

/**
 * Recovers one campaign left in 'sending' with no dispatch running in this process.
 *
 * - Deliveries stuck in 'processing' are failed with 'INTERRUPTED' instead of being re-sent.
 * - A campaign that was locked but never got any deliveries (the process died between the lock
 *   and the insert) sent nothing, so it is returned to 'draft' for the user to retry.
 * - Otherwise stats are recomputed and remaining 'pending' deliveries are dispatched; the
 *   campaign finalizes when they are done.
 *
 * Mutually exclusive per campaign within this process: if the campaign is already dispatching
 * or being recovered, this returns 'skipped' without touching it. The check and the lock are
 * synchronous, and dispatch is registered in `activeDispatches` before the lock is released, so
 * no other recovery can interleave.
 *
 * SINGLE-INSTANCE ONLY: "no dispatch running" is known only for this process. With several
 * application instances, one instance could recover a campaign another is still sending.
 *
 * @returns {Promise<'resumed'|'reverted'|'skipped'>}
 */
export const recoverCampaign = async (campaignId, { emailService, concurrency, logger = console } = {}) => {
  const key = String(campaignId);
  if (isDispatchActive(key) || recoveringCampaigns.has(key)) {
    return 'skipped';
  }
  recoveringCampaigns.add(key);

  try {
    await Delivery.updateMany(
      { campaignId, status: 'processing' },
      { $set: { status: 'failed', errorCode: 'INTERRUPTED', failedAt: new Date() } }
    );

    const counts = await getDeliveryCounts(campaignId);

    if (counts.total === 0) {
      const reverted = await Campaign.updateOne(
        { _id: campaignId, status: 'sending' },
        {
          $set: {
            status: 'draft',
            sendStartedAt: null,
            sendCompletedAt: null,
            'stats.total': 0,
            'stats.sent': 0,
            'stats.failed': 0,
          },
        }
      );
      return reverted.modifiedCount > 0 ? 'reverted' : 'skipped';
    }

    await Campaign.updateOne(
      { _id: campaignId, status: 'sending' },
      {
        $set: {
          'stats.total': counts.total,
          'stats.sent': counts.sent,
          'stats.failed': counts.failed,
        },
      }
    );

    // Registers in `activeDispatches` synchronously, before the lock below is released
    scheduleCampaignProcessing(campaignId, { emailService, concurrency, logger });
    return 'resumed';
  } finally {
    recoveringCampaigns.delete(key);
  }
};

/**
 * Resumes campaigns left in 'sending' by a previous process (crash or shutdown).
 * Called once at startup, before this process has started any dispatch of its own.
 *
 * @param {object} options
 * @param {{ sendEmail: Function }} options.emailService
 * @param {number} [options.concurrency]
 * @param {object} [options.logger=console]
 * @returns {Promise<number>} Number of campaigns resumed or returned to draft
 */
export const resumeInterruptedDispatches = async ({
  emailService,
  concurrency,
  logger = console,
} = {}) => {
  const stuck = await Campaign.find({ status: 'sending' }).select('_id').lean();
  let recovered = 0;

  for (const { _id: campaignId } of stuck) {
    if (isDispatchActive(campaignId)) {
      continue;
    }

    const outcome = await recoverCampaign(campaignId, { emailService, concurrency, logger });
    if (outcome !== 'skipped') {
      recovered += 1;
    }
  }

  if (recovered > 0) {
    logger.log(`[Dispatcher] Resumed ${recovered} interrupted campaign dispatch(es).`);
  }
  return recovered;
};

export const DEFAULT_STALL_TIMEOUT_MS = 15 * 60 * 1000;
export const DEFAULT_WATCHDOG_INTERVAL_MS = 5 * 60 * 1000;

const parsePositiveIntegerEnv = (raw, fallback) => {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return fallback;
  }
  const value = Number(String(raw).trim());
  return Number.isInteger(value) && value > 0 ? value : fallback;
};

/**
 * Resolves watchdog timing from CAMPAIGN_STALL_TIMEOUT_MS and CAMPAIGN_WATCHDOG_INTERVAL_MS.
 *
 * @param {object} [env=process.env]
 * @returns {{ stallTimeoutMs: number, intervalMs: number }}
 */
export const getWatchdogConfig = (env = process.env) => ({
  stallTimeoutMs: parsePositiveIntegerEnv(env.CAMPAIGN_STALL_TIMEOUT_MS, DEFAULT_STALL_TIMEOUT_MS),
  intervalMs: parsePositiveIntegerEnv(env.CAMPAIGN_WATCHDOG_INTERVAL_MS, DEFAULT_WATCHDOG_INTERVAL_MS),
});

/**
 * Recovers campaigns that are wedged in 'sending': started at least `stallTimeoutMs` ago and
 * with no dispatch running in this process (for example after a dispatch halted on a database
 * error). The age threshold keeps the sweep away from campaigns that were just locked and are
 * still having their deliveries created.
 *
 * SINGLE-INSTANCE ONLY (see `recoverCampaign`).
 *
 * @param {object} options
 * @param {{ sendEmail: Function }} options.emailService
 * @param {number} [options.concurrency]
 * @param {object} [options.logger=console]
 * @param {number} [options.stallTimeoutMs]
 * @param {Date} [options.now=new Date()]
 * @returns {Promise<number>} Number of campaigns recovered
 */
export const reapStalledCampaigns = async ({
  emailService,
  concurrency,
  logger = console,
  stallTimeoutMs = getWatchdogConfig().stallTimeoutMs,
  now = new Date(),
} = {}) => {
  if (stopRequested) {
    return 0;
  }

  const cutoff = new Date(now.getTime() - stallTimeoutMs);
  const stalled = await Campaign.find({ status: 'sending', sendStartedAt: { $lte: cutoff } })
    .select('_id')
    .lean();

  let recovered = 0;
  for (const { _id: campaignId } of stalled) {
    if (stopRequested) {
      break;
    }
    if (isDispatchActive(campaignId)) {
      continue;
    }

    const outcome = await recoverCampaign(campaignId, { emailService, concurrency, logger });
    if (outcome !== 'skipped') {
      recovered += 1;
    }
  }

  if (recovered > 0) {
    logWarning(logger, `[Dispatcher] Watchdog recovered ${recovered} stalled campaign dispatch(es).`);
  }
  return recovered;
};

let watchdogTimer = null;

/**
 * Stops the periodic stalled-campaign sweep, if running.
 */
export const stopDispatchWatchdog = () => {
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
};

/**
 * Starts a periodic `reapStalledCampaigns` sweep. Sweeps never overlap, the timer does not keep
 * the process alive, and `stopAllDispatches` stops it during shutdown.
 *
 * @param {object} options
 * @param {{ sendEmail: Function }} options.emailService
 * @param {number} [options.concurrency]
 * @param {object} [options.logger=console]
 * @param {number} [options.intervalMs]
 * @param {number} [options.stallTimeoutMs]
 * @returns {Function} Stops the watchdog
 */
export const startDispatchWatchdog = ({
  emailService,
  concurrency,
  logger = console,
  intervalMs,
  stallTimeoutMs,
} = {}) => {
  stopDispatchWatchdog();

  const config = getWatchdogConfig();
  const every = intervalMs ?? config.intervalMs;
  const timeout = stallTimeoutMs ?? config.stallTimeoutMs;
  let sweeping = false;

  watchdogTimer = setInterval(() => {
    if (sweeping || stopRequested) {
      return;
    }
    sweeping = true;
    reapStalledCampaigns({ emailService, concurrency, logger, stallTimeoutMs: timeout })
      .catch((error) => {
        logger.error(`[Dispatcher] Watchdog sweep failed: ${error?.name || 'Error'}`);
      })
      .finally(() => {
        sweeping = false;
      });
  }, every);
  watchdogTimer.unref?.();

  return stopDispatchWatchdog;
};

export default {
  startCampaignDispatch,
  processCampaignDeliveries,
  scheduleCampaignProcessing,
  resumeInterruptedDispatches,
  recoverCampaign,
  reapStalledCampaigns,
  startDispatchWatchdog,
  stopDispatchWatchdog,
  getWatchdogConfig,
  processNextDelivery,
  finalizeCampaign,
  getDeliveryCounts,
  waitForCampaignDispatch,
  stopAllDispatches,
  resetDispatcherState,
  isDispatchActive,
  getSendConcurrency,
  toDeliveryErrorCode,
};
