import { z } from 'zod';
import { ANALYTICS_RANGES, DEFAULT_ANALYTICS_DAYS } from '../services/analytics.service.js';

/**
 * Schema for GET /api/v1/analytics/overview
 * - days: one of 7 | 30 | 90 (default 30). A fixed set keeps aggregation cost bounded.
 */
export const getAnalyticsOverviewSchema = z.object({
  query: z
    .object({
      days: z
        .preprocess(
          (val) => (val === undefined ? DEFAULT_ANALYTICS_DAYS : Number(String(val).trim())),
          z.number().refine((n) => ANALYTICS_RANGES.includes(n), {
            message: `Days must be one of ${ANALYTICS_RANGES.join(', ')}`,
          })
        ),
    })
    .strict(),
});
