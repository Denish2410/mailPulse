/**
 * Asynchronous route wrapper utility for Express.
 * Catches any rejected promises or thrown exceptions in async handlers
 * and forwards them to next(), ensuring they reach the centralized error middleware.
 *
 * @param {Function} fn - Async Express request handler function (req, res, next)
 * @returns {import('express').RequestHandler}
 */
export const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

export default asyncHandler;
