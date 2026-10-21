import { Router } from 'express';
import {
  createCampaign,
  getCampaigns,
  getCampaignById,
  updateCampaign,
  deleteCampaign,
  getCampaignReadiness,
} from '../controllers/campaign.controller.js';
import { authenticate } from '../middleware/authenticate.js';
import { validate } from '../validators/validate.js';
import {
  createCampaignSchema,
  campaignIdParamSchema,
  updateCampaignSchema,
  getCampaignsQuerySchema,
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
