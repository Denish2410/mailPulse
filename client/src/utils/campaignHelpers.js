/**
 * Pure helper utilities for Campaigns UI
 */

/**
 * Safely format an ISO date string into a user-friendly locale date.
 * Gracefully handles invalid, null, or undefined values without throwing.
 *
 * @param {string|Date|unknown} dateValue
 * @returns {string} Formatted date (e.g. "Oct 21, 2026") or "—" fallback
 */
export const formatCampaignDate = (dateValue) => {
  if (!dateValue) return '—';

  const date = new Date(dateValue);
  if (Number.isNaN(date.getTime())) {
    return '—';
  }

  try {
    return new Intl.DateTimeFormat('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    }).format(date);
  } catch {
    return '—';
  }
};

/**
 * Maps campaign status to human-readable label and Tailwind badge classes.
 *
 * @param {string|unknown} status
 * @returns {{ label: string, pillClass: string }}
 */
export const getCampaignStatusBadge = (status) => {
  const normalized = typeof status === 'string' ? status.trim().toLowerCase() : '';

  switch (normalized) {
    case 'draft':
      return {
        label: 'Draft',
        pillClass: 'bg-amber-500/10 text-amber-300 border border-amber-500/20',
      };
    case 'sending':
      return {
        label: 'Sending',
        pillClass: 'bg-indigo-500/10 text-indigo-300 border border-indigo-500/20',
      };
    case 'sent':
      return {
        label: 'Sent',
        pillClass: 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/20',
      };
    case 'failed':
      return {
        label: 'Failed',
        pillClass: 'bg-rose-500/10 text-rose-300 border border-rose-500/20',
      };
    default:
      return {
        label: normalized ? normalized.charAt(0).toUpperCase() + normalized.slice(1) : 'Unknown',
        pillClass: 'bg-slate-800/80 text-slate-400 border border-slate-700',
      };
  }
};

/**
 * Normalizes a search query string by trimming whitespace.
 *
 * @param {string|unknown} search
 * @returns {string} Cleaned search query
 */
export const normalizeSearchQuery = (search) => {
  if (typeof search !== 'string') return '';
  return search.trim();
};

/**
 * Calculates the appropriate page index after deleting a campaign.
 * If deleting the sole item on page N leaves page N empty,
 * it decrements the page to N - 1 (minimum 1).
 *
 * @param {{ currentPage: number, totalCount: number, limit: number }} options
 * @returns {number} The safe page number to navigate to (minimum 1)
 */
export const computePageAfterDeletion = ({ currentPage = 1, totalCount = 0, limit = 20 } = {}) => {
  const safePage = Math.max(1, Number(currentPage) || 1);
  const safeLimit = Math.max(1, Number(limit) || 20);
  const remainingTotal = Math.max(0, (Number(totalCount) || 0) - 1);

  if (remainingTotal === 0) {
    return 1;
  }

  const remainingTotalPages = Math.ceil(remainingTotal / safeLimit);
  if (safePage > remainingTotalPages) {
    return remainingTotalPages;
  }

  return safePage;
};

/**
 * Toggles a contact ID in an array of selected contact IDs.
 * Returns a new array without mutating the original.
 * Ensures the resulting array contains unique ID strings.
 *
 * @param {Array<string>} selectedIds - Current selected IDs
 * @param {string} idToToggle - ID to add or remove
 * @returns {Array<string>} New selected IDs array
 */
export const toggleRecipientId = (selectedIds = [], idToToggle) => {
  if (!idToToggle || typeof idToToggle !== 'string') {
    return Array.isArray(selectedIds) ? [...selectedIds] : [];
  }

  const current = Array.isArray(selectedIds) ? selectedIds : [];
  const exists = current.includes(idToToggle);

  if (exists) {
    return current.filter((id) => id !== idToToggle);
  }

  return [...new Set([...current, idToToggle])];
};

/**
 * Removes a specific contact ID from an array of selected contact IDs.
 * Returns a new array without mutating the original.
 *
 * @param {Array<string>} selectedIds - Current selected IDs
 * @param {string} idToRemove - ID to remove
 * @returns {Array<string>} New selected IDs array
 */
export const removeRecipientId = (selectedIds = [], idToRemove) => {
  if (!Array.isArray(selectedIds)) return [];
  if (!idToRemove || typeof idToRemove !== 'string') return [...selectedIds];
  return selectedIds.filter((id) => id !== idToRemove);
};

/**
 * Toggles selection for an entire page of contacts.
 * If all selectable contacts on the page are already selected, deselects them.
 * Otherwise, selects all contacts on the page while maintaining uniqueness.
 *
 * @param {Array<string>} currentSelectedIds - Current selected IDs
 * @param {Array<{ id: string }>} pageContacts - Contacts on the current page
 * @returns {Array<string>} New selected IDs array
 */
export const togglePageRecipients = (currentSelectedIds = [], pageContacts = []) => {
  const current = Array.isArray(currentSelectedIds) ? currentSelectedIds : [];
  const pageIds = Array.isArray(pageContacts)
    ? pageContacts.map((c) => c?.id).filter((id) => typeof id === 'string' && id.length > 0)
    : [];

  if (pageIds.length === 0) {
    return [...current];
  }

  const allPageSelected = pageIds.every((id) => current.includes(id));

  if (allPageSelected) {
    const pageIdSet = new Set(pageIds);
    return current.filter((id) => !pageIdSet.has(id));
  }

  return [...new Set([...current, ...pageIds])];
};

/**
 * Safely extracts and normalizes campaign readiness data from either
 * an Axios response, backend API response envelope, or raw payload.
 *
 * Strictly adheres to backend authoritative isReady value.
 * Never invents or fabricates contacts, counts, or readiness status.
 *
 * @param {object|null|undefined} responseOrPayload - Response or readiness payload
 * @returns {{
 *   isReady: boolean,
 *   issues: string[],
 *   summary: {
 *     totalRecipients: number,
 *     eligibleRecipients: Array<{ id: string, name: string, email: string }>,
 *     eligibleRecipientsCount: number,
 *     missingRecipientsCount: number,
 *     hasTextContent: boolean,
 *     hasHtmlContent: boolean,
 *     status: string
 *   }
 * }}
 */
export const extractReadinessData = (responseOrPayload) => {
  if (!responseOrPayload || typeof responseOrPayload !== 'object') {
    return {
      isReady: false,
      issues: [],
      summary: {
        totalRecipients: 0,
        eligibleRecipients: [],
        eligibleRecipientsCount: 0,
        missingRecipientsCount: 0,
        hasTextContent: false,
        hasHtmlContent: false,
        status: '',
      },
    };
  }

  // Unpack Axios response or backend envelope if wrapped
  let raw = responseOrPayload;
  if (raw.data && typeof raw.data === 'object' && !Array.isArray(raw.data)) {
    if (raw.data.data && typeof raw.data.data === 'object' && !Array.isArray(raw.data.data)) {
      raw = raw.data.data;
    } else if ('isReady' in raw.data || 'issues' in raw.data || 'summary' in raw.data) {
      raw = raw.data;
    }
  }

  // Authoritative isReady: strictly true only if backend explicitly set isReady === true
  const isReady = raw.isReady === true;

  // Extract issues array safely (trimmed, non-empty strings)
  const issues = Array.isArray(raw.issues)
    ? raw.issues
        .filter((issue) => typeof issue === 'string' && issue.trim().length > 0)
        .map((issue) => issue.trim())
    : [];

  // Extract summary safely
  const rawSummary =
    raw.summary && typeof raw.summary === 'object' && !Array.isArray(raw.summary)
      ? raw.summary
      : {};

  const totalRecipients = Math.max(0, Number(rawSummary.totalRecipients) || 0);
  const eligibleRecipientsCount = Math.max(0, Number(rawSummary.eligibleRecipientsCount) || 0);
  const missingRecipientsCount = Math.max(0, Number(rawSummary.missingRecipientsCount) || 0);
  const hasTextContent = Boolean(rawSummary.hasTextContent);
  const hasHtmlContent = Boolean(rawSummary.hasHtmlContent);
  const status = typeof rawSummary.status === 'string' ? rawSummary.status.trim() : '';

  const eligibleRecipients = Array.isArray(rawSummary.eligibleRecipients)
    ? rawSummary.eligibleRecipients
        .filter((recipient) => recipient && typeof recipient === 'object' && !Array.isArray(recipient))
        .map((recipient) => ({
          id: String(recipient.id || recipient._id || ''),
          name: typeof recipient.name === 'string' ? recipient.name : '',
          email: typeof recipient.email === 'string' ? recipient.email : '',
        }))
        .filter((recipient) => recipient.id.length > 0 || recipient.email.length > 0)
    : [];

  return {
    isReady,
    issues,
    summary: {
      totalRecipients,
      eligibleRecipients,
      eligibleRecipientsCount,
      missingRecipientsCount,
      hasTextContent,
      hasHtmlContent,
      status,
    },
  };
};

/**
 * Formats backend-provided blocking issues for display.
 * Accepts an array of issue strings or an object containing an issues array.
 * Filters out empty or non-string entries and returns clean, trimmed strings.
 *
 * @param {Array<string>|object|null|undefined} issuesOrPayload - Issues array or readiness payload
 * @returns {Array<string>} Formatted array of issue strings
 */
export const formatReadinessIssues = (issuesOrPayload) => {
  if (!issuesOrPayload) {
    return [];
  }

  let rawIssues = issuesOrPayload;
  if (Array.isArray(issuesOrPayload)) {
    rawIssues = issuesOrPayload;
  } else if (typeof issuesOrPayload === 'object') {
    if (Array.isArray(issuesOrPayload.issues)) {
      rawIssues = issuesOrPayload.issues;
    } else if (issuesOrPayload.data && Array.isArray(issuesOrPayload.data.issues)) {
      rawIssues = issuesOrPayload.data.issues;
    } else {
      return [];
    }
  } else {
    return [];
  }

  return rawIssues
    .filter((issue) => typeof issue === 'string' && issue.trim().length > 0)
    .map((issue) => issue.trim());
};

/**
 * Maps readiness boolean to human-readable label and Tailwind badge classes.
 *
 * @param {boolean} isReady
 * @returns {{ label: string, pillClass: string }}
 */
export const getReadinessBadge = (isReady) => {
  if (isReady === true) {
    return {
      label: 'Ready to Send',
      pillClass: 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/20',
    };
  }
  return {
    label: 'Not Ready',
    pillClass: 'bg-amber-500/10 text-amber-300 border border-amber-500/20',
  };
};

/**
 * Creates a presentation summary from validated readiness response data
 * for use in preview UI components.
 *
 * Formats:
 * - Recipient count label ("X eligible recipients", "1 eligible recipient", "0 eligible recipients")
 * - Missing recipients label ("X recipients unavailable", "1 recipient unavailable", "")
 * - Content availability label ("Plain Text & HTML", "Plain Text", "HTML", "No content")
 * - Safe numeric counts and boolean flags
 *
 * @param {object|null|undefined} summaryOrPayload - Readiness summary or full payload
 * @returns {{
 *   recipientsLabel: string,
 *   missingLabel: string,
 *   contentLabel: string,
 *   eligibleRecipientsCount: number,
 *   totalRecipients: number,
 *   missingRecipientsCount: number,
 *   hasTextContent: boolean,
 *   hasHtmlContent: boolean,
 *   hasContent: boolean,
 *   isReady: boolean,
 *   badge: { label: string, pillClass: string }
 * }}
 */
export const formatReadinessSummary = (summaryOrPayload) => {
  // Normalize payload or summary input
  let summary = {};
  let isReady = false;

  if (summaryOrPayload && typeof summaryOrPayload === 'object') {
    if (summaryOrPayload.summary && typeof summaryOrPayload.summary === 'object') {
      summary = summaryOrPayload.summary;
      isReady = summaryOrPayload.isReady === true;
    } else if (summaryOrPayload.data?.summary && typeof summaryOrPayload.data.summary === 'object') {
      summary = summaryOrPayload.data.summary;
      isReady = summaryOrPayload.data.isReady === true;
    } else {
      summary = summaryOrPayload;
      if ('isReady' in summaryOrPayload) {
        isReady = summaryOrPayload.isReady === true;
      }
    }
  }

  const eligibleCount = Math.max(0, Number(summary.eligibleRecipientsCount) || 0);
  const totalCount = Math.max(0, Number(summary.totalRecipients) || 0);
  const missingCount = Math.max(0, Number(summary.missingRecipientsCount) || 0);
  const hasText = Boolean(summary.hasTextContent);
  const hasHtml = Boolean(summary.hasHtmlContent);

  // Recipient label
  let recipientsLabel = `${eligibleCount} eligible recipients`;
  if (eligibleCount === 1) {
    recipientsLabel = '1 eligible recipient';
  }

  // Missing label
  let missingLabel = '';
  if (missingCount === 1) {
    missingLabel = '1 recipient unavailable';
  } else if (missingCount > 1) {
    missingLabel = `${missingCount} recipients unavailable`;
  }

  // Content type label
  let contentLabel = 'No content';
  if (hasText && hasHtml) {
    contentLabel = 'Plain Text & HTML';
  } else if (hasText) {
    contentLabel = 'Plain Text';
  } else if (hasHtml) {
    contentLabel = 'HTML';
  }

  return {
    recipientsLabel,
    missingLabel,
    contentLabel,
    eligibleRecipientsCount: eligibleCount,
    totalRecipients: totalCount,
    missingRecipientsCount: missingCount,
    hasTextContent: hasText,
    hasHtmlContent: hasHtml,
    hasContent: hasText || hasHtml,
    isReady,
    badge: getReadinessBadge(isReady),
  };
};

/**
 * Determines whether a "Send test email" action can be offered for a campaign.
 *
 * Mirrors the server's test-email preconditions so the UI never offers an action that is
 * guaranteed to fail. Recipients are intentionally NOT required: test emails only go to the
 * signed-in user's own address.
 *
 * @param {object|null|undefined} campaign
 * @param {object} [options]
 * @param {boolean} [options.isSending=false] - Whether a test email request is in flight
 * @returns {{ canSend: boolean, reason: string }} reason explains why sending is unavailable
 */
export const getTestEmailAvailability = (campaign, { isSending = false } = {}) => {
  if (!campaign || typeof campaign !== 'object' || !campaign.id) {
    return { canSend: false, reason: 'Campaign is not available.' };
  }
  if (isSending) {
    return { canSend: false, reason: 'A test email is already being sent.' };
  }
  if (campaign.status !== 'draft') {
    return { canSend: false, reason: 'Test emails can only be sent for draft campaigns.' };
  }

  const subject = typeof campaign.subject === 'string' ? campaign.subject.trim() : '';
  if (!subject) {
    return { canSend: false, reason: 'Add an email subject before sending a test email.' };
  }

  const hasText = typeof campaign.textContent === 'string' && campaign.textContent.trim().length > 0;
  const hasHtml = typeof campaign.htmlContent === 'string' && campaign.htmlContent.trim().length > 0;
  if (!hasText && !hasHtml) {
    return { canSend: false, reason: 'Add text or HTML content before sending a test email.' };
  }

  return { canSend: true, reason: '' };
};

/**
 * Builds the user-facing success message after a test email request succeeds.
 * Uses "sent ... check your inbox" wording without promising inbox delivery.
 *
 * @param {object|null|undefined} data - Response data from sendCampaignTestEmail
 * @returns {string}
 */
export const formatTestEmailSuccess = (data) => {
  const destination =
    data && typeof data.destination === 'string' && data.destination.trim()
      ? data.destination.trim()
      : 'your account email';
  return `Test email sent to ${destination}. It may take a minute to arrive; check your spam folder if you don't see it.`;
};

/**
 * Maps a failed test email request to a clear, user-facing message.
 * Never surfaces raw provider or server internals: it relies on the server's sanitized
 * messages and status codes.
 *
 * @param {unknown} error - Axios error (or any thrown value)
 * @returns {string}
 */
export const getTestEmailErrorMessage = (error) => {
  const status = error?.response?.status;
  const body = error?.response?.data;

  switch (status) {
    case 401:
      return 'Your session has expired. Please sign in again.';
    case 403:
      return 'Your account is not permitted to send test emails.';
    case 404:
      return 'This campaign no longer exists. Refresh the list and try again.';
    case 422: {
      const details = Array.isArray(body?.errors)
        ? body.errors
            .map((issue) => (typeof issue?.message === 'string' ? issue.message.trim() : ''))
            .filter(Boolean)
        : [];
      return details.length > 0
        ? `This campaign can't be sent as a test yet: ${details.join(' ')}`
        : "This campaign can't be sent as a test yet. Check its subject and content.";
    }
    case 429:
      return "You've sent several test emails recently. Please wait a few minutes and try again.";
    case 502:
      return 'The email provider could not send the test email. Please try again shortly.';
    case 503:
      return 'Email sending is not configured on the server yet. Ask an administrator to set up SMTP.';
    default:
      break;
  }

  if (typeof body?.message === 'string' && body.message.trim() && status >= 400 && status < 500) {
    return body.message.trim();
  }

  if (error?.code === 'ECONNABORTED' || error?.message?.includes?.('timeout')) {
    return 'The request timed out. Please check your connection and try again.';
  }
  if (error?.message === 'Network Error' || error?.code === 'ERR_NETWORK') {
    return 'Unable to reach the server. Please check your network connection.';
  }

  return 'Failed to send the test email. Please try again.';
};

/**
 * Whether a campaign can still be edited or deleted. Only drafts are mutable; once a send has
 * started the server locks the campaign and keeps it as a record of what was sent.
 *
 * @param {object|null|undefined} campaign
 * @returns {boolean}
 */
export const isCampaignEditable = (campaign) =>
  Boolean(campaign && typeof campaign === 'object' && campaign.status === 'draft');

/**
 * Determines whether the "Send campaign" action can be offered.
 *
 * Mirrors the server's preconditions so the UI never offers a send that is guaranteed to fail.
 * The server re-evaluates readiness itself; this is only a UX guard.
 *
 * @param {object|null|undefined} campaign
 * @param {object|null|undefined} readiness - Parsed readiness data ({ isReady, summary })
 * @param {object} [options]
 * @param {boolean} [options.isSending=false] - Whether a send request is in flight
 * @param {boolean} [options.isLoadingReadiness=false]
 * @returns {{ canSend: boolean, reason: string, recipientCount: number }}
 */
export const getCampaignSendAvailability = (
  campaign,
  readiness,
  { isSending = false, isLoadingReadiness = false } = {}
) => {
  const recipientCount = Number(readiness?.summary?.eligibleRecipientsCount) || 0;

  if (!campaign || typeof campaign !== 'object' || !campaign.id) {
    return { canSend: false, reason: 'Campaign is not available.', recipientCount };
  }
  if (campaign.status !== 'draft') {
    return { canSend: false, reason: 'This campaign has already been sent.', recipientCount };
  }
  if (isSending) {
    return { canSend: false, reason: 'The campaign is being sent.', recipientCount };
  }
  if (isLoadingReadiness || !readiness) {
    return { canSend: false, reason: 'Checking campaign readiness…', recipientCount };
  }
  if (readiness.isReady !== true) {
    return {
      canSend: false,
      reason: 'Resolve the readiness issues before sending.',
      recipientCount,
    };
  }
  if (recipientCount < 1) {
    return { canSend: false, reason: 'Add at least one recipient before sending.', recipientCount };
  }
  return { canSend: true, reason: '', recipientCount };
};

/**
 * Confirmation prompt shown before a campaign is sent.
 *
 * @param {number} recipientCount
 * @returns {string}
 */
export const formatSendConfirmation = (recipientCount) => {
  const count = Number(recipientCount) || 0;
  return `Send this campaign to ${count} ${count === 1 ? 'recipient' : 'recipients'}? This can't be undone, and the campaign can no longer be edited afterwards.`;
};

/**
 * Maps a failed campaign send request to a clear, user-facing message.
 *
 * @param {unknown} error - Axios error (or any thrown value)
 * @returns {string}
 */
export const getSendCampaignErrorMessage = (error) => {
  const status = error?.response?.status;
  const body = error?.response?.data;

  switch (status) {
    case 401:
      return 'Your session has expired. Please sign in again.';
    case 403:
      return 'Your account is not permitted to send campaigns.';
    case 404:
      return 'This campaign no longer exists. Refresh the list and try again.';
    case 409:
      return 'This campaign was changed or has already been sent. Refresh and check its status.';
    case 422: {
      const details = Array.isArray(body?.errors)
        ? body.errors
            .map((issue) => (typeof issue?.message === 'string' ? issue.message.trim() : ''))
            .filter(Boolean)
        : [];
      return details.length > 0
        ? `This campaign isn't ready to send: ${details.join(' ')}`
        : "This campaign isn't ready to send yet.";
    }
    case 429:
      return "You've sent several campaigns recently. Please wait and try again.";
    case 503:
      return 'Email sending is not configured on the server yet. Ask an administrator to set up SMTP.';
    default:
      break;
  }

  if (typeof body?.message === 'string' && body.message.trim() && status >= 400 && status < 500) {
    return body.message.trim();
  }
  if (error?.code === 'ECONNABORTED' || error?.message?.includes?.('timeout')) {
    return 'The request timed out. Check the campaign status before trying again.';
  }
  if (error?.message === 'Network Error' || error?.code === 'ERR_NETWORK') {
    return 'Unable to reach the server. Please check your network connection.';
  }
  return 'Failed to send the campaign. Please try again.';
};

/**
 * Normalizes a delivery summary from the server into safe numbers plus progress.
 *
 * @param {object|null|undefined} summary
 * @returns {{ total: number, pending: number, processing: number, sent: number, failed: number, processed: number, percent: number, isComplete: boolean }}
 */
export const formatDeliverySummary = (summary) => {
  const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : 0);
  const total = num(summary?.total);
  const pending = num(summary?.pending);
  const processing = num(summary?.processing);
  const sent = num(summary?.sent);
  const failed = num(summary?.failed);
  const processed = sent + failed;
  const percent = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;

  return {
    total,
    pending,
    processing,
    sent,
    failed,
    processed,
    percent,
    isComplete: total > 0 && pending === 0 && processing === 0,
  };
};

