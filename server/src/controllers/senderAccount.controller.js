import mongoose from 'mongoose';
import { AppError } from '../middleware/errorHandler.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import {
  SenderConnectionError,
  startGoogleConnection,
  completeGoogleConnection,
} from '../services/senderConnection.service.js';
import { formatSafeSenderAccount } from '../services/senderAccount.service.js';

/**
 * Sender accounts API (customer Gmail mailboxes). Every handler is scoped to the authenticated
 * user. Responses never contain tokens, authorization codes or provider error bodies.
 */

const requireUserId = (req) => {
  const userId = req.auth?.userId;
  if (!userId || !mongoose.isValidObjectId(userId)) {
    throw new AppError('Authentication required. Invalid user identity.', 401);
  }
  return userId;
};

/** Maps service errors to API errors; 5xx messages are fixed strings, safe to show. */
export const toAppError = (error) => {
  if (error instanceof SenderConnectionError) {
    return new AppError(error.message, error.statusCode, null, { expose: error.statusCode >= 500 });
  }
  return error;
};

const run = (handler) =>
  asyncHandler(async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      throw toAppError(error);
    }
  });

/**
 * POST /api/v1/sender-accounts/google/connect
 * Starts a Gmail connection and returns the Google consent URL to open.
 */
export const connectGoogle = run(async (req, res) => {
  const userId = requireUserId(req);
  const { authorizationUrl, expiresAt } = await startGoogleConnection({ userId });
  res.status(200).json({
    success: true,
    message: 'Open the authorization URL to connect your Gmail account.',
    data: { authorizationUrl, expiresAt },
  });
});

/**
 * POST /api/v1/sender-accounts/google/callback  { state, code }
 * Called by the client's redirect page with the user's own session. Completes the connection.
 */
export const googleCallback = run(async (req, res) => {
  const userId = requireUserId(req);
  const { state, code } = req.body;
  const { account, created } = await completeGoogleConnection({ userId, state, code });
  res.status(created ? 201 : 200).json({
    success: true,
    message: created ? 'Gmail account connected.' : 'Gmail account reconnected.',
    data: { senderAccount: formatSafeSenderAccount(account) },
  });
});
