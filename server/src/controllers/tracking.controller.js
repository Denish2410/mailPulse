import {
  TRANSPARENT_1X1_GIF,
  recordOpenEvent,
  recordClickEvent,
  verifyUnsubscribeToken,
  recordUnsubscribeEvent,
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

/**
 * Render an HTML page or JSON for unsubscribe confirmation.
 *
 * Route: GET /api/v1/tracking/unsubscribe/:token
 * Access: Public
 */
export const getUnsubscribe = asyncHandler(async (req, res) => {
  const { token } = req.params;

  let verified;
  try {
    verified = verifyUnsubscribeToken(token);
  } catch {
    if (req.accepts('html') && !req.accepts('json')) {
      return res.status(400).send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Invalid Unsubscribe Link - MailPulse</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f9fafb; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .card { background: white; padding: 2.5rem; border-radius: 0.75rem; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); max-width: 440px; width: 100%; text-align: center; }
    h1 { color: #dc2626; font-size: 1.25rem; margin-bottom: 0.75rem; }
    p { color: #4b5563; font-size: 0.95rem; line-height: 1.5; margin: 0; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Invalid or Expired Link</h1>
    <p>This unsubscribe link is invalid or has expired. If you believe this is an error, please contact the sender directly.</p>
  </div>
</body>
</html>`);
    }
    return res.status(400).json({
      success: false,
      message: 'Invalid or expired unsubscribe link',
    });
  }

  // If client requests JSON
  if (req.query.format === 'json' || (!req.accepts('html') && req.accepts('json'))) {
    return res.status(200).json({
      success: true,
      message: 'Unsubscribe token is valid',
      email: verified.recipientEmail,
    });
  }

  // HTML Confirmation Landing Page
  const safeEmail = String(verified.recipientEmail)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Unsubscribe Confirmation - MailPulse</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f3f4f6; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 1rem; box-sizing: border-box; }
    .card { background: white; padding: 2.5rem; border-radius: 0.75rem; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); max-width: 460px; width: 100%; }
    h1 { color: #111827; font-size: 1.5rem; margin-top: 0; margin-bottom: 0.75rem; }
    p { color: #4b5563; font-size: 0.95rem; line-height: 1.5; margin-bottom: 1.25rem; }
    .email-badge { background: #f3f4f6; padding: 0.25rem 0.5rem; border-radius: 0.375rem; font-weight: 600; color: #1f2937; word-break: break-all; }
    button { background: #dc2626; color: white; border: none; padding: 0.75rem 1.5rem; border-radius: 0.375rem; font-size: 0.95rem; font-weight: 500; cursor: pointer; width: 100%; transition: background 0.15s ease; }
    button:hover { background: #b91c1c; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Confirm Unsubscribe</h1>
    <p>Are you sure you want to unsubscribe <span class="email-badge">${safeEmail}</span> from this mailing list?</p>
    <form method="POST" action="/api/v1/tracking/unsubscribe/${token}">
      <button type="submit">Unsubscribe from this list</button>
    </form>
  </div>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, private');
  return res.status(200).send(html);
});

/**
 * Public HTTP endpoint to process email opt-out / unsubscribe.
 * Supports RFC 8058 1-click header POST, HTML form submission, and JSON API.
 *
 * Route: POST /api/v1/tracking/unsubscribe/:token
 * Access: Public
 */
export const processUnsubscribe = asyncHandler(async (req, res) => {
  const { token } = req.params;
  const ip = req.ip || req.headers['x-forwarded-for'] || req.socket?.remoteAddress;
  const userAgent = req.headers['user-agent'];

  // RFC 8058 One-Click Header detection
  const isOneClick =
    req.body &&
    (req.body['List-Unsubscribe'] === 'One-Click' ||
      req.headers['list-unsubscribe'] === 'One-Click');

  const source = isOneClick ? 'one-click-header' : 'link';
  const reason = req.body?.reason ? String(req.body.reason).slice(0, 250) : null;

  try {
    const result = await recordUnsubscribeEvent(token, {
      ip,
      userAgent,
      reason,
      source,
    });

    if (isOneClick || req.is('json') || (!req.accepts('html') && req.accepts('json'))) {
      return res.status(200).json({
        success: true,
        message: 'Successfully unsubscribed',
        email: result.email,
      });
    }

    const safeEmail = String(result.email)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Unsubscribed Successfully - MailPulse</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f3f4f6; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 1rem; box-sizing: border-box; }
    .card { background: white; padding: 2.5rem; border-radius: 0.75rem; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); max-width: 460px; width: 100%; text-align: center; }
    .icon { font-size: 2.5rem; color: #16a34a; margin-bottom: 1rem; }
    h1 { color: #111827; font-size: 1.5rem; margin-top: 0; margin-bottom: 0.75rem; }
    p { color: #4b5563; font-size: 0.95rem; line-height: 1.5; margin: 0; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">✓</div>
    <h1>You have been unsubscribed</h1>
    <p><strong>${safeEmail}</strong> will no longer receive marketing emails from this sender.</p>
  </div>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, private');
    return res.status(200).send(html);
  } catch (err) {
    if (req.accepts('html') && !req.accepts('json')) {
      return res.status(400).send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Unsubscribe Error - MailPulse</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f9fafb; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .card { background: white; padding: 2.5rem; border-radius: 0.75rem; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); max-width: 440px; width: 100%; text-align: center; }
    h1 { color: #dc2626; font-size: 1.25rem; margin-bottom: 0.75rem; }
    p { color: #4b5563; font-size: 0.95rem; line-height: 1.5; margin: 0; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Unable to Process Request</h1>
    <p>${err.message || 'The unsubscribe link is invalid or expired.'}</p>
  </div>
</body>
</html>`);
    }

    return res.status(400).json({
      success: false,
      message: err.message || 'Invalid or expired unsubscribe link',
    });
  }
});

export default {
  trackOpen,
  trackClick,
  getUnsubscribe,
  processUnsubscribe,
};

