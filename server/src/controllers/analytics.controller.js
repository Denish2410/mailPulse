import mongoose from 'mongoose';
import { AppError } from '../middleware/errorHandler.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { getAnalyticsOverview as buildOverview } from '../services/analytics.service.js';

/**
 * Owner-scoped analytics overview.
 *
 * Route: GET /api/v1/analytics/overview?days=30
 * Access: Protected (Bearer JWT)
 */
export const getAnalyticsOverview = asyncHandler(async (req, res) => {
  const userId = req.auth?.userId;
  if (!userId || !mongoose.isValidObjectId(userId)) {
    throw new AppError('Authentication required. Invalid user identity.', 401);
  }

  const data = await buildOverview(userId, { days: req.query.days });

  res.status(200).json({
    success: true,
    message: 'Analytics overview retrieved successfully',
    data,
  });
});

export default { getAnalyticsOverview };
