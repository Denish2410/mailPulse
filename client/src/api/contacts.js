import apiClient, { getErrorMessage } from '../lib/api.js';

/**
 * Contacts API Service
 *
 * Communicates with MailPulse backend contact management endpoints:
 * - GET    /contacts: List contacts with pagination, search, and domain filtering
 * - POST   /contacts: Create a new contact
 * - PATCH  /contacts/:id: Update an existing contact
 * - DELETE /contacts/:id: Delete a contact
 */

/**
 * Retrieve contacts belonging to the authenticated user with optional pagination and filters.
 *
 * @param {object} [params={}]
 * @param {number|string} [params.page] - Page number (positive integer)
 * @param {number|string} [params.limit] - Page limit (1-100)
 * @param {string} [params.search] - Search query for name or email
 * @param {string} [params.emailDomain] - Filter by email domain
 * @param {import('axios').AxiosRequestConfig} [config={}]
 * @returns {Promise<{ contacts: Array<object>, count: number, pagination: object }>}
 */
export const getContacts = async (params = {}, config = {}) => {
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

  // 3. Search: non-empty trimmed string (reject arrays/objects/whitespace)
  if (typeof params.search === 'string') {
    const trimmed = params.search.trim();
    if (trimmed.length > 0) {
      queryParams.search = trimmed;
    }
  }

  // 4. Email domain: non-empty trimmed string (reject arrays/objects/whitespace)
  if (typeof params.emailDomain === 'string') {
    const trimmed = params.emailDomain.trim().toLowerCase();
    if (trimmed.length > 0) {
      queryParams.emailDomain = trimmed;
    }
  }

  const response = await apiClient.get('/contacts', {
    params: queryParams,
    ...config,
  });

  return response.data?.data;
};

/**
 * Create a new contact.
 * Sends only the supported `name` and `email` fields.
 *
 * @param {{ name: string, email: string }} payload
 * @param {import('axios').AxiosRequestConfig} [config={}]
 * @returns {Promise<object>} Safe contact object
 */
export const createContact = async ({ name, email } = {}, config = {}) => {
  const response = await apiClient.post(
    '/contacts',
    {
      name: typeof name === 'string' ? name.trim() : name,
      email: typeof email === 'string' ? email.trim() : email,
    },
    config
  );
  return response.data?.data?.contact;
};

/**
 * Update an existing contact.
 * Sends only the supported `name` and `email` fields.
 *
 * @param {string} id - Contact ID
 * @param {{ name?: string, email?: string }} payload
 * @param {import('axios').AxiosRequestConfig} [config={}]
 * @returns {Promise<object>} Safe contact object
 */
export const updateContact = async (id, payload = {}, config = {}) => {
  const body = {};
  if (payload.name !== undefined) {
    body.name = typeof payload.name === 'string' ? payload.name.trim() : payload.name;
  }
  if (payload.email !== undefined) {
    body.email = typeof payload.email === 'string' ? payload.email.trim() : payload.email;
  }

  const response = await apiClient.patch(`/contacts/${id}`, body, config);
  return response.data?.data?.contact;
};

/**
 * Delete a contact by ID.
 *
 * @param {string} id - Contact ID
 * @param {import('axios').AxiosRequestConfig} [config={}]
 * @returns {Promise<object>} Deletion response payload
 */
export const deleteContact = async (id, config = {}) => {
  const response = await apiClient.delete(`/contacts/${id}`, config);
  return response.data;
};

export { getErrorMessage };

export default {
  getContacts,
  createContact,
  updateContact,
  deleteContact,
  getErrorMessage,
};
