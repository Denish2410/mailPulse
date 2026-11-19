import apiClient from '../lib/api.js';

/**
 * Sender accounts API (connected Gmail mailboxes).
 *
 * - GET /sender-accounts: the signed-in user's own accounts (never contains tokens)
 */

/**
 * @param {import('axios').AxiosRequestConfig} [config={}]
 * @returns {Promise<Array<{ id: string, email: string, displayName: string, status: string, canSend: boolean }>>}
 */
export const getSenderAccounts = async (config = {}) => {
  const response = await apiClient.get('/sender-accounts', config);
  return response.data?.data?.senderAccounts ?? [];
};

export default { getSenderAccounts };
