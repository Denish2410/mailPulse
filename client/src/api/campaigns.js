import apiClient, { getErrorMessage } from '../lib/api.js';

/**
 * Campaigns API Service
 *
 * Communicates with MailPulse backend campaign management endpoints:
 * - GET    /campaigns: List campaigns with pagination, search, and status filtering
 * - GET    /campaigns/:id: Retrieve single campaign by ID
 * - POST   /campaigns: Create a new campaign draft
 * - PATCH  /campaigns/:id: Update an existing campaign draft
 * - DELETE /campaigns/:id: Delete a campaign draft
 * - POST   /campaigns/:id/send: Send a ready draft to its recipients (Phase 5)
 * - GET    /campaigns/:id/deliveries: Per-recipient delivery log (Phase 5)
 */

/**
 * Retrieve campaign drafts belonging to the authenticated user with optional pagination and filters.
 *
 * @param {object} [params={}]
 * @param {number|string} [params.page] - Page number (positive integer)
 * @param {number|string} [params.limit] - Page limit (1-100)
 * @param {string} [params.search] - Search query for campaign name or subject
 * @param {string} [params.status] - Filter by campaign status (e.g. 'draft')
 * @param {import('axios').AxiosRequestConfig} [config={}]
 * @returns {Promise<{ campaigns: Array<object>, count: number, pagination: object }>}
 */
export const getCampaigns = async (params = {}, config = {}) => {
  const queryParams = {};

  // 1. Page: positive integer
  if (params.page !== undefined && params.page !== null) {
    const pageNum = Number(params.page);
    if (Number.isInteger(pageNum) && pageNum >= 1) {
      queryParams.page = pageNum;
    }
  }

  // 2. Limit: positive integer between 1 and 100
  if (params.limit !== undefined && params.limit !== null) {
    const limitNum = Number(params.limit);
    if (Number.isInteger(limitNum) && limitNum >= 1 && limitNum <= 100) {
      queryParams.limit = limitNum;
    }
  }

  // 3. Search: non-empty trimmed string
  if (typeof params.search === 'string') {
    const trimmed = params.search.trim();
    if (trimmed.length > 0) {
      queryParams.search = trimmed;
    }
  }

  // 4. Status: non-empty trimmed string
  if (typeof params.status === 'string') {
    const trimmed = params.status.trim();
    if (trimmed.length > 0) {
      queryParams.status = trimmed;
    }
  }

  const response = await apiClient.get('/campaigns', {
    params: queryParams,
    ...config,
  });

  return response.data?.data;
};

/**
 * Retrieve a single campaign by ID.
 *
 * @param {string} id - Campaign ID
 * @param {import('axios').AxiosRequestConfig} [config={}]
 * @returns {Promise<object>} Safe campaign object
 */
export const getCampaignById = async (id, config = {}) => {
  const response = await apiClient.get(`/campaigns/${id}`, config);
  return response.data?.data?.campaign;
};

/**
 * Create a new campaign draft.
 * Sends only supported fields: name, subject, textContent, htmlContent, recipientIds.
 * Does NOT send protected fields (userId, status, createdAt, updatedAt, recipientsCount).
 *
 * @param {object} payload
 * @param {string} payload.name
 * @param {string} payload.subject
 * @param {string} [payload.textContent]
 * @param {string} [payload.htmlContent]
 * @param {string[]} [payload.recipientIds]
 * @param {import('axios').AxiosRequestConfig} [config={}]
 * @returns {Promise<object>} Safe campaign object
 */
export const createCampaign = async (payload = {}, config = {}) => {
  const body = {
    name: typeof payload.name === 'string' ? payload.name.trim() : payload.name,
    subject: typeof payload.subject === 'string' ? payload.subject.trim() : payload.subject,
  };

  if (payload.textContent !== undefined) {
    body.textContent = payload.textContent;
  }
  if (payload.htmlContent !== undefined) {
    body.htmlContent = payload.htmlContent;
  }
  if (payload.recipientIds !== undefined) {
    body.recipientIds = Array.isArray(payload.recipientIds)
      ? [...new Set(payload.recipientIds)]
      : payload.recipientIds;
  }

  const response = await apiClient.post('/campaigns', body, config);
  return response.data?.data?.campaign;
};

/**
 * Update an existing campaign draft.
 * Preserves PATCH semantics: omitted properties remain omitted.
 * Explicit empty values (textContent: '', htmlContent: '', recipientIds: []) are preserved.
 * Protected fields are stripped.
 *
 * @param {string} id - Campaign ID
 * @param {object} payload
 * @param {string} [payload.name]
 * @param {string} [payload.subject]
 * @param {string} [payload.textContent]
 * @param {string} [payload.htmlContent]
 * @param {string[]} [payload.recipientIds]
 * @param {import('axios').AxiosRequestConfig} [config={}]
 * @returns {Promise<object>} Safe campaign object
 */
