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
 *   pending work continues. Recipients therefore receive a campaign at most once.
 * - Errors are recorded as codes only; transport messages and credentials are never stored.
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
 * Set when the process is shutting down; workers stop claiming new deliveries.
 */
let stopRequested = false;

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
 * Claims, sends, and records one delivery. Returns false when no pending work remains.
 *
 * @returns {Promise<boolean>}
 */
const processNextDelivery = async (campaignId, message, emailService) => {
  const delivery = await Delivery.findOneAndUpdate(
    { campaignId, status: 'pending' },
    { $set: { status: 'processing' }, $inc: { attempts: 1 } },
    { new: true, sort: { _id: 1 } }
  );

  if (!delivery) {
    return false;
  }

  try {
    const result = await emailService.sendEmail({
      to: delivery.email,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });

    await Delivery.updateOne(
      { _id: delivery._id, status: 'processing' },
      {
        $set: {
          status: 'sent',
          messageId: typeof result?.messageId === 'string' ? result.messageId.slice(0, 998) : null,
          sentAt: new Date(),
          errorCode: null,
        },
      }
    );
    await Campaign.updateOne({ _id: campaignId }, { $inc: { 'stats.sent': 1 } });
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
    await Campaign.updateOne({ _id: campaignId }, { $inc: { 'stats.failed': 1 } });
  }

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
        const hadWork = await processNextDelivery(campaignId, message, emailService);
        if (!hadWork) {
          return;
        }
      }
    };

    await Promise.all(Array.from({ length: workerCount }, () => worker()));

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
 * Resumes campaigns left in 'sending' by a previous process (crash or shutdown).
 * Deliveries stuck in 'processing' are failed with 'INTERRUPTED' instead of being re-sent.
 *
 * @param {object} options
 * @param {{ sendEmail: Function }} options.emailService
 * @param {number} [options.concurrency]
 * @param {object} [options.logger=console]
 * @returns {Promise<number>} Number of campaigns resumed
 */
export const resumeInterruptedDispatches = async ({
  emailService,
  concurrency,
  logger = console,
} = {}) => {
  const stuck = await Campaign.find({ status: 'sending' }).select('_id').lean();
  let resumed = 0;

  for (const { _id: campaignId } of stuck) {
    if (isDispatchActive(campaignId)) {
      continue;
    }

    await Delivery.updateMany(
      { campaignId, status: 'processing' },
      { $set: { status: 'failed', errorCode: 'INTERRUPTED', failedAt: new Date() } }
    );

    const counts = await getDeliveryCounts(campaignId);
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

    scheduleCampaignProcessing(campaignId, { emailService, concurrency, logger });
    resumed += 1;
  }

  if (resumed > 0) {
    logger.log(`[Dispatcher] Resumed ${resumed} interrupted campaign dispatch(es).`);
  }
  return resumed;
};

export default {
  startCampaignDispatch,
  processCampaignDeliveries,
  scheduleCampaignProcessing,
  resumeInterruptedDispatches,
  finalizeCampaign,
  getDeliveryCounts,
  waitForCampaignDispatch,
  stopAllDispatches,
  resetDispatcherState,
  isDispatchActive,
  getSendConcurrency,
  toDeliveryErrorCode,
};
