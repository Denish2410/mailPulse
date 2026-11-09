import crypto from 'node:crypto';
import mongoose from 'mongoose';
import TrackingEvent from '../models/TrackingEvent.js';
import Campaign from '../models/Campaign.js';
import Contact from '../models/Contact.js';
import Delivery from '../models/Delivery.js';
import Suppression from '../models/Suppression.js';
import { AppError } from '../middleware/errorHandler.js';
import { escapeHtml as escapeHtmlText } from './personalization.service.js';

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
  const secret = customSecret || process.env.TRACKING_SECRET || process.env.JWT_SECRET;
  // Never fall back to a hard-coded value: anyone could forge tracking and unsubscribe tokens
  if (!secret) {
    throw new Error('TRACKING_SECRET (or JWT_SECRET) must be set to sign tracking tokens.');
  }
  return secret;
};

/**
 * One-way, keyed hash of a visitor IP address. Recipients' raw IPs are personal data, so only
 * this value is stored: it is stable (the same address always maps to the same hash, which keeps
 * unique-visitor style counts possible) but cannot be turned back into an address without the
 * server secret.
 *
 * @param {string|null|undefined} ip
 * @returns {string|null} 32 hex characters, or null when there is no IP
 */
export const hashIp = (ip) => {
  if (!ip) return null;
  const key = crypto.createHmac('sha256', getTrackingSecret()).update('mailpulse-ip-hash-v1').digest();
  return crypto.createHmac('sha256', key).update(String(ip).slice(0, 100)).digest('hex').slice(0, 32);
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
  if (!['open', 'click', 'unsubscribe'].includes(eventType)) {
    throw new Error('eventType must be open, click, or unsubscribe');
  }
  if (eventType === 'click' && !targetUrl) {
    throw new Error('targetUrl is required for click tracking tokens');
  }

  // Compact payload structure
  const data = {
    c: campaignId ? campaignId.toString() : null,
    r: recipientId ? recipientId.toString() : null,
    e: recipientEmail.trim().toLowerCase(),
    t: eventType,
    ...(payload.userId && { w: payload.userId.toString() }),
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
      ...(parsed.w && { userId: parsed.w }),
    };
  } catch (err) {
    if (err instanceof TrackingTokenError) throw err;
    throw new TrackingTokenError(`Failed to parse tracking token payload: ${err.message}`);
  }
};

/**
 * Generate a tamper-proof, URL-safe unsubscribe token using HMAC-SHA256.
 *
 * @param {object} payload
 * @param {string} [payload.campaignId] - Optional campaign ID
 * @param {string} [payload.recipientId] - Optional contact ID
 * @param {string} payload.recipientEmail - Recipient email
 * @param {string} payload.userId - Account owner user ID
 * @param {string} [secret] - Optional secret override
 * @returns {string} URL-safe signed unsubscribe token
 */
