import {
  TRANSPARENT_1X1_GIF,
  recordOpenEvent,
  recordClickEvent,
} from '../services/tracking.service.js';
import { asyncHandler } from '../utils/asyncHandler.js';

/**
 * Public HTTP endpoint to track email opens via 1x1 transparent GIF.
 *
 * Route: GET /api/v1/tracking/open/:token
 * Access: Public
 */
export const trackOpen = asyncHandler(async (req, res) => {
  const { token } = req.params;
  const ip = req.ip || req.headers['x-forwarded-for'] || req.socket?.remoteAddress;
  const userAgent = req.headers['user-agent'];

  // Set anti-caching HTTP headers for instant email open registration
  res.setHeader('Content-Type', 'image/gif');
  res.setHeader('Content-Length', TRANSPARENT_1X1_GIF.length);
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  // Asynchronously record event without breaking image display on invalid tokens
  try {
    await recordOpenEvent(token, { ip, userAgent });
  } catch (err) {
    // Graceful degradation: Log internally, but never return broken image to mail client
    if (process.env.NODE_ENV !== 'test') {
      console.warn(`[Tracking] Failed to record open event: ${err.message}`);
    }
  }

  // Always return the 1x1 GIF
  res.status(200).end(TRANSPARENT_1X1_GIF);
});

/**
 * Public HTTP endpoint to track link clicks and safely redirect to destination URL.
 *
 * Route: GET /api/v1/tracking/click/:token
 * Access: Public
 */
export const trackClick = asyncHandler(async (req, res) => {
  const { token } = req.params;
  const ip = req.ip || req.headers['x-forwarded-for'] || req.socket?.remoteAddress;
  const userAgent = req.headers['user-agent'];

  try {
    const { targetUrl } = await recordClickEvent(token, { ip, userAgent });

    // Disallow caching of the redirect response
    res.setHeader('Cache-Control', 'no-store, private');
    return res.redirect(302, targetUrl);
  } catch (err) {
    return res.status(400).json({
      success: false,
      message: 'Invalid or expired tracking link',
    });
  }
});

export default {
  trackOpen,
  trackClick,
};
