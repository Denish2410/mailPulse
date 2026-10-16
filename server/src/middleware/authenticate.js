import { AppError } from './errorHandler.js';
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
    };

    next();
  } catch {
    // Return a uniform 401 message regardless of exact JWT failure cause (expired, bad signature, etc.)
    return next(
      new AppError('Authentication required. Invalid or missing authorization token.', 401)
    );
  }
};

export default authenticate;