export const createUnsubscribeToken = (payload, secret) => {
  if (!payload || typeof payload !== 'object') {
    throw new TypeError('Unsubscribe payload must be a non-null object');
  }

  const { campaignId, recipientId, recipientEmail, userId } = payload;

  if (!recipientEmail || typeof recipientEmail !== 'string' || !recipientEmail.trim()) {
    throw new Error('recipientEmail is required in unsubscribe payload');
  }
  if (!userId) {
    throw new Error('userId is required in unsubscribe payload');
  }

  const data = {
    c: campaignId ? campaignId.toString() : null,
    r: recipientId ? recipientId.toString() : null,
    e: recipientEmail.trim().toLowerCase(),
    w: userId.toString(),
    t: 'unsubscribe',
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
 * Verify and decode an HMAC-signed unsubscribe token.
 *
 * @param {string} token - Signed token
 * @param {string} [secret] - Optional secret override
 * @returns {{ campaignId: string|null, recipientId: string|null, recipientEmail: string, userId: string, eventType: 'unsubscribe' }}
 * @throws {TrackingTokenError}
 */
export const verifyUnsubscribeToken = (token, secret) => {
  if (typeof token !== 'string' || !token.includes('.')) {
    throw new TrackingTokenError('Invalid unsubscribe token format');
  }

  const [encodedPayload, signature] = token.split('.');
  if (!encodedPayload || !signature) {
    throw new TrackingTokenError('Malformed unsubscribe token parts');
  }

  const resolvedSecret = getTrackingSecret(secret);
  const expectedSignature = crypto
    .createHmac('sha256', resolvedSecret)
    .update(encodedPayload)
    .digest('base64url');

  const sigBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);

  if (sigBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(sigBuffer, expectedBuffer)) {
    throw new TrackingTokenError('Invalid unsubscribe token signature');
  }

  try {
    const jsonStr = Buffer.from(encodedPayload, 'base64url').toString('utf8');
    const parsed = JSON.parse(jsonStr);

    if (!parsed.e || !parsed.w || parsed.t !== 'unsubscribe') {
      throw new TrackingTokenError('Missing required claims in unsubscribe token');
    }

    return {
      campaignId: parsed.c || null,
      recipientId: parsed.r || null,
      recipientEmail: parsed.e,
      userId: parsed.w,
      eventType: 'unsubscribe',
    };
  } catch (err) {
    if (err instanceof TrackingTokenError) throw err;
    throw new TrackingTokenError(`Failed to parse unsubscribe token payload: ${err.message}`);
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
 * Injects unsubscribe links into HTML and plain text email contents.
 *
 * Supports {{unsubscribeUrl}} and {{unsubscribe}} template merge tags.
 * If no placeholder is found in the HTML, appends a compliant, accessible footer.
 * If text content is present and lacks a placeholder, appends an unsubscribe link.
 *
 * @param {string} html - HTML email body
 * @param {string} text - Plain text email body
 * @param {object} options
 * @param {string} options.unsubscribeUrl - Fully qualified unsubscribe link
 * @returns {{ html: string, text: string }}
 */
export const injectUnsubscribeLinks = (html, text, { unsubscribeUrl, appendToText = false } = {}) => {
  if (!unsubscribeUrl || typeof unsubscribeUrl !== 'string') {
    throw new TypeError('unsubscribeUrl is required');
  }

  let updatedHtml = typeof html === 'string' ? html : '';
  let updatedText = typeof text === 'string' ? text : '';

  const tagPattern = /\{\{\s*(?:unsubscribeUrl|unsubscribe)\s*\}\}/gi;

  // 1. Process HTML
  if (updatedHtml) {
    if (tagPattern.test(updatedHtml)) {
      updatedHtml = updatedHtml.replace(tagPattern, unsubscribeUrl);
    } else {
      const footer = `<div class="mailpulse-unsubscribe-footer" style="margin-top: 32px; padding-top: 16px; border-top: 1px solid #e5e7eb; text-align: center; font-size: 12px; color: #6b7280; font-family: sans-serif;">
  <p style="margin: 0;">Don't want to receive these emails? <a href="${unsubscribeUrl}" style="color: #4b5563; text-decoration: underline;">Unsubscribe here</a>.</p>
</div>`;
      if (/<\/body>/i.test(updatedHtml)) {
        updatedHtml = updatedHtml.replace(/<\/body>/i, `${footer}\n</body>`);
      } else {
        updatedHtml = `${updatedHtml}\n${footer}`;
      }
    }
  }

  // 2. Process Plain Text
  if (updatedText) {
    if (tagPattern.test(updatedText)) {
      updatedText = updatedText.replace(tagPattern, unsubscribeUrl);
    } else if (appendToText) {
      updatedText = `${updatedText}\n\n---\nTo unsubscribe, please visit: ${unsubscribeUrl}`;
    }
  }

  return { html: updatedHtml, text: updatedText };
};

/**
 * Appends the sender's postal address (CAN-SPAM) to the message: a small footer block in the HTML
 * and a trailing line in the plain text. Applied independently of the unsubscribe footer, so it is
 * present even when the author placed {{unsubscribeUrl}} in their own layout. The address is
 * HTML-escaped and flattened to one line per row.
 *
 * @param {string} html
 * @param {string} text
 * @param {string} address
 * @returns {{ html: string, text: string }}
 */
export const appendMailingAddress = (html, text, address) => {
  const clean = typeof address === 'string' ? address.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim() : '';
  if (!clean) return { html, text };

  let outHtml = typeof html === 'string' ? html : '';
  let outText = typeof text === 'string' ? text : '';

  if (outHtml.trim()) {
    const lines = clean.split(/\r?\n/).map((line) => escapeHtmlText(line.trim())).filter(Boolean).join('<br>');
    const block = `<div class="mailpulse-address-footer" style="margin-top: 12px; text-align: center; font-size: 12px; color: #6b7280; font-family: sans-serif;">${lines}</div>`;
    outHtml = /<\/body>/i.test(outHtml)
      ? outHtml.replace(/<\/body>/i, () => `${block}\n</body>`)
      : `${outHtml}\n${block}`;
  }
  if (outText.trim()) {
    outText = `${outText}\n\n${clean.replace(/\r\n/g, '\n')}`;
  }
  return { html: outHtml, text: outText };
};

/**
 * Combines link rewriting, unsubscribe injection, and open-pixel injection in a single operation.
 *
 * @param {string} htmlContent
 * @param {object} options
 * @returns {string} Fully tracked HTML content
 */
export const prepareTrackedEmailHtml = (htmlContent, options = {}) => {
  let processedHtml = rewriteLinksForClickTracking(htmlContent, options);

  if (options.unsubscribeUrl) {
    const unsubResult = injectUnsubscribeLinks(processedHtml, '', {
      unsubscribeUrl: options.unsubscribeUrl,
    });
    processedHtml = unsubResult.html;
  }

  return injectOpenTrackingPixel(processedHtml, options);
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
    ipHash: hashIp(ip),
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
    ipHash: hashIp(ip),
    userAgent: userAgent ? userAgent.toString().slice(0, 500) : null,
    timestamp: new Date(),
  });

  return {
    targetUrl: verified.targetUrl,
    event,
  };
};

/**
 * Records an unsubscribe event, updates Contact, upserts Suppression record, and logs TrackingEvent.
 *
 * @param {string|object} tokenOrPayload - Token string or decoded payload
 * @param {object} [metadata]
 * @param {string} [metadata.ip]
 * @param {string} [metadata.userAgent]
 * @param {string} [metadata.reason]
 * @param {'link'|'one-click-header'|'admin'|'import'} [metadata.source='link']
 * @returns {Promise<{ success: boolean, email: string, isNewSuppression: boolean }>}
 */
export const recordUnsubscribeEvent = async (tokenOrPayload, metadata = {}) => {
  const payload =
    typeof tokenOrPayload === 'string'
      ? verifyUnsubscribeToken(tokenOrPayload)
      : tokenOrPayload;

  if (!payload || !payload.recipientEmail || !payload.userId) {
    throw new TrackingTokenError('Invalid unsubscribe payload: recipientEmail and userId are required');
  }

  const { recipientEmail, userId, campaignId, recipientId } = payload;
  const { ip, userAgent, reason, source = 'link' } = metadata;
  const now = new Date();
  const normalizedEmail = recipientEmail.toLowerCase().trim();

  // 1. Update Contact if exists for this owner
  const contactQuery = recipientId && mongoose.isValidObjectId(recipientId)
    ? { _id: recipientId, userId }
    : { userId, email: normalizedEmail };

  await Contact.updateMany(
    contactQuery,
    {
      $set: {
        isUnsubscribed: true,
        unsubscribedAt: now,
        ...(reason && { unsubscribeReason: String(reason).slice(0, 250) }),
      },
    }
  );

  // 2. Upsert Suppression record to persist across future contact re-creations
  const suppressionResult = await Suppression.updateOne(
    { userId, email: normalizedEmail },
    {
      $setOnInsert: {
        userId,
        email: normalizedEmail,
        campaignId: campaignId && mongoose.isValidObjectId(campaignId) ? campaignId : null,
        reason: reason ? String(reason).slice(0, 250) : null,
        source: ['link', 'one-click-header', 'admin', 'import'].includes(source) ? source : 'link',
        createdAt: now,
      },
    },
    { upsert: true }
  );

  // 3. Record TrackingEvent for auditing and campaign analytics
  if (campaignId && mongoose.isValidObjectId(campaignId)) {
    try {
      await TrackingEvent.create({
        campaignId,
        recipientId: recipientId && mongoose.isValidObjectId(recipientId) ? recipientId : null,
        recipientEmail: normalizedEmail,
        eventType: 'unsubscribe',
        ipHash: hashIp(ip),
        userAgent: userAgent ? String(userAgent).slice(0, 500) : null,
        timestamp: now,
      });
    } catch (eventErr) {
      if (process.env.NODE_ENV !== 'test') {
        console.warn(`[Tracking] Failed to write TrackingEvent for unsubscribe: ${eventErr.message}`);
      }
    }
  }

  return {
    success: true,
    email: normalizedEmail,
    isNewSuppression: Boolean(suppressionResult.upsertedCount > 0),
  };
};

/**
 * A/B subject test results: for each arm, how many recipients it reached and how many of them
 * opened / clicked (unique recipients). Returns null when the campaign has no variant B.
 * Arms are derived from our own Delivery records, so tracking events are only ever attributed
 * to recipients of this campaign.
 *
 * @param {object} campaign - Campaign document (needs _id, subject, subjectB)
 * @returns {Promise<object|null>}
 */
export const getCampaignVariantStats = async (campaign) => {
  if (!campaign.subjectB) return null;

  const campaignId = new mongoose.Types.ObjectId(campaign._id.toString());
  const [deliveries, openers, clickers] = await Promise.all([
    Delivery.find({ campaignId, status: 'sent' }).select('email variant').lean(),
    TrackingEvent.distinct('recipientEmail', { campaignId, eventType: 'open' }),
    TrackingEvent.distinct('recipientEmail', { campaignId, eventType: 'click' }),
  ]);

  const opened = new Set(openers.map((e) => String(e).toLowerCase()));
  const clicked = new Set(clickers.map((e) => String(e).toLowerCase()));
  const arm = (variant, subject) => ({ variant, subject, sent: 0, uniqueOpens: 0, uniqueClicks: 0, openRate: 0, clickRate: 0 });
  const arms = { A: arm('A', campaign.subject), B: arm('B', campaign.subjectB) };

  for (const d of deliveries) {
    const a = arms[d.variant === 'B' ? 'B' : 'A'];
    const email = String(d.email).toLowerCase();
    a.sent += 1;
    if (opened.has(email)) a.uniqueOpens += 1;
    if (clicked.has(email)) a.uniqueClicks += 1;
  }
  for (const a of Object.values(arms)) {
    a.openRate = a.sent > 0 ? Number(((a.uniqueOpens / a.sent) * 100).toFixed(1)) : 0;
    a.clickRate = a.sent > 0 ? Number(((a.uniqueClicks / a.sent) * 100).toFixed(1)) : 0;
  }

  // The leader is only named when both arms have mail out and their open rates differ
  let leader = null;
  if (arms.A.sent > 0 && arms.B.sent > 0 && arms.A.openRate !== arms.B.openRate) {
    leader = arms.A.openRate > arms.B.openRate ? 'A' : 'B';
  }
  return { arms: [arms.A, arms.B], leader };
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
  const [openStats, clickStats, linkStats, recentEvents, unsubscribeStats] = await Promise.all([
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

    // 5. Unsubscribe metrics
    TrackingEvent.countDocuments({ campaignId: objectIdCampaign, eventType: 'unsubscribe' }),
  ]);

  const totalOpens = openStats[0]?.totalOpens || 0;
  const uniqueOpens = openStats[0]?.uniqueOpens || 0;
  const totalClicks = clickStats[0]?.totalClicks || 0;
  const uniqueClicks = clickStats[0]?.uniqueClicks || 0;
  const totalUnsubscribes = typeof unsubscribeStats === 'number' ? unsubscribeStats : 0;

  // Rate calculations
  const openRate =
    totalRecipients > 0 ? Number(((uniqueOpens / totalRecipients) * 100).toFixed(1)) : 0;
  const clickToDeliveredRate =
    totalRecipients > 0 ? Number(((uniqueClicks / totalRecipients) * 100).toFixed(1)) : 0;
  const clickThroughRate =
    uniqueOpens > 0 ? Number(((uniqueClicks / uniqueOpens) * 100).toFixed(1)) : 0;
  const unsubscribeRate =
    totalRecipients > 0 ? Number(((totalUnsubscribes / totalRecipients) * 100).toFixed(1)) : 0;

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
      totalUnsubscribes,
      unsubscribeRate,
    },
    variants: await getCampaignVariantStats(campaign),
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
  hashIp,
  appendMailingAddress,
  getCampaignVariantStats,
  TRANSPARENT_1X1_GIF,
  TrackingTokenError,
  createTrackingToken,
  verifyTrackingToken,
  createUnsubscribeToken,
  verifyUnsubscribeToken,
  injectOpenTrackingPixel,
  rewriteLinksForClickTracking,
  injectUnsubscribeLinks,
  prepareTrackedEmailHtml,
  recordOpenEvent,
  recordClickEvent,
  recordUnsubscribeEvent,
  getCampaignTrackingSummary,
};

