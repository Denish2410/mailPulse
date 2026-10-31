import crypto from 'node:crypto';
import mongoose from 'mongoose';
import TrackingEvent from '../models/TrackingEvent.js';
import Campaign from '../models/Campaign.js';
import { AppError } from '../middleware/errorHandler.js';

/**
 * 1x1 Transparent GIF buffer (43 bytes)
 * Standard industry pixel for tracking email opens.
 */
export const TRANSPARENT_1X1_GIF = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64'
);

/**
 * Custom error class for tracking token validation failures.
 */
export class TrackingTokenError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TrackingTokenError';
  }
}

/**
 * Resolve the signing secret for tracking tokens.
 *
 * @param {string} [customSecret]
 * @returns {string} Secret key
 */
export const getTrackingSecret = (customSecret) => {
  return (
    customSecret ||
    process.env.TRACKING_SECRET ||
    process.env.JWT_SECRET ||
    'mailpulse-default-tracking-secret-for-hmac'
  );
};

/**
 * Generate a tamper-proof, URL-safe tracking token using HMAC-SHA256.
 *
 * @param {object} payload
 * @param {string} payload.campaignId - Campaign ID
 * @param {string} [payload.recipientId] - Optional contact ID
 * @param {string} payload.recipientEmail - Recipient email
 * @param {'open'|'click'} payload.eventType - Event type
 * @param {string} [payload.targetUrl] - Destination URL for click tracking
 * @param {string} [secret] - Optional secret override
 * @returns {string} URL-safe signed tracking token
 */
export const createTrackingToken = (payload, secret) => {
  if (!payload || typeof payload !== 'object') {
    throw new TypeError('Tracking payload must be a non-null object');
  }

  const { campaignId, recipientId, recipientEmail, eventType, targetUrl } = payload;

  if (!campaignId) {
    throw new Error('campaignId is required in tracking payload');
  }
  if (!recipientEmail) {
    throw new Error('recipientEmail is required in tracking payload');
  }
  if (!['open', 'click'].includes(eventType)) {
    throw new Error('eventType must be open or click');
  }
  if (eventType === 'click' && !targetUrl) {
    throw new Error('targetUrl is required for click tracking tokens');
  }

  // Compact payload structure
  const data = {
    c: campaignId.toString(),
    r: recipientId ? recipientId.toString() : null,
    e: recipientEmail.trim().toLowerCase(),
    t: eventType,
    ...(targetUrl && { u: targetUrl }),
  };

  const jsonStr = JSON.stringify(data);
  const encodedPayload = Buffer.from(jsonStr, 'utf8').toString('base64url');

  const resolvedSecret = getTrackingSecret(secret);
  const signature = crypto
    .createHmac('sha256', resolvedSecret)
    .update(encodedPayload)
    .digest('base64url');

  return `${encodedPayload}.${signature}`;
};

/**
 * Verify and decode an HMAC-signed tracking token.
 *
 * @param {string} token - Signed token
 * @param {string} [secret] - Optional secret override
 * @returns {{ campaignId: string, recipientId: string|null, recipientEmail: string, eventType: 'open'|'click', targetUrl: string|null }}
 * @throws {TrackingTokenError}
 */
