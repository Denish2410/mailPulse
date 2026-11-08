/**
 * Resolves the Express "trust proxy" setting from TRUST_PROXY.
 *
 * Behind a reverse proxy or load balancer every request would otherwise appear to come from the
 * proxy's IP, so all users would share one rate-limit bucket. Set TRUST_PROXY to the NUMBER of
 * proxy hops in front of the app (e.g. 1 for nginx alone, 2 for Caddy -> nginx). Trusting more
 * hops than really exist lets clients spoof their IP through X-Forwarded-For, so unset (the
 * default) means "trust nothing".
 *
 * Also accepts Express keywords such as "loopback" or a comma-separated list of subnets/IPs.
 *
 * @param {object} [env=process.env]
 * @returns {number|string|false}
 */
export const resolveTrustProxy = (env = process.env) => {
  const raw = String(env.TRUST_PROXY ?? '').trim();
  if (!raw || raw.toLowerCase() === 'false') return false;
  if (/^\d+$/.test(raw)) return Number(raw);
  return raw;
};
