import { performance } from 'node:perf_hooks';
import {
  acquireLeaseSession,
  adoptLease,
  getLeaseMs,
  INSTANCE_ID,
  leaseTakeoverFields,
  releaseAllLeases,
  LEASE_UNSET,
} from './dispatchLease.service.js';
import mongoose from 'mongoose';
import User from '../models/User.js';
import Campaign from '../models/Campaign.js';
import Delivery from '../models/Delivery.js';
import Contact from '../models/Contact.js';
import Suppression from '../models/Suppression.js';
import {
  EmailServiceError,
  InvalidMessageError,
  EmailConfigurationError,
  EmailTransportError,
} from './email.service.js';
import {
  prepareTrackedEmailHtml,
  appendMailingAddress,
  createUnsubscribeToken,
  injectUnsubscribeLinks,
} from './tracking.service.js';
import { personalizeMessage } from './personalization.service.js';
import { getDeliveryTagHeaders } from './webhookProviders.service.js';
import { getSharedSendThrottle, cancelSharedSendThrottle } from './sendThrottle.service.js';

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
 * DEPLOYMENT: several application instances may run. `activeDispatches` and `stopRequested`
 * describe only THIS process, so each campaign in 'sending' also carries a lease
 * (dispatchLease.service.js) that its owner renews; recovery never touches a campaign whose lease
 * is held by a live peer. CAMPAIGN_SEND_RATE_PER_MINUTE is applied per instance.
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
  cancelSharedSendThrottle();
  await Promise.allSettled([...activeDispatches.values()]);
  // Hand our campaigns to peers immediately instead of making them wait for the lease to expire
  // (skipped when the database is not connected, and bounded so shutdown can never hang on it)
  if (mongoose.connection.readyState === 1) {
    await Promise.race([
      releaseAllLeases().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 2000).unref?.()),
    ]);
  }
};

/**
 * Re-enables dispatching after `stopAllDispatches` (used by tests and in-process restarts).
 */
export const resetDispatcherState = () => {
  stopRequested = false;
};

/** Filter fragment tying a campaign update to the lease owner and epoch the worker was granted. */
const ownerFilter = (fence) =>
  fence ? { dispatchLeaseOwner: INSTANCE_ID, dispatchLeaseEpoch: fence.epoch } : {};

/** Filter for "this worker's own claimed delivery", conditional on its claim epoch. */
const ownClaim = (deliveryId, fence) => ({
  _id: deliveryId,
  status: 'processing',
  ...(fence ? { claimEpoch: fence.epoch } : {}),
});

/**
 * Filter fragment: the delivery's fence allows a worker at this epoch to claim it. A missing or null
 * fence (`{ fence: null }` matches both) allows anyone; otherwise the fence must not exceed the
 * worker's epoch. This is part of the single-document atomic claim, so it cannot be raced.
 */
const claimableBy = (fence) =>
  fence ? { $or: [{ fence: null }, { fence: { $lte: fence.epoch } }] } : {};

/**
 * Raises the fence of every still-pending delivery of a campaign to at least `epoch`. `$max` can
 * never lower a fence, so it is idempotent and safe to run late, twice, or concurrently from
 * several takers. Anything but a clean acknowledgement is an error.
 */
const raiseDeliveryFences = async (campaignId, epoch) => {
  const result = await Delivery.updateMany(
    { campaignId, status: 'pending' },
    { $max: { fence: epoch } },
    { timestamps: false }
  );
  if (!result?.acknowledged) {
    throw new Error('Raising delivery fences was not acknowledged by the database.');
  }
  return result;
};

/**
 * The `beforeAcquire` step of a takeover: fence the campaign's pending deliveries to the epoch the
 * taker is about to hold, BEFORE the lease changes hands. If this throws, the lease is not
 * acquired and nothing is recovered or dispatched.
 *
 * Why before: a stale worker's claim requires `fence <= its epoch`. The acquire that follows is a
 * compare-and-swap on the epoch that was observed when `nextEpoch` was computed, so the epoch it
 * grants is exactly `nextEpoch`. Every delivery that was pending at fencing time therefore refuses
 * every older epoch from the moment the new owner holds the lease. A claim that wins before the
 * fence reaches a delivery is a legitimate pre-takeover claim: the delivery is then `processing`
 * under the old epoch and recovery records it INTERRUPTED. Nothing ever moves a delivery from
 * `processing` back to `pending`, so no later write can lower that protection.
 *
 * @param {import('mongoose').Types.ObjectId|string} campaignId
 */
