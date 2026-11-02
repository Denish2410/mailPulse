import { Router } from 'express';
import {
  trackOpen,
  trackClick,
  getUnsubscribe,
  processUnsubscribe,
} from '../controllers/tracking.controller.js';

const router = Router();

/**
 * Public email tracking & unsubscribe routes (no authentication required)
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

/**
 * @route   GET /api/v1/tracking/unsubscribe/:token
 * @desc    Display unsubscribe confirmation landing page or validate token
 * @access  Public
 */
router.get('/unsubscribe/:token', getUnsubscribe);

/**
 * @route   POST /api/v1/tracking/unsubscribe/:token
 * @desc    Process unsubscribe request (RFC 8058 One-Click, web form, or API)
 * @access  Public
 */
router.post('/unsubscribe/:token', processUnsubscribe);

export default router;