/**
 * Human-readable explanation of a stored delivery error code.
 *
 * @param {string|null|undefined} code
 * @returns {string}
 */
export const describeDeliveryError = (code) => {
  switch (code) {
    case 'TRANSPORT_ERROR':
      return 'Rejected by the email provider';
    case 'INVALID_MESSAGE':
      return 'Invalid address or message';
    case 'CONFIGURATION_ERROR':
      return 'Email sending not configured';
    case 'INTERRUPTED':
      return 'Interrupted by a server restart (may have been delivered)';
    case 'PERSIST_ERROR':
      return 'Accepted by the provider, but not recorded (likely delivered)';
    case null:
    case undefined:
    case '':
      return '';
    default:
      return 'Unknown error';
  }
};

/**
 * Safely extracts and normalizes campaign tracking analytics data.
 * Gracefully handles null, undefined, or missing nested properties.
 *
 * @param {object|null|undefined} responseOrPayload
 * @returns {{
 *   campaignId: string,
 *   campaignName: string,
 *   campaignSubject: string,
 *   status: string,
 *   totalRecipients: number,
 *   metrics: {
 *     totalOpens: number,
 *     uniqueOpens: number,
 *     openRate: number,
 *     totalClicks: number,
 *     uniqueClicks: number,
 *     clickThroughRate: number,
 *     clickToDeliveredRate: number
 *   },
 *   linkBreakdown: Array<{ url: string, totalClicks: number, uniqueClicks: number }>,
 *   recentActivity: Array<{ id: string, eventType: string, recipientEmail: string, targetUrl: string|null, timestamp: string, userAgent: string|null }>
 * }}
 */
