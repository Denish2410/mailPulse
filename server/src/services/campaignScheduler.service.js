import Campaign from '../models/Campaign.js';
import User from '../models/User.js';
import { evaluateCampaignReadiness } from './campaignReadiness.service.js';
import { startCampaignDispatch } from './campaignDispatch.service.js';

/**
 * MailPulse Campaign Scheduler (Phase 9)
 *
 * Polls for campaigns in status 'scheduled' whose `scheduledAt` has passed and hands each to
 * `startCampaignDispatch`, which performs the atomic 'scheduled' -> 'sending' transition. That
 * conditional update is the lock: a campaign can never be dispatched twice, and a cancel or
 * reschedule racing a poll simply makes the dispatch a no-op.
 *
 * DEPLOYMENT: SINGLE APPLICATION INSTANCE ONLY (in-process timer).
 */

export const DEFAULT_SCHEDULER_INTERVAL_MS = 15000;
export const MIN_SCHEDULER_INTERVAL_MS = 1000;

/**
 * Resolves the poll interval from CAMPAIGN_SCHEDULER_INTERVAL_MS (>= 1000ms, default 15000).
 *
 * @param {object} [env=process.env]
 * @returns {number}
 */
export const getSchedulerIntervalMs = (env = process.env) => {
  const raw = env.CAMPAIGN_SCHEDULER_INTERVAL_MS;
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return DEFAULT_SCHEDULER_INTERVAL_MS;
  }
  const value = Number(String(raw).trim());
  if (!Number.isFinite(value) || value < MIN_SCHEDULER_INTERVAL_MS) {
    return DEFAULT_SCHEDULER_INTERVAL_MS;
  }
  return Math.floor(value);
};

const log = (logger, level, message) => {
  const fn = typeof logger?.[level] === 'function' ? logger[level] : logger?.log;
  if (typeof fn === 'function') {
    try {
      fn.call(logger, message);
    } catch {
      // logging must never throw
    }
  }
};

/**
 * Marks a due campaign failed (only if it is still scheduled) with an audit log line.
 */
const failScheduledCampaign = async (campaign, reason, logger) => {
  await Campaign.updateOne(
    { _id: campaign._id, status: 'scheduled' },
    { $set: { status: 'failed', sendCompletedAt: new Date() } }
  );
  log(logger, 'warn', `[Scheduler] Campaign ${String(campaign._id)} failed at schedule time: ${reason}`);
};

/**
 * Dispatches every due scheduled campaign once.
 *
 * @param {object} options
 * @param {object} options.emailService
 * @param {object} [options.logger]
 * @param {Date} [options.now]
 * @returns {Promise<{ due: number, dispatched: number, failed: number, skipped: number }>}
 */
export const pollScheduledCampaigns = async ({ emailService, logger = console, now } = {}) => {
  const result = { due: 0, dispatched: 0, failed: 0, skipped: 0 };
  const due = await Campaign.find({
    status: 'scheduled',
    scheduledAt: { $lte: now || new Date() },
  }).sort({ scheduledAt: 1 });
  result.due = due.length;

  for (const campaign of due) {
    try {
      const userId = campaign.userId;
      const user = await User.findById(userId).select('status').lean();
      if (!user || (user.status && user.status !== 'active')) {
        await failScheduledCampaign(campaign, 'account unavailable', logger);
        result.failed += 1;
        continue;
      }

      const { isReady, issues, eligibleContacts } = await evaluateCampaignReadiness(
        campaign,
        userId
      );
      if (!isReady || eligibleContacts.length === 0) {
        await failScheduledCampaign(campaign, `not ready (${issues.length} issue(s))`, logger);
        result.failed += 1;
        continue;
      }

      const locked = await startCampaignDispatch({
        campaign,
        userId,
        eligibleContacts,
        emailService,
        logger,
      });
      if (locked) {
        result.dispatched += 1;
        log(logger, 'log', `[Scheduler] Dispatching campaign ${String(campaign._id)}`);
      } else {
        // Canceled, rescheduled or edited concurrently
        result.skipped += 1;
      }
    } catch (error) {
      result.skipped += 1;
      log(
        logger,
        'error',
        `[Scheduler] Campaign ${String(campaign._id)} dispatch error: ${error?.name || 'Error'}`
      );
    }
  }

  return result;
};

let timer = null;
let activePoll = null;

/**
 * Starts the polling loop. Idempotent; overlapping polls are skipped.
 *
 * @param {object} options
 * @param {object} options.emailService
 * @param {number} [options.intervalMs]
 * @param {object} [options.logger]
 */
export const startCampaignScheduler = ({ emailService, intervalMs, logger = console } = {}) => {
  if (timer) return;
  const interval = intervalMs ?? getSchedulerIntervalMs();

  const tick = () => {
    if (activePoll) return;
    activePoll = pollScheduledCampaigns({ emailService, logger })
      .catch((error) => {
        log(logger, 'error', `[Scheduler] Poll failed: ${error?.name || 'Error'}`);
      })
      .finally(() => {
        activePoll = null;
      });
  };

  timer = setInterval(tick, interval);
  timer.unref?.();
};

/**
 * Stops the loop and waits for an in-flight poll.
 *
 * @returns {Promise<void>}
 */
export const stopCampaignScheduler = async () => {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (activePoll) {
    await activePoll;
  }
};

export const isCampaignSchedulerRunning = () => timer !== null;
