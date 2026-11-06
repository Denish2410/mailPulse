import { Router } from 'express';
import {
  createCampaign,
  getCampaigns,
  getCampaignById,
  updateCampaign,
  deleteCampaign,
  getCampaignReadiness,
  sendCampaignTestEmail,
  sendCampaign,
  scheduleCampaign,
  cancelScheduledCampaign,
  applyCampaignAudience,
  getCampaignBounces,
  getCampaignDeliveries,
  getCampaignAnalytics,
} from '../controllers/campaign.controller.js';
import { authenticate } from '../middleware/authenticate.js';
import { testEmailRateLimiter } from '../middleware/testEmailRateLimiter.js';
import { campaignSendRateLimiter } from '../middleware/campaignSendRateLimiter.js';
import { validate } from '../validators/validate.js';
import {
  createCampaignSchema,
  campaignIdParamSchema,
  updateCampaignSchema,
  getCampaignsQuerySchema,
  sendTestEmailSchema,
  sendCampaignSchema,
  scheduleCampaignSchema,
  applyAudienceSchema,
  getCampaignDeliveriesSchema,
} from '../validators/campaign.validator.js';

const router = Router();

/**
 * All campaign routes require valid authentication.
 * Verified owner identity is attached to `req.auth.userId`.
 */
router.use(authenticate);

/**
 * @route   POST /api/v1/campaigns
 * @desc    Create a new campaign draft for the authenticated user
 * @access  Protected
 */
router.post('/', validate(createCampaignSchema), createCampaign);

/**
 * @route   GET /api/v1/campaigns
 * @desc    List all campaign drafts for the authenticated user (with pagination & search)
 * @access  Protected
 */
router.get('/', validate(getCampaignsQuerySchema), getCampaigns);

/**
 * @route   GET /api/v1/campaigns/:id/readiness
 * @desc    Evaluate send-readiness of a campaign draft belonging to the authenticated user
 * @access  Protected
 */
router.get('/:id/readiness', validate(campaignIdParamSchema), getCampaignReadiness);

/**
/**
 * @route   POST /api/v1/campaigns/:id/test-email
 * @desc    Send a single "[TEST]" copy of a campaign to the authenticated user's own account email.
 *          Never contacts campaign recipients and never modifies the campaign.
 * @access  Protected, plus a dedicated per-user rate limit (applied before validation so
 *          every attempt counts toward the quota)
 */
router.post(
  '/:id/test-email',
  testEmailRateLimiter,
  validate(sendTestEmailSchema),
  sendCampaignTestEmail
);

/**
 * @route   POST /api/v1/campaigns/:id/send
 * @desc    Send a ready draft to all of its eligible recipients. Requires { "confirm": true }.
 *          Responds 202 once deliveries are queued; dispatch continues in the background.
 * @access  Protected, plus a dedicated per-user send rate limit
 */
router.post('/:id/send', campaignSendRateLimiter, validate(sendCampaignSchema), sendCampaign);

/**
 * @route   POST /api/v1/campaigns/:id/schedule
 * @desc    Schedule a ready draft for future dispatch.
 * @access  Protected
 */
router.post('/:id/schedule', validate(scheduleCampaignSchema), scheduleCampaign);

/**
 * @route   POST /api/v1/campaigns/:id/cancel-schedule
 * @desc    Cancel a scheduled campaign and revert it to draft.
 * @access  Protected
 */
router.post('/:id/cancel-schedule', validate(campaignIdParamSchema), cancelScheduledCampaign);

/**
 * @route   GET /api/v1/campaigns/:id/deliveries
 * @desc    Per-recipient delivery log with status summary and pagination
 * @access  Protected
 */
router.get('/:id/deliveries', validate(getCampaignDeliveriesSchema), getCampaignDeliveries);

/**
 * @route   GET /api/v1/campaigns/:id/analytics
 * @desc    Retrieve open and click tracking analytics for a campaign
 * @access  Protected
 */
router.get('/:id/analytics', validate(campaignIdParamSchema), getCampaignAnalytics);

/**
 * @route   GET /api/v1/campaigns/:id
 * @desc    Retrieve a single campaign belonging to the authenticated user
 * @access  Protected
 */
router.get('/:id', validate(campaignIdParamSchema), getCampaignById);

/**
 * @route   PATCH /api/v1/campaigns/:id
 * @desc    Update a campaign draft belonging to the authenticated user
 * @access  Protected
 */
router.patch('/:id', validate(updateCampaignSchema), updateCampaign);

/**
 * @route   DELETE /api/v1/campaigns/:id
 * @desc    Delete a campaign draft belonging to the authenticated user
 * @access  Protected
 */
router.delete('/:id', validate(campaignIdParamSchema), deleteCampaign);

/**
 * @route   POST /api/v1/campaigns/:id/audience
 * @desc    Fill a draft's recipients from tags or a saved segment (Phase 11)
 * @access  Protected
 */
router.post('/:id/audience', validate(applyAudienceSchema), applyCampaignAudience);

/**
 * @route   GET /api/v1/campaigns/:id/bounces
 * @desc    Bounce and complaint summary with recent events (Phase 12)
 * @access  Protected
 */
router.get('/:id/bounces', validate(campaignIdParamSchema), getCampaignBounces);

export default router;