export const extractAnalyticsData = (responseOrPayload) => {
  if (!responseOrPayload || typeof responseOrPayload !== 'object') {
    return {
      campaignId: '',
      campaignName: '',
      campaignSubject: '',
      status: '',
      totalRecipients: 0,
      metrics: {
        totalOpens: 0,
        uniqueOpens: 0,
        openRate: 0,
        totalClicks: 0,
        uniqueClicks: 0,
        clickThroughRate: 0,
        clickToDeliveredRate: 0,
      },
      linkBreakdown: [],
      recentActivity: [],
    };
  }

  let raw = responseOrPayload;
  if (raw.data && typeof raw.data === 'object' && !Array.isArray(raw.data)) {
    if (raw.data.data && typeof raw.data.data === 'object' && !Array.isArray(raw.data.data)) {
      raw = raw.data.data;
    } else if ('metrics' in raw.data || 'campaignId' in raw.data) {
      raw = raw.data;
    }
  }

  const rawMetrics = raw.metrics && typeof raw.metrics === 'object' ? raw.metrics : {};

  return {
    campaignId: String(raw.campaignId || ''),
    campaignName: typeof raw.campaignName === 'string' ? raw.campaignName : '',
    campaignSubject: typeof raw.campaignSubject === 'string' ? raw.campaignSubject : '',
    status: typeof raw.status === 'string' ? raw.status : '',
    totalRecipients: Math.max(0, Number(raw.totalRecipients) || 0),
    metrics: {
      totalOpens: Math.max(0, Number(rawMetrics.totalOpens) || 0),
      uniqueOpens: Math.max(0, Number(rawMetrics.uniqueOpens) || 0),
      openRate: Math.max(0, Number(rawMetrics.openRate) || 0),
      totalClicks: Math.max(0, Number(rawMetrics.totalClicks) || 0),
      uniqueClicks: Math.max(0, Number(rawMetrics.uniqueClicks) || 0),
      clickThroughRate: Math.max(0, Number(rawMetrics.clickThroughRate) || 0),
      clickToDeliveredRate: Math.max(0, Number(rawMetrics.clickToDeliveredRate) || 0),
    },
    linkBreakdown: Array.isArray(raw.linkBreakdown)
      ? raw.linkBreakdown
          .filter((item) => item && typeof item === 'object')
          .map((item) => ({
            url: typeof item.url === 'string' ? item.url : '',
            totalClicks: Math.max(0, Number(item.totalClicks) || 0),
            uniqueClicks: Math.max(0, Number(item.uniqueClicks) || 0),
          }))
      : [],
    recentActivity: Array.isArray(raw.recentActivity)
      ? raw.recentActivity
          .filter((evt) => evt && typeof evt === 'object')
          .map((evt) => ({
            id: String(evt.id || evt._id || ''),
            eventType: evt.eventType === 'click' ? 'click' : 'open',
            recipientEmail: typeof evt.recipientEmail === 'string' ? evt.recipientEmail : '',
            targetUrl: typeof evt.targetUrl === 'string' ? evt.targetUrl : null,
            timestamp: evt.timestamp || '',
            userAgent: typeof evt.userAgent === 'string' ? evt.userAgent : null,
          }))
      : [],
  };
};

