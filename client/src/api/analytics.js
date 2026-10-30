import apiClient, { getErrorMessage } from '../lib/api.js';

/**
 * Analytics API Service (Phase 6)
 * - GET /analytics/overview?days=7|30|90
 */
export const ANALYTICS_RANGES = [7, 30, 90];
export const DEFAULT_ANALYTICS_DAYS = 30;

/**
 * @param {{ days?: number|string }} [params]
 * @param {import('axios').AxiosRequestConfig} [config]
 */
export const getAnalyticsOverview = async (params = {}, config = {}) => {
  const days = Number(params.days);
  const queryParams = { days: ANALYTICS_RANGES.includes(days) ? days : DEFAULT_ANALYTICS_DAYS };
  const response = await apiClient.get('/analytics/overview', { params: queryParams, ...config });
  return response.data?.data;
};

export { getErrorMessage };

export default { getAnalyticsOverview };
