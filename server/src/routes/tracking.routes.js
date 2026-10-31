import { Router } from 'express';
import { trackOpen, trackClick } from '../controllers/tracking.controller.js';

const router = Router();

/**
 * Public email tracking routes (no authentication required)
 */

/**
 * @route   GET /api/v1/tracking/open/:token
 * @desc    Log email open event and return 1x1 transparent tracking GIF
 * @access  Public
 */
router.get('/open/:token', trackOpen);

/**
 * @route   GET /api/v1/tracking/click/:token
 * @desc    Log link click event and redirect 302 to destination URL
 * @access  Public
 */
router.get('/click/:token', trackClick);

export default router;