export const verifyTrackingToken = (token, secret) => {
  if (typeof token !== 'string' || !token.includes('.')) {
    throw new TrackingTokenError('Invalid tracking token format');
  }

  const [encodedPayload, signature] = token.split('.');
  if (!encodedPayload || !signature) {
    throw new TrackingTokenError('Malformed tracking token parts');
  }

  const resolvedSecret = getTrackingSecret(secret);
  const expectedSignature = crypto
    .createHmac('sha256', resolvedSecret)
    .update(encodedPayload)
    .digest('base64url');

  // Constant-time comparison to prevent timing attacks
  const sigBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);

  if (sigBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(sigBuffer, expectedBuffer)) {
    throw new TrackingTokenError('Invalid tracking token signature');
  }

  try {
    const jsonStr = Buffer.from(encodedPayload, 'base64url').toString('utf8');
    const parsed = JSON.parse(jsonStr);

    if (!parsed.c || !parsed.e || !parsed.t) {
      throw new TrackingTokenError('Missing required claims in tracking token');
    }

    return {
      campaignId: parsed.c,
      recipientId: parsed.r || null,
      recipientEmail: parsed.e,
      eventType: parsed.t,
      targetUrl: parsed.u || null,
    };
  } catch (err) {
    if (err instanceof TrackingTokenError) throw err;
    throw new TrackingTokenError(`Failed to parse tracking token payload: ${err.message}`);
  }
};

/**
 * Injects a 1x1 transparent tracking pixel into the email HTML body.
 *
 * @param {string} htmlContent - Source HTML
 * @param {object} options
 * @param {string} options.campaignId
 * @param {string} [options.recipientId]
 * @param {string} options.recipientEmail
 * @param {string} options.baseUrl - Base API URL (e.g., http://localhost:5000)
 * @param {string} [options.secret]
 * @returns {string} Modified HTML with tracking pixel
 */
export const injectOpenTrackingPixel = (
  htmlContent,
  { campaignId, recipientId, recipientEmail, baseUrl, secret }
) => {
  if (typeof htmlContent !== 'string' || !htmlContent.trim()) {
    return typeof htmlContent === 'string' ? htmlContent : '';
  }

  const cleanBaseUrl = (baseUrl || '').replace(/\/+$/, '');
  const token = createTrackingToken(
    {
      campaignId,
      recipientId,
      recipientEmail,
      eventType: 'open',
    },
    secret
  );

  const pixelUrl = `${cleanBaseUrl}/api/v1/tracking/open/${token}`;
  const pixelTag = `<img src="${pixelUrl}" width="1" height="1" alt="" style="display:none;width:1px;height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;" />`;

  // Place immediately before closing </body> if present, or append to end
  const bodyCloseRegex = /<\/body>/i;
  if (bodyCloseRegex.test(htmlContent)) {
    return htmlContent.replace(bodyCloseRegex, `${pixelTag}</body>`);
  }

  return `${htmlContent}${pixelTag}`;
};

/**
 * Rewrites HTTP/HTTPS anchor links in the email HTML body to route through click tracking.
 * Preserves non-HTTP links (mailto:, tel:, #anchors).
 *
 * @param {string} htmlContent - Source HTML
 * @param {object} options
 * @param {string} options.campaignId
 * @param {string} [options.recipientId]
 * @param {string} options.recipientEmail
 * @param {string} options.baseUrl - Base API URL (e.g., http://localhost:5000)
 * @param {string} [options.secret]
 * @returns {string} Modified HTML with rewritten tracking links
 */
