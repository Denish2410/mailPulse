import { Router } from 'express';
import {
  createCampaign,
  getCampaigns,
  getCampaignById,
  updateCampaign,
  deleteCampaign,
  getCampaignReadiness,
  sendCampaignTestEmail,
} from '../controllers/campaign.controller.js';
import { authenticate } from '../middleware/authenticate.js';
import { testEmailRateLimiter } from '../middleware/testEmailRateLimiter.js';
import { validate } from '../validators/validate.js';
import {
  createCampaignSchema,
  campaignIdParamSchema,
  updateCampaignSchema,
  getCampaignsQuerySchema,
  sendTestEmailSchema,
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

export default router;
