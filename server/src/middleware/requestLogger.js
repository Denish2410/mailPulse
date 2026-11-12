import morgan from 'morgan';

/**
 * Request logging without secrets.
 *
 * Several URLs carry one-time or signed tokens: click, open and unsubscribe tracking links have
 * the token as the last path segment, and reset, verification and confirmation links carry theirs
 * in the query string. Neither may reach the logs, so tracking tokens are replaced and every query
 * string is dropped. The Referer header (which could echo such a URL) is never logged.
 */
const TRACKING_PATH = /^(\/api\/v1\/tracking\/(?:click|open|unsubscribe)\/)[^/?#]*/i;

/**
 * @param {string} [url] - Request URL (path plus optional query string)
 * @returns {string} The URL with tracking tokens and the query string redacted
 */
export const redactUrl = (url) => {
  if (typeof url !== 'string' || url === '') return '-';
  const queryStart = url.search(/[?#]/);
  let path = queryStart === -1 ? url : url.slice(0, queryStart);
  const hasQuery = queryStart !== -1;
  path = path.replace(TRACKING_PATH, '$1[redacted]');
  return hasQuery ? `${path}?[redacted]` : path;
};

morgan.token('safe-url', (req) => redactUrl(req.originalUrl || req.url));

export const COMBINED_SAFE_FORMAT =
  ':remote-addr - :remote-user [:date[clf]] ":method :safe-url HTTP/:http-version" :status :res[content-length] ":user-agent"';
export const DEV_SAFE_FORMAT = ':method :safe-url :status :response-time ms - :res[content-length]';

/**
 * @param {object} [options]
 * @param {boolean} [options.production=false] - Apache "combined"-style lines instead of dev lines
 * @param {import('node:stream').Writable} [options.stream] - Defaults to stdout
 * @param {Function} [options.skip]
 */
export const createRequestLogger = ({ production = false, stream, skip } = {}) =>
  morgan(production ? COMBINED_SAFE_FORMAT : DEV_SAFE_FORMAT, {
    ...(stream && { stream }),
    ...(skip && { skip }),
  });
