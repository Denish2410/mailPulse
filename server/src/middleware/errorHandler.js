import { asyncHandler } from '../utils/asyncHandler.js';

/**
 * Custom application error class for operational errors with explicit HTTP status codes.
 */
export class AppError extends Error {
  constructor(message, statusCode = 500, errors = null) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.isOperational = true;
    if (errors) {
      this.errors = errors;
    }
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * 404 Not-Found middleware for unmatched routes.
 * Registered immediately before the centralized error handler.
 */
export const notFound = (req, res, next) => {
  res.status(404).json({
    success: false,
    message: `Route not found: ${req.method} ${req.originalUrl}`,
  });
};

export const notFoundHandler = notFound;

/**
 * Centralized application error handling middleware.
 * Must be registered with four arguments (err, req, res, next).
 */
export const errorHandler = (err, req, res, next) => {
  // 1. Delegate to Express default error handler if response headers have already been sent
  if (res.headersSent) {
    return next(err);
  }

  // 2. Determine HTTP status code: must be a valid 4xx or 5xx; otherwise default to 500
  const rawStatus = err.statusCode || err.status;
  const statusCode =
    typeof rawStatus === 'number' && rawStatus >= 400 && rawStatus < 600
      ? rawStatus
      : 500;

  const isClientError = statusCode >= 400 && statusCode < 500;

  // 3. Log only unexpected internal server errors (5xx); omit expected client errors (4xx)
  if (!isClientError) {
    // Safely log error without printing request bodies, tokens, or credentials
    const errorTitle = err.name || 'Error';
    const errorDetails = err.stack ? err.stack.split('\n')[0] : err.message;
    console.error(`[Server Error] [${req.method || 'UNKNOWN'} ${req.originalUrl || ''}] ${errorTitle}: ${errorDetails}`);
  }

  // 4. Sanitize message: do not expose internal exception details or stack traces to clients
  let clientMessage = isClientError
    ? err.message || 'Client error'
    : 'Internal Server Error';

  // Handle common client parsing errors safely
  if (err.type === 'entity.parse.failed') {
    clientMessage = 'Malformed JSON in request body';
  } else if (err.type === 'entity.too.large') {
    clientMessage = 'Request payload exceeds size limit';
  }

  const response = {
    success: false,
    message: clientMessage,
    ...(isClientError && err.errors && { errors: err.errors }),
  };

  res.status(statusCode).json(response);
};

export { asyncHandler };
export default errorHandler;