export const rewriteLinksForClickTracking = (
  htmlContent,
  { campaignId, recipientId, recipientEmail, baseUrl, secret }
) => {
  if (typeof htmlContent !== 'string' || !htmlContent.trim()) {
    return typeof htmlContent === 'string' ? htmlContent : '';
  }

  const cleanBaseUrl = (baseUrl || '').replace(/\/+$/, '');

  // Regex matching <a ... href="..." ...> tags
  // Captures: prefix, quote, originalUrl, quote, suffix
  return htmlContent.replace(
    /<a\b([^>]*?)href=(["'])(https?:\/\/[^"'\s>]+)\2([^>]*?)>/gi,
    (match, beforeHref, quote, originalUrl, afterHref) => {
      // Generate unique click token encoding the specific targetUrl
      const token = createTrackingToken(
        {
          campaignId,
          recipientId,
          recipientEmail,
          eventType: 'click',
          targetUrl: originalUrl,
        },
        secret
      );

      const trackedUrl = `${cleanBaseUrl}/api/v1/tracking/click/${token}`;
      return `<a${beforeHref}href=${quote}${trackedUrl}${quote}${afterHref}>`;
    }
  );
};

/**
 * Combines link rewriting and open-pixel injection in a single operation.
 *
 * @param {string} htmlContent
 * @param {object} options
 * @returns {string} Fully tracked HTML content
 */
export const prepareTrackedEmailHtml = (htmlContent, options) => {
  const withRewrittenLinks = rewriteLinksForClickTracking(htmlContent, options);
  return injectOpenTrackingPixel(withRewrittenLinks, options);
};

/**
 * Record an email open event asynchronously.
 *
 * @param {string} token
 * @param {object} [metadata]
 * @param {string} [metadata.ip]
 * @param {string} [metadata.userAgent]
 * @param {string} [secret]
 * @returns {Promise<object>} Recorded event document
 */
export const recordOpenEvent = async (token, { ip, userAgent } = {}, secret) => {
  const verified = verifyTrackingToken(token, secret);

  if (verified.eventType !== 'open') {
    throw new TrackingTokenError('Tracking token is not an open event token');
  }

  const event = await TrackingEvent.create({
    campaignId: verified.campaignId,
    recipientId: verified.recipientId || null,
    recipientEmail: verified.recipientEmail,
    eventType: 'open',
    ip: ip ? ip.toString().slice(0, 100) : null,
    userAgent: userAgent ? userAgent.toString().slice(0, 500) : null,
    timestamp: new Date(),
  });

  return event;
};

/**
 * Record a link click event and validate destination URL safety.
 *
 * @param {string} token
 * @param {object} [metadata]
 * @param {string} [metadata.ip]
 * @param {string} [metadata.userAgent]
 * @param {string} [secret]
 * @returns {Promise<{ targetUrl: string, event: object }>}
 */
export const recordClickEvent = async (token, { ip, userAgent } = {}, secret) => {
  const verified = verifyTrackingToken(token, secret);

  if (verified.eventType !== 'click') {
    throw new TrackingTokenError('Tracking token is not a click event token');
  }

  if (!verified.targetUrl) {
    throw new TrackingTokenError('Click tracking token is missing target destination URL');
  }

  // Enforce protocol safety against open redirects (e.g. javascript: or data:)
  let parsedUrl;
  try {
    parsedUrl = new URL(verified.targetUrl);
  } catch {
    throw new TrackingTokenError('Invalid destination URL in tracking token');
  }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new TrackingTokenError('Invalid destination URL protocol; must be HTTP or HTTPS');
  }

  const event = await TrackingEvent.create({
    campaignId: verified.campaignId,
    recipientId: verified.recipientId || null,
    recipientEmail: verified.recipientEmail,
    eventType: 'click',
    targetUrl: verified.targetUrl,
    ip: ip ? ip.toString().slice(0, 100) : null,
    userAgent: userAgent ? userAgent.toString().slice(0, 500) : null,
    timestamp: new Date(),
  });

  return {
    targetUrl: verified.targetUrl,
    event,
  };
};

/**
 * Retrieve comprehensive campaign tracking analytics and performance summary.
 *
 * @param {string|mongoose.Types.ObjectId} campaignId
 * @param {string|mongoose.Types.ObjectId} [userId] - Optional owner ID for tenancy verification
 * @returns {Promise<object>} Campaign tracking metrics
 */
export const getCampaignTrackingSummary = async (campaignId, userId) => {
  if (!mongoose.isValidObjectId(campaignId)) {
    throw new AppError('Invalid campaign ID format', 400);
  }

  const campaignFilter = { _id: campaignId };
  if (userId) {
    campaignFilter.userId = userId;
  }

  const campaign = await Campaign.findOne(campaignFilter);
  if (!campaign) {
    throw new AppError('Campaign not found.', 404);
  }

  const totalRecipients = Array.isArray(campaign.recipientIds)
    ? campaign.recipientIds.length
    : 0;

  const objectIdCampaign = new mongoose.Types.ObjectId(campaignId.toString());

  // Aggregate metrics using MongoDB pipeline
  const [openStats, clickStats, linkStats, recentEvents] = await Promise.all([
    // 1. Open metrics: total & unique opens
    TrackingEvent.aggregate([
      { $match: { campaignId: objectIdCampaign, eventType: 'open' } },
      {
        $group: {
          _id: null,
          totalOpens: { $sum: 1 },
          uniqueRecipients: { $addToSet: '$recipientEmail' },
        },
      },
      {
        $project: {
          totalOpens: 1,
          uniqueOpens: { $size: '$uniqueRecipients' },
        },
      },
    ]),

    // 2. Click metrics: total & unique clicks
    TrackingEvent.aggregate([
      { $match: { campaignId: objectIdCampaign, eventType: 'click' } },
      {
        $group: {
          _id: null,
          totalClicks: { $sum: 1 },
          uniqueRecipients: { $addToSet: '$recipientEmail' },
        },
      },
      {
        $project: {
          totalClicks: 1,
          uniqueClicks: { $size: '$uniqueRecipients' },
        },
      },
    ]),

    // 3. Per-link click breakdown
    TrackingEvent.aggregate([
      { $match: { campaignId: objectIdCampaign, eventType: 'click', targetUrl: { $ne: null } } },
      {
        $group: {
          _id: '$targetUrl',
          totalClicks: { $sum: 1 },
          uniqueRecipients: { $addToSet: '$recipientEmail' },
        },
      },
      {
        $project: {
          url: '$_id',
          totalClicks: 1,
          uniqueClicks: { $size: '$uniqueRecipients' },
          _id: 0,
        },
      },
      { $sort: { totalClicks: -1, uniqueClicks: -1 } },
      { $limit: 20 },
    ]),

    // 4. Recent engagement events timeline
    TrackingEvent.find({ campaignId: objectIdCampaign })
      .sort({ timestamp: -1 })
      .limit(20)
      .lean(),
  ]);

  const totalOpens = openStats[0]?.totalOpens || 0;
  const uniqueOpens = openStats[0]?.uniqueOpens || 0;
  const totalClicks = clickStats[0]?.totalClicks || 0;
  const uniqueClicks = clickStats[0]?.uniqueClicks || 0;

  // Rate calculations
  const openRate =
    totalRecipients > 0 ? Number(((uniqueOpens / totalRecipients) * 100).toFixed(1)) : 0;
  const clickToDeliveredRate =
    totalRecipients > 0 ? Number(((uniqueClicks / totalRecipients) * 100).toFixed(1)) : 0;
  const clickThroughRate =
    uniqueOpens > 0 ? Number(((uniqueClicks / uniqueOpens) * 100).toFixed(1)) : 0;

  return {
    campaignId: campaign._id.toString(),
    campaignName: campaign.name,
    campaignSubject: campaign.subject,
    status: campaign.status,
    totalRecipients,
    metrics: {
      totalOpens,
      uniqueOpens,
      openRate,
      totalClicks,
      uniqueClicks,
      clickThroughRate,
      clickToDeliveredRate,
    },
    linkBreakdown: linkStats,
    recentActivity: recentEvents.map((evt) => ({
      id: evt._id.toString(),
      eventType: evt.eventType,
      recipientEmail: evt.recipientEmail,
      targetUrl: evt.targetUrl || null,
      timestamp: evt.timestamp,
      userAgent: evt.userAgent || null,
    })),
  };
};

export default {
  TRANSPARENT_1X1_GIF,
  TrackingTokenError,
  createTrackingToken,
  verifyTrackingToken,
  injectOpenTrackingPixel,
  rewriteLinksForClickTracking,
  prepareTrackedEmailHtml,
  recordOpenEvent,
  recordClickEvent,
  getCampaignTrackingSummary,
};

