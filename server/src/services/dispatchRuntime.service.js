import { getDefaultEmailService } from './email.service.js';
import {
  resumeInterruptedDispatches,
  startDispatchWatchdog,
  stopAllDispatches,
} from './campaignDispatch.service.js';
import {
  startCampaignScheduler,
  stopCampaignScheduler,
} from './campaignScheduler.service.js';

/**
 * The campaign dispatch runtime: every background job that sends campaigns, in one place.
 *
 *   - startup resume of campaigns left 'sending' by a previous process (non-blocking)
 *   - the stalled-campaign watchdog (periodic recovery sweep)
 *   - the scheduled-campaign poller (locks due campaigns and starts their dispatch)
 *
 * Today the API process starts it after connecting to MongoDB. Grouping it here is what lets a
 * separate worker process own it later without the API starting any of these timers.
 *
 * Stopping follows the required order: the scheduler first (awaiting an in-flight poll, which may
 * be locking a campaign and generating its deliveries), then the dispatches (no new claims, await
 * in-flight sends without cancelling them, release leases). MongoDB must still be open for both;
 * closing it is the caller's job, afterwards.
 */

let running = false;

/**
 * Starts the dispatch runtime. Idempotent while running.
 *
 * @param {object} [options]
 * @param {{ sendEmail: Function }} [options.emailService] - Defaults to the configured service
 * @param {object} [options.logger=console]
 * @returns {boolean} true if this call started it, false if it was already running
 */
export const startDispatchRuntime = ({ emailService = getDefaultEmailService(), logger = console } = {}) => {
  if (running) return false;
  running = true;

  resumeInterruptedDispatches({ emailService, logger }).catch((err) => {
    logger.error(`[Dispatcher] Failed to resume interrupted dispatches: ${err?.name || 'Error'}`);
  });
  startDispatchWatchdog({ emailService, logger });
  startCampaignScheduler({ emailService, logger });
  return true;
};

/**
 * Stops the scheduler (awaiting an in-flight poll), then all dispatches (awaiting in-flight sends
 * and releasing leases). Safe to call when the runtime was never started: the dispatch stop also
 * covers dispatches started directly (for example by a send request).
 *
 * @returns {Promise<void>}
 */
export const stopDispatchRuntime = async () => {
  await stopCampaignScheduler();
  await stopAllDispatches();
  running = false;
};

/** @returns {boolean} Whether startDispatchRuntime has started the runtime in this process */
export const isDispatchRuntimeRunning = () => running;

export default { startDispatchRuntime, stopDispatchRuntime, isDispatchRuntimeRunning };
