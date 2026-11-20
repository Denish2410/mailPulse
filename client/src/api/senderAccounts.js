import apiClient, { getErrorMessage } from '../lib/api.js';

/**
 * Sender accounts API (connected Gmail mailboxes). Responses never contain tokens.
 *
 * - GET  /sender-accounts: the signed-in user's own accounts
 * - POST /sender-accounts/google/connect: start a connection, returns Google's consent URL
 * - POST /sender-accounts/google/callback: finish it with the code and state Google returned
 * - POST /sender-accounts/:id/disconnect: wipe the tokens and disconnect
 */

/**
 * @param {import('axios').AxiosRequestConfig} [config={}]
 * @returns {Promise<Array<{ id: string, email: string, displayName: string, status: string, statusReason: string|null, canSend: boolean }>>}
 */
export const getSenderAccounts = async (config = {}) => {
  const response = await apiClient.get('/sender-accounts', config);
  return response.data?.data?.senderAccounts ?? [];
};

/** @returns {Promise<{ authorizationUrl: string, expiresAt: string }>} */
export const startGoogleConnection = async (config = {}) => {
  const response = await apiClient.post('/sender-accounts/google/connect', {}, config);
  return response.data?.data ?? {};
};

/**
 * Completes a connection. The code and state are sent once in the request body (never in a URL
 * or a log) and are not kept anywhere by this module.
 *
 * @returns {Promise<{ senderAccount: object, created: boolean }>}
 */
export const completeGoogleConnection = async ({ state, code }, config = {}) => {
  const response = await apiClient.post('/sender-accounts/google/callback', { state, code }, config);
  return { senderAccount: response.data?.data?.senderAccount ?? null, created: response.status === 201 };
};

/** @returns {Promise<{ senderAccount: object, revoked: boolean }>} */
export const disconnectSenderAccount = async (id, config = {}) => {
  const response = await apiClient.post(`/sender-accounts/${encodeURIComponent(id)}/disconnect`, {}, config);
  return { senderAccount: response.data?.data?.senderAccount ?? null, revoked: Boolean(response.data?.data?.revoked) };
};

export { getErrorMessage };

export default { getSenderAccounts, startGoogleConnection, completeGoogleConnection, disconnectSenderAccount, getErrorMessage };
