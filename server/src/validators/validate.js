import { ZodError } from 'zod';
import { AppError } from '../middleware/errorHandler.js';

/**
 * Format Zod validation issues into structured, human-readable objects
 * @param {import('zod').ZodError} error
 * @returns {Array<{ path: string, message: string }>}
 */
export const formatZodErrors = (error) => {
  return error.issues.map((issue) => ({
    path: issue.path.join('.') || '_root',
    message: issue.message,
  }));
};

/**
 * Reusable Express request validation middleware factory using Zod.
 *
 * Validates request components against a Zod schema supporting:
 * - `body`: Request payload (req.body)
 * - `query`: URL query string parameters (req.query)
 * - `params`: URL route parameters (req.params)
 *
 * Successfully validated and transformed/coerced values are updated on
 * `req.body`, `req.query`, and `req.params`, as well as on `req.validated`.
 *
 * Validation failures are converted into an operational AppError (HTTP 400)
 * and forwarded to the centralized error handler.
 *
 * @param {import('zod').ZodSchema} schema - Zod schema to validate against
 * @returns {import('express').RequestHandler}
 */
export const validate = (schema) => {
  if (!schema || typeof schema.parseAsync !== 'function') {
    throw new Error('validate middleware requires a valid Zod schema with parseAsync method.');
  }

  return async (req, res, next) => {
    try {
      // 1. Identify which request parts the schema expects
      let toValidate = {};
      let isRequestWrapper = false;

      const shape = schema.shape;
      if (shape && typeof shape === 'object') {
        const hasBody = 'body' in shape;
        const hasQuery = 'query' in shape;
        const hasParams = 'params' in shape;

        if (hasBody || hasQuery || hasParams) {
          isRequestWrapper = true;
          if (hasBody) toValidate.body = req.body;
          if (hasQuery) toValidate.query = req.query;
          if (hasParams) toValidate.params = req.params;
        }
      }

      // If schema is not explicitly structured as { body, query, params }, validate req.body by default
      if (!isRequestWrapper) {
        toValidate = req.body;
      }

      // 2. Parse and validate the request data asynchronously
      const parsed = await schema.parseAsync(toValidate);

      // 3. Make successfully validated and transformed data available to downstream handlers
      if (isRequestWrapper) {
        if (parsed.body !== undefined) {
          req.body = parsed.body;
        }
        if (parsed.query !== undefined) {
          req.query = parsed.query;
        }
        if (parsed.params !== undefined) {
          req.params = parsed.params;
        }
        req.validated = parsed;
      } else {
        req.body = parsed;
        req.validated = { body: parsed };
      }

      next();
    } catch (error) {
      if (error instanceof ZodError) {
        // 4. Convert Zod validation failures into an operational AppError (HTTP 400)
        const formattedErrors = formatZodErrors(error);
        return next(new AppError('Validation failed', 400, formattedErrors));
      }

      // 5. Forward any unexpected errors to the centralized error handler
      next(error);
    }
  };
};

export default validate;