/**
 * Formats raw analytics metrics into human-readable strings.
 *
 * @param {object|null|undefined} metrics
 * @returns {{
 *   openRateFormatted: string,
 *   ctrFormatted: string,
 *   clickToDeliveredFormatted: string,
 *   totalOpensFormatted: string,
 *   uniqueOpensFormatted: string,
 *   totalClicksFormatted: string,
 *   uniqueClicksFormatted: string
 * }}
 */
export const formatAnalyticsMetrics = (metrics = {}) => {
  const m = metrics || {};
  return {
    openRateFormatted: `${(Number(m.openRate) || 0).toFixed(1)}%`,
    ctrFormatted: `${(Number(m.clickThroughRate) || 0).toFixed(1)}%`,
    clickToDeliveredFormatted: `${(Number(m.clickToDeliveredRate) || 0).toFixed(1)}%`,
    totalOpensFormatted: (Number(m.totalOpens) || 0).toLocaleString(),
    uniqueOpensFormatted: (Number(m.uniqueOpens) || 0).toLocaleString(),
    totalClicksFormatted: (Number(m.totalClicks) || 0).toLocaleString(),
    uniqueClicksFormatted: (Number(m.uniqueClicks) || 0).toLocaleString(),
  };
};

export default {
  formatCampaignDate,
  isCampaignEditable,
  getCampaignSendAvailability,
  formatSendConfirmation,
  getSendCampaignErrorMessage,
  formatDeliverySummary,
  describeDeliveryError,
  getCampaignStatusBadge,
  normalizeSearchQuery,
  computePageAfterDeletion,
  toggleRecipientId,
  removeRecipientId,
  togglePageRecipients,
  extractReadinessData,
  formatReadinessIssues,
  getReadinessBadge,
  formatReadinessSummary,
  getTestEmailAvailability,
  formatTestEmailSuccess,
  getTestEmailErrorMessage,
  extractAnalyticsData,
  formatAnalyticsMetrics,
};