export const updateCampaign = async (id, payload = {}, config = {}) => {
  const body = {};

  if (payload.name !== undefined) {
    body.name = typeof payload.name === 'string' ? payload.name.trim() : payload.name;
  }
  if (payload.subject !== undefined) {
    body.subject = typeof payload.subject === 'string' ? payload.subject.trim() : payload.subject;
  }
  if (payload.textContent !== undefined) {
    body.textContent = payload.textContent;
  }
  if (payload.htmlContent !== undefined) {
    body.htmlContent = payload.htmlContent;
  }
  if (payload.recipientIds !== undefined) {
    body.recipientIds = Array.isArray(payload.recipientIds)
      ? [...new Set(payload.recipientIds)]
      : payload.recipientIds;
  }

  const response = await apiClient.patch(`/campaigns/${id}`, body, config);
  return response.data?.data?.campaign;
};

/**
 * Delete a campaign draft by ID.
 *
 * @param {string} id - Campaign ID
 * @param {import('axios').AxiosRequestConfig} [config={}]
 * @returns {Promise<object>} Deletion response payload
 */
export const deleteCampaign = async (id, config = {}) => {
  const response = await apiClient.delete(`/campaigns/${id}`, config);
  return response.data;
};

/**
 * Retrieve campaign readiness evaluation by ID.
 * Evaluates whether a draft campaign is ready for sending,
 * returning blocking issues and recipient summary.
 *
 * @param {string} id - Campaign ID
 * @param {import('axios').AxiosRequestConfig} [config={}]
 * @returns {Promise<{ isReady: boolean, issues: string[], summary: object }>}
 */
export const getCampaignReadiness = async (id, config = {}) => {
  const response = await apiClient.get(`/campaigns/${id}/readiness`, config);
  return response.data?.data;
};

/**
 * Send a single "[TEST]" copy of a campaign to the authenticated user's own account email.
 *
 * The request body is intentionally empty: the server always resolves the destination from
 * the signed-in account, and never contacts the campaign's recipients. No destination,
 * recipient, cc, or bcc fields are ever sent from the client.
 *
 * Note: success means the email was accepted for delivery ("dispatched"), not that it has
 * reached the inbox.
 *
 * @param {string} id - Campaign ID
 * @param {import('axios').AxiosRequestConfig} [config={}]
 * @returns {Promise<{ destination: string, subject: string, messageId: string, sentAt: string }>}
 */
export const sendCampaignTestEmail = async (id, config = {}) => {
  const response = await apiClient.post(`/campaigns/${id}/test-email`, {}, config);
  return response.data?.data;
};

/**
 * Send a ready campaign draft to all of its eligible recipients.
 *
 * The body is always exactly `{ confirm: true }`: the server sends the stored draft to its
 * stored, owner-verified recipients, so no recipients, addresses, or content are ever sent from
 * the client. The server responds 202 once deliveries are queued; dispatch continues in the
 * background, so poll `getCampaignDeliveries` for progress.
 *
 * @param {string} id - Campaign ID
 * @param {import('axios').AxiosRequestConfig} [config={}]
 * @returns {Promise<{ campaign: object, queuedRecipients: number }>}
 */
export const sendCampaign = async (id, config = {}) => {
  const response = await apiClient.post(`/campaigns/${id}/send`, { confirm: true }, config);
  return response.data?.data;
};

const DELIVERY_STATUSES = ['pending', 'processing', 'sent', 'failed'];

/**
 * Retrieve the per-recipient delivery log of a campaign.
 *
 * @param {string} id - Campaign ID
 * @param {object} [params={}]
 * @param {number|string} [params.page] - Page number (positive integer)
 * @param {number|string} [params.limit] - Page limit (1-100)
 * @param {string} [params.status] - One of pending, processing, sent, failed
 * @param {import('axios').AxiosRequestConfig} [config={}]
 * @returns {Promise<{ campaignStatus: string, summary: object, deliveries: object[], count: number, pagination: object }>}
 */
export const getCampaignDeliveries = async (id, params = {}, config = {}) => {
  const queryParams = {};

  if (params.page !== undefined && params.page !== null) {
    const pageNum = Number(params.page);
    if (Number.isInteger(pageNum) && pageNum >= 1) {
      queryParams.page = pageNum;
    }
  }

  if (params.limit !== undefined && params.limit !== null) {
    const limitNum = Number(params.limit);
    if (Number.isInteger(limitNum) && limitNum >= 1 && limitNum <= 100) {
      queryParams.limit = limitNum;
    }
  }

  if (typeof params.status === 'string' && DELIVERY_STATUSES.includes(params.status.trim())) {
    queryParams.status = params.status.trim();
  }

  const response = await apiClient.get(`/campaigns/${id}/deliveries`, {
    params: queryParams,
    ...config,
  });
  return response.data?.data;
};

export { getErrorMessage };

export default {
  getCampaigns,
  getCampaignById,
  createCampaign,
  updateCampaign,
  deleteCampaign,
  getCampaignReadiness,
  sendCampaignTestEmail,
  sendCampaign,
  getCampaignDeliveries,
  getErrorMessage,
};
