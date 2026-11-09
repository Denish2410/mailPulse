import { AppError } from '../middleware/errorHandler.js';

/**
 * Structural limits applied to request data BEFORE schema validation.
 *
 * Zod builds an issue object for every invalid element, so a single 1 MB request holding a
 * 240,000-element list can balloon the process by ~500 MB and stall the event loop for everyone
 * (a known Zod memory-exhaustion advisory). No legitimate field in this API carries more than
 * MAX_CAMPAIGN_RECIPIENTS (5,000) items, so longer lists are refused up front, cheaply.
 */
export const MAX_ARRAY_ITEMS = 5000;
export const MAX_NESTING_DEPTH = 12;

/**
 * Walks a JSON-like value iteratively (no recursion, so depth cannot overflow the stack) and
 * returns a problem description, or null when the value is within limits.
 *
 * @param {unknown} root
 * @returns {string|null}
 */
export const findStructureProblem = (root) => {
  const stack = [{ value: root, depth: 0 }];
  while (stack.length > 0) {
    const { value, depth } = stack.pop();
    if (value === null || typeof value !== 'object') continue;
    if (depth > MAX_NESTING_DEPTH) return 'Request data is nested too deeply.';

    if (Array.isArray(value)) {
      if (value.length > MAX_ARRAY_ITEMS) return `A list in the request exceeds ${MAX_ARRAY_ITEMS} items.`;
      for (const item of value) {
        if (item !== null && typeof item === 'object') stack.push({ value: item, depth: depth + 1 });
      }
    } else {
      for (const key of Object.keys(value)) {
        const child = value[key];
        if (child !== null && typeof child === 'object') stack.push({ value: child, depth: depth + 1 });
      }
    }
  }
  return null;
};

/**
 * Throws a 400 AppError when any of the given request parts breaks the structural limits.
 *
 * @param {...unknown} parts - e.g. req.body, req.query, req.params
 */
export const assertWithinRequestLimits = (...parts) => {
  for (const part of parts) {
    const problem = findStructureProblem(part);
    if (problem) throw new AppError(problem, 400);
  }
};
