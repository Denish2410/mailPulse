/**
 * Test helper: does what the worker does for "send now". The API only queues a campaign
 * ('scheduled', due now); this runs one scheduler poll (which locks and starts every due
 * campaign) with the email service and manifest limits the test injected into the app, then
 * waits for the given campaign's dispatch to finish.
 */
import app from '../../src/app.js';
import { pollScheduledCampaigns } from '../../src/services/campaignScheduler.service.js';
import { waitForCampaignDispatch } from '../../src/services/campaignDispatch.service.js';

const quiet = { log() {}, warn() {}, error() {} };

/**
 * @param {import('mongoose').Types.ObjectId|string} campaignId
 * @param {object} [options]
 * @param {{ sendEmail: Function }} [options.emailService] - Defaults to app.locals.emailService
 * @returns {Promise<{ due: number, dispatched: number, failed: number, skipped: number }>}
 */
export const runQueuedSend = async (campaignId, { emailService = app.locals.emailService } = {}) => {
  const result = await pollScheduledCampaigns({
    emailService,
    logger: quiet,
    manifestLimits: app.locals.dispatchManifestLimits,
  });
  await waitForCampaignDispatch(campaignId);
  return result;
};

export default { runQueuedSend };
