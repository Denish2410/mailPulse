import apiClient, { getErrorMessage } from '../lib/api.js';

/**
 * Suppressions API Service
 *
 * - GET    /suppressions        List (page, limit, search, source)
 * - POST   /suppressions        Suppress an address manually
 * - DELETE /suppressions/:id    Remove a removable suppression
 */

export const getSuppressions = async (params = {}, config = {}) => {
  const queryParams = {};
  const page = Number(params.page);
  if (Number.isInteger(page) && page >= 1) queryParams.page = page;
  const limit = Number(params.limit);
  if (Number.isInteger(limit) && limit >= 1 && limit <= 100) queryParams.limit = limit;
  if (typeof params.search === 'string' && params.search.trim()) queryParams.search = params.search.trim();
  if (typeof params.source === 'string' && params.source.trim()) queryParams.source = params.source.trim();

  const response = await apiClient.get('/suppressions', { params: queryParams, ...config });
  return response.data?.data;
};

export const createSuppression = async ({ email, reason } = {}, config = {}) => {
  const body = { email: typeof email === 'string' ? email.trim() : email };
  if (typeof reason === 'string' && reason.trim()) body.reason = reason.trim();
  const response = await apiClient.post('/suppressions', body, config);
  return response.data?.data?.suppression;
};

export const deleteSuppression = async (id, config = {}) => {
  const response = await apiClient.delete(`/suppressions/${id}`, config);
  return response.data;
};

export { getErrorMessage };

export default { getSuppressions, createSuppression, deleteSuppression, getErrorMessage };
