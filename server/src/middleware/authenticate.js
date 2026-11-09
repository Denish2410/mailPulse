import mongoose from 'mongoose';
import { AppError } from './errorHandler.js';
import User from '../models/User.js';
import { verifyAccessToken } from '../utils/token.js';

/**
 * Authentication Middleware Foundation
 *
 * Validates incoming HTTP requests containing a Bearer JWT access token:
 * - Reads token from the `Authorization: Bearer <token>` header.
 * - Enforces standard Bearer token scheme format.
 * - Verifies token signature, expiration, issuer, audience, and algorithm via token service.
 * - On success: Attaches only verified minimal identity (`req.auth.userId`) to the request.
 * - On failure: Returns a uniform, safe HTTP 401 Unauthorized response without disclosing
 *   internal failure details (such as whether signature, expiration, or claims failed).
 * - Never logs complete tokens or Authorization headers.
 *
 * Architecture Note:
 * This middleware operates statelessly without querying MongoDB on each request.
 * This guarantees fast, lightweight token verification while preserving database resources.
 * Specific account-state guards (e.g., verifying active account status) can be applied
 * downstream where business logic demands it.
 */

/**
 * Express middleware for authenticating requests via Bearer access token.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export const authenticate = (req, res, next) => {
  const authHeader = req.headers.authorization;

  // 1. Validate presence of Authorization header
  if (!authHeader || typeof authHeader !== 'string') {
    return next(
      new AppError('Authentication required. Invalid or missing authorization token.', 401)
    );
  }

  // 2. Validate Bearer scheme format: must consist of exactly "Bearer <token>"
  const parts = authHeader.trim().split(/\s+/);
  if (parts.length !== 2 || parts[0] !== 'Bearer' || !parts[1]) {
    return next(
      new AppError('Authentication required. Invalid or missing authorization token.', 401)
    );
  }

  const token = parts[1];

  // 3. Verify access token signature and validity
  try {
    const decoded = verifyAccessToken(token);

    // 4. Validate presence of user identity claim and attach minimal identity to req.auth
    const rawUserId = decoded.userId || decoded.sub;
    if (!rawUserId || typeof rawUserId !== 'string' || !rawUserId.trim()) {
      return next(
        new AppError('Authentication required. Invalid or missing authorization token.', 401)
      );
    }

    req.auth = {
      userId: rawUserId.trim(),
      tokenVersion: Number.isInteger(decoded.tv) && decoded.tv > 0 ? decoded.tv : 0,
    };

    next();
  } catch {
    // Return a uniform 401 message regardless of exact JWT failure cause (expired, bad signature, etc.)
    return next(
      new AppError('Authentication required. Invalid or missing authorization token.', 401)
    );
  }
};

/**
 * Second step for protected routes: confirms the signed-in account still exists and that the
 * token has not been revoked since it was issued (password reset or "sign out everywhere" bumps
 * the user's `tokenVersion`). One indexed lookup per request; fails closed on database errors.
 * `authenticate` above only proves the token is genuine and unexpired.
 *
 * @type {import('express').RequestHandler}
 */
export const requireLiveSession = async (req, res, next) => {
  const unauthorized = () =>
    next(new AppError('Authentication required. Invalid or missing authorization token.', 401));
  try {
    const userId = req.auth?.userId;
    if (!userId || !mongoose.isValidObjectId(userId)) return unauthorized();

    const user = await User.findById(userId).select('tokenVersion').lean();
    if (!user) return unauthorized();
    if ((user.tokenVersion ?? 0) !== (req.auth.tokenVersion ?? 0)) return unauthorized();
    return next();
  } catch (error) {
    return next(error);
  }
};

/** Use this on routes: verify the token, then check the session is still live. */
export const authenticateSession = [authenticate, requireLiveSession];

export default authenticate;