export const fenceDeliveriesBeforeTakeover =
  (campaignId) =>
  async ({ nextEpoch }) => {
    await raiseDeliveryFences(campaignId, nextEpoch);
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
 * With a `fence` (the worker's LeaseSession) the update is conditional on that worker still being
 * the current lease owner (same owner and epoch) of a campaign that is still 'sending', so a stale
 * worker can never finalize. The final status is derived from the delivery counts, and only one of
 * several concurrent callers can win the status change, so finalizing is idempotent.
 *
 * @param {import('mongoose').Types.ObjectId|string} campaignId
 * @param {{ epoch: number }|null} [fence]
 * @returns {Promise<object|null>} Updated campaign, or null if not finalized
 */
export const finalizeCampaign = async (campaignId, fence = null) => {
  const counts = await getDeliveryCounts(campaignId);

  if (counts.pending > 0 || counts.processing > 0) {
    return null;
  }

  return Campaign.findOneAndUpdate(
    { _id: campaignId, status: 'sending', ...ownerFilter(fence) },
    {
      $set: {
        status: counts.sent > 0 ? 'sent' : 'failed',
        sendCompletedAt: new Date(),
        'stats.total': counts.total,
        'stats.sent': counts.sent,
        'stats.failed': counts.failed,
      },
      $unset: LEASE_UNSET,
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
const markDeliverySent = (deliveryId, result, fence = null) =>
  Delivery.updateOne(
    ownClaim(deliveryId, fence),
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
const incrementCampaignStat = async (campaignId, field, logger, fence = null) => {
  try {
    // Only while the campaign is still sending under this worker's epoch: a late update from a
    // stale worker, or after finalization, matches nothing and cannot change the counts.
    await Campaign.updateOne(
      { _id: campaignId, status: 'sending', ...ownerFilter(fence) },
      { $inc: { [`stats.${field}`]: 1 } }
    );
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
export const processNextDelivery = async (
  campaignId,
  message,
  emailService,
  logger = console,
  fence = null
) => {
  // Lease check before EVERY claim (one indexed read): a worker that lost, or can no longer prove,
  // its lease claims nothing. `false` also tells the worker loop to stop. Every dispatch path
  // passes a fence; only direct calls without one (tests) skip the check.
  if (fence && !(await fence.canClaim())) {
    return false;
  }

  // ONE atomic update on the delivery: it only matches while the delivery is pending AND its fence
  // allows this worker's epoch, so a worker that has been taken over cannot claim, whatever its
  // local state says.
  const delivery = await Delivery.findOneAndUpdate(
    { campaignId, status: 'pending', ...claimableBy(fence) },
    {
      $set: { status: 'processing', ...(fence ? { claimEpoch: fence.epoch } : {}) },
      $inc: { attempts: 1 },
    },
    { new: true, sort: { _id: 1 } }
  );

  if (!delivery) {
    // Nothing claimable. If deliveries are pending but fenced above our epoch, a newer owner took
    // over: this worker is fenced out and must stop (not merely "out of work").
    if (fence && (await Delivery.exists({ campaignId, status: 'pending', fence: { $gt: fence.epoch } }))) {
      fence.fenceNow?.('fenced-out');
    }
    return false;
  }

  // The fence can trip between the check and the claim. CONSERVATIVE rule: a delivery this worker
  // has claimed is never handed back to 'pending' (a late write from a stale worker could leave
  // it claimable by an intermediate epoch). Nothing is sent; the delivery stays 'processing' under
  // this worker's claim epoch, and the next owner's recovery records it INTERRUPTED. A recipient
  // that was provably never emailed may therefore be skipped. Preventing an unsafe retry is more
  // important than preserving that one delivery.
  if (fence?.isFenced()) {
    return false;
  }

  // 1. Suppression & Unsubscribe Check: Never dispatch to unsubscribed or suppressed recipients
  if (delivery.userId) {
    const isSuppressed = await Suppression.exists({
      userId: delivery.userId,
      email: delivery.email.toLowerCase().trim(),
    });
    const isContactUnsubscribed = delivery.contactId
      ? await Contact.exists({ _id: delivery.contactId, isUnsubscribed: true })
      : false;

    if (isSuppressed || isContactUnsubscribed) {
      await Delivery.updateOne(
        ownClaim(delivery._id, fence),
        {
          $set: {
            status: 'failed',
            errorCode: 'SUPPRESSED',
            failedAt: new Date(),
          },
        }
      );
      await incrementCampaignStat(campaignId, 'failed', logger, fence);
      return true;
    }
  }

  // 2. Resolve Unsubscribe URL and RFC 8058 One-Click headers
  const baseUrl =
    process.env.TRACKING_BASE_URL ||
    process.env.API_BASE_URL ||
    'http://localhost:5000';

  let unsubscribeUrl = '';
  let customHeaders = {};

  if (delivery.userId) {
    try {
      const unsubToken = createUnsubscribeToken({
        campaignId,
        recipientId: delivery.contactId ? String(delivery.contactId) : undefined,
        recipientEmail: delivery.email,
        userId: delivery.userId,
      });
      unsubscribeUrl = `${baseUrl}/api/v1/tracking/unsubscribe/${unsubToken}`;
      customHeaders = {
        'List-Unsubscribe': `<${unsubscribeUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      };
    } catch (tokenErr) {
      logWarning(
        logger,
        `[Dispatcher] Failed to create unsubscribe token for delivery ${String(delivery._id)}: ${tokenErr?.message || 'Error'}`
      );
    }
  }

  // 2b. Tag the message with our Delivery ID for configured ESPs, so bounce and complaint
  //     webhooks can be matched back to this exact delivery (and owner)
  customHeaders = { ...customHeaders, ...getDeliveryTagHeaders(delivery._id) };

  // 3. Personalize merge tags for this recipient (before tracking/unsubscribe injection, so
  //    recipient values can never alter tracking links)
  let customFields;
  if (delivery.contactId && delivery.userId && /\{\{\s*custom\./i.test(`${message.subject} ${message.text} ${message.html}`)) {
    const contact = await Contact.findOne({ _id: delivery.contactId, userId: delivery.userId })
      .select('customFields')
      .lean();
    customFields = contact?.customFields;
  }
  // A/B test: recipients assigned to variant B get the alternative subject
  const variantSubject =
    delivery.variant === 'B' && message.subjectB ? message.subjectB : message.subject;
  const personalized = personalizeMessage({ ...message, subject: variantSubject }, {
    name: delivery.name,
    email: delivery.email,
    customFields,
  });

  // 3b. Inject tracking pixel, rewrite links, and add unsubscribe footers
  let htmlToSend = personalized.html;
  let textToSend = personalized.text;

  if (htmlToSend && typeof htmlToSend === 'string' && htmlToSend.trim()) {
    try {
      htmlToSend = prepareTrackedEmailHtml(htmlToSend, {
        campaignId,
        recipientId: delivery.contactId ? String(delivery.contactId) : undefined,
        recipientEmail: delivery.email,
        baseUrl,
        unsubscribeUrl,
      });
    } catch (trackingError) {
      logWarning(
        logger,
        `[Dispatcher] Failed to inject tracking for delivery ${String(delivery._id)}: ${trackingError?.message || 'Error'}`
      );
    }
  }

  if (textToSend && typeof textToSend === 'string' && textToSend.trim() && unsubscribeUrl) {
    try {
      const textResult = injectUnsubscribeLinks('', textToSend, { unsubscribeUrl });
      textToSend = textResult.text;
    } catch (textErr) {
      logWarning(
        logger,
        `[Dispatcher] Failed to inject text unsubscribe link for delivery ${String(delivery._id)}: ${textErr?.message || 'Error'}`
      );
    }
  }

  // 3c. Sender postal address footer
  if (message.mailingAddress) {
    const withAddress = appendMailingAddress(htmlToSend, textToSend, message.mailingAddress);
    htmlToSend = withAddress.html;
    textToSend = withAddress.text;
  }

  // 3d. Last local check before the SMTP call (no database read). If the lease was lost while this
  //     message was being prepared, nothing is sent and the worker stops. As above, the claimed
  //     delivery stays 'processing' for recovery to record as INTERRUPTED; it is never returned
  //     to 'pending'.
  if (fence?.isFenced()) {
    return false;
  }

  // 4. Hand the message to the transport with custom headers. From here on the outcome may be
  //    uncertain, so this delivery can never go back to 'pending'.
  let result;
  try {
    result = await emailService.sendEmail({
      to: delivery.email,
      subject: personalized.subject || variantSubject,
      text: textToSend,
      html: htmlToSend,
      ...(Object.keys(customHeaders).length > 0 && { headers: customHeaders }),
    });
  } catch (error) {
    await Delivery.updateOne(
      ownClaim(delivery._id, fence),
      {
        $set: {
          status: 'failed',
          errorCode: toDeliveryErrorCode(error),
          failedAt: new Date(),
        },
      }
    );
    await incrementCampaignStat(campaignId, 'failed', logger, fence);
    return true;
  }

  // 2. The transport accepted the message: record it, retrying once for transient write errors
  try {
    await markDeliverySent(delivery._id, result, fence);
  } catch {
    try {
      await markDeliverySent(delivery._id, result, fence);
    } catch (persistError) {
      logger.error(
        `[Dispatcher] Campaign ${String(campaignId)} delivery ${String(delivery._id)} was accepted by the transport but could not be recorded: ${persistError?.name || 'Error'}`
      );
      await Delivery.updateOne(
        ownClaim(delivery._id, fence),
        {
          $set: {
            status: 'failed',
            errorCode: 'PERSIST_ERROR',
            messageId: toStoredMessageId(result),
            failedAt: new Date(),
          },
        }
      );
      await incrementCampaignStat(campaignId, 'failed', logger, fence);
      return true;
    }
  }

  await incrementCampaignStat(campaignId, 'sent', logger, fence);
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
  { emailService, concurrency = getSendConcurrency(), logger = console, leaseSession = null } = {}
) => {
  // The worker's lease: handed in by the code that already took it atomically (the draft ->
  // sending transition, or recovery), otherwise taken here. Its epoch fences everything below.
  let session = leaseSession;
  try {
    const campaign = await Campaign.findOne({ _id: campaignId, status: 'sending' })
      .select('userId subject subjectB textContent htmlContent')
      .lean();

    if (!campaign) {
      return;
    }

    // INTERNAL / TEST-ONLY PATH: in production a lease session is always handed in (by the
    // draft -> sending transition or by recovery), so this branch is not reachable there. It exists
    // for direct callers (tests). It uses the same fence-then-compare-and-swap takeover as
    // recovery, but it has no recovery sweep, so it does not mark older processing deliveries
    // INTERRUPTED. Another live owner means: leave the campaign alone.
    if (!session) {
      try {
        session = await acquireLeaseSession(campaignId, {
          beforeAcquire: fenceDeliveriesBeforeTakeover(campaignId),
          onFenced: (reason) =>
            logWarning(logger, `[Dispatcher] Campaign ${String(campaignId)} worker fenced itself (${reason}); it stops claiming deliveries.`),
        });
      } catch (error) {
        logger.error(
          `[Dispatcher] Campaign ${String(campaignId)} not dispatched: delivery fencing failed (${error?.name || 'Error'}).`
        );
        return;
      }
    }
    if (!session) {
      return;
    }

    // The owner's postal address goes into every footer (CAN-SPAM); read once per dispatch
    const owner = await User.findById(campaign.userId).select('mailingAddress').lean();

    const message = {
      mailingAddress: owner?.mailingAddress || '',
      subject: campaign.subject,
      subjectB: campaign.subjectB || '',
      text: campaign.textContent ?? '',
      html: campaign.htmlContent ?? '',
    };

    const workerCount = Math.max(1, Math.min(Number(concurrency) || 1, MAX_SEND_CONCURRENCY));

    const throttle = getSharedSendThrottle();

    const worker = async () => {
      while (!stopRequested && !session.isFenced()) {
        // Reserve a send slot first (no-op when CAMPAIGN_SEND_RATE_PER_MINUTE is unset)
        await throttle.wait();
        if (stopRequested || session.isFenced()) return;
        const hadWork = await processNextDelivery(campaignId, message, emailService, logger, session);
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

    if (!stopRequested && !session.isFenced()) {
      await finalizeCampaign(campaignId, session);
    }
  } catch (error) {
    logger.error(
      `[Dispatcher] Campaign ${String(campaignId)} dispatch halted: ${error?.name || 'Error'}`
    );
  } finally {
    // Stop renewing and give the lease back (conditional on our epoch, so a no-op once finalized
    // or taken by a newer owner). A halted or stopped dispatch is then recoverable at the next
    // watchdog sweep instead of waiting out the lease or the stall timeout.
    if (session) await session.release();
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
    // A lease session handed to a dispatch that will not run must not keep renewing
    options.leaseSession?.release();
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

  // 1. Atomic draft -> sending transition on the exact evaluated version. The lease is taken in
  //    the SAME update (an update pipeline using MongoDB server time), so there is never a moment
  //    when the campaign is 'sending' without an owner that a peer's watchdog could grab.
  const leaseMs = getLeaseMs();
  const confirmedAt = performance.now(); // monotonic, captured before the request (conservative)
  const locked = await Campaign.findOneAndUpdate(
    {
      _id: campaign._id,
      userId,
      status: { $in: ['draft', 'scheduled'] },
      updatedAt: campaign.updatedAt,
    },
    [
      {
        $set: {
          status: 'sending',
          sendStartedAt: '$$NOW',
          sendCompletedAt: null,
          'stats.total': eligibleContacts.length,
          'stats.sent': 0,
          'stats.failed': 0,
          updatedAt: '$$NOW', // pipeline updates do not maintain timestamps on their own
          ...leaseTakeoverFields(leaseMs),
        },
      },
    ],
    { new: true }
  );

  if (!locked) {
    return null;
  }

  // The lease granted by that update, with its epoch and a running heartbeat
  const leaseSession = adoptLease(locked._id, locked.dispatchLeaseEpoch, {
    leaseMs,
    confirmedAt,
    onFenced: (reason) =>
      logWarning(logger, `[Dispatcher] Campaign ${String(locked._id)} worker fenced itself (${reason}); it stops claiming deliveries.`),
  });

  // 2. One pending delivery per eligible recipient (address snapshot)
  try {
    await Delivery.insertMany(
      eligibleContacts.map((contact, index) => ({
        campaignId: locked._id,
        // Alternate A/B so the split is exactly even; without a test everyone is 'A'
        variant: locked.subjectB && index % 2 === 1 ? 'B' : 'A',
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
    leaseSession.stop();
    await Delivery.deleteMany({ campaignId: locked._id, status: 'pending' });
    await Campaign.updateOne(
      { _id: locked._id, status: 'sending', dispatchLeaseEpoch: leaseSession.epoch },
      {
        $set: {
          status: 'draft',
          sendStartedAt: null,
          'stats.total': 0,
          'stats.sent': 0,
          'stats.failed': 0,
        },
        $unset: LEASE_UNSET,
      }
    );
    throw error;
  }

  // 3. Background processing, as the owner of the lease granted above
  scheduleCampaignProcessing(locked._id, { emailService, concurrency, logger, leaseSession });

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
 * Multi-instance: the campaign's lease is taken first; if another live instance holds it, this
 * returns 'skipped' and the campaign is left alone.
 *
 * @returns {Promise<'resumed'|'reverted'|'skipped'>}
 */
export const recoverCampaign = async (campaignId, { emailService, concurrency, logger = console } = {}) => {
  const key = String(campaignId);
  if (isDispatchActive(key) || recoveringCampaigns.has(key)) {
    return 'skipped';
  }
  recoveringCampaigns.add(key);

  let session = null;
  let handedOff = false;
  try {
    // Take over in this order: (1) read the expired lease and the next epoch, (2) fence every
    // pending delivery to that epoch, (3) only then acquire the lease atomically (MongoDB server
    // time, new epoch). If fencing fails nothing is acquired, recovered or dispatched and the
    // campaign stays eligible for another attempt. If another live instance holds the lease it is
    // still sending this campaign and nothing below may touch it.
    try {
      session = await acquireLeaseSession(campaignId, {
        beforeAcquire: fenceDeliveriesBeforeTakeover(campaignId),
        onFenced: (reason) =>
          logWarning(logger, `[Dispatcher] Campaign ${String(campaignId)} worker fenced itself (${reason}); it stops claiming deliveries.`),
      });
    } catch (error) {
      logger.error(
        `[Dispatcher] Campaign ${String(campaignId)} takeover aborted: delivery fencing failed (${error?.name || 'Error'}). The lease was NOT acquired and nothing was recovered; the campaign stays eligible for another attempt.`
      );
      return 'skipped';
    }
    if (!session) {
      return 'skipped';
    }

    // Anything still 'processing' belongs to an older epoch (we only just became the owner). Its
    // outcome is unknown, so it is recorded as INTERRUPTED and NEVER re-sent.
    await Delivery.updateMany(
      { campaignId, status: 'processing', claimEpoch: { $ne: session.epoch } },
      { $set: { status: 'failed', errorCode: 'INTERRUPTED', failedAt: new Date() } }
    );

    // Defense in depth: the acquire was a compare-and-swap against the epoch the pending deliveries
    // were fenced to, so they already carry exactly our epoch. Re-asserting it after the sweep is
    // idempotent (`$max` never lowers) and costs one update.
    await raiseDeliveryFences(campaignId, session.epoch);

    const counts = await getDeliveryCounts(campaignId);

    if (counts.total === 0) {
      const reverted = await Campaign.updateOne(
        { _id: campaignId, status: 'sending', dispatchLeaseEpoch: session.epoch },
        {
          $set: {
            status: 'draft',
            sendStartedAt: null,
            sendCompletedAt: null,
            'stats.total': 0,
            'stats.sent': 0,
            'stats.failed': 0,
          },
          $unset: LEASE_UNSET,
        }
      );
      return reverted.modifiedCount > 0 ? 'reverted' : 'skipped';
    }

    await Campaign.updateOne(
      { _id: campaignId, status: 'sending', dispatchLeaseEpoch: session.epoch },
      {
        $set: {
          'stats.total': counts.total,
          'stats.sent': counts.sent,
          'stats.failed': counts.failed,
        },
      }
    );

    // Registers in `activeDispatches` synchronously, before the lock below is released. The
    // dispatch continues under the lease (and epoch) acquired above.
    scheduleCampaignProcessing(campaignId, { emailService, concurrency, logger, leaseSession: session });
    handedOff = true;
    return 'resumed';
  } finally {
    // Not handed to a dispatch (skipped, reverted or failed): stop renewing and give it back
    if (session && !handedOff) await session.release();
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
 * Lease-aware (see `recoverCampaign`): campaigns held by a live instance are skipped.
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
  // Candidates: started long ago (this also covers a campaign that never had a lease, e.g. one
  // still running on an older version), OR its lease has ended by MongoDB's clock. A lease ends
  // either because its owner died (it stopped renewing) or because the owner released it during a
  // graceful shutdown (a release stamps the lease with the current database time). recoverCampaign
  // takes the lease atomically and refuses any campaign a live owner still holds, so listing a
  // campaign here never interferes with its owner.
  const stalled = await Campaign.find({
    status: 'sending',
    $or: [
      { sendStartedAt: { $lte: cutoff } },
      { dispatchLeaseUntil: { $type: 'date' }, $expr: { $lte: ['$dispatchLeaseUntil', '$$NOW'] } },
    ],
  })
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
