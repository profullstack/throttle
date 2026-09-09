/**
 * Where the counts live.
 *
 * The default counts in this process, which means several instances each grant
 * their own allowance. That errs toward generosity, which is the right
 * direction to be wrong in for a free tier -- and a site that wants one shared
 * count across a fleet passes a store of its own. The interface is a single
 * method, so Redis, Postgres or Cloudflare KV is a dozen lines.
 *
 *   { hit(key, windowSeconds): { count, resetSeconds } }
 */

export { memoryQuotaStore as memoryStore } from '@profullstack/x402-gateway';
