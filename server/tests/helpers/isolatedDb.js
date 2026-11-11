import crypto from 'node:crypto';

/**
 * A MongoDB URI that points at a database used by ONE test file only.
 *
 * Test files share a MongoDB and run in parallel, and some suites sweep for campaigns left in
 * 'sending'. Lease tests create exactly such campaigns (expired, released, abandoned), so they run
 * in their own database to stay out of everyone else's way (and vice versa).
 *
 * @param {string} label
 * @param {string} [baseUri=process.env.MONGODB_URI]
 * @returns {string}
 */
export const isolatedMongoUri = (label, baseUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/mailpulse') => {
  const url = new URL(baseUri);
  const base = url.pathname.replace(/^\//, '') || 'mailpulse';
  url.pathname = `/${base}_${label}_${process.pid}_${crypto.randomBytes(3).toString('hex')}`;
  return url.toString();
};
