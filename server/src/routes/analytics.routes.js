import { Router } from 'express';
import { getAnalyticsOverview } from '../controllers/analytics.controller.js';
import { authenticate } from '../middleware/authenticate.js';
import { validate } from '../validators/validate.js';
import { getAnalyticsOverviewSchema } from '../validators/analytics.validator.js';

const router = Router();

router.use(authenticate);

/**
 * @route   GET /api/v1/analytics/overview
 * @desc    Contacts, campaign status, delivery totals, daily trend and failure reasons
 * @access  Protected
 */
router.get('/overview', validate(getAnalyticsOverviewSchema), getAnalyticsOverview);

export default router;
