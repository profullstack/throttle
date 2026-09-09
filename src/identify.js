/**
 * Who a request is counted as.
 *
 * The address, by default. The gateway's `clientIp` is what reads it, because
 * it already knows to take the edge's own hop rather than whatever the client
 * put in `X-Forwarded-For` -- a header the client writes, and which a scraper
 * will happily fill with a fresh address per request if we let it decide.
 *
 * ON ROTATION. Rotating addresses defeats an address bucket. That is not a
 * hole to be plugged, it is the argument the 402 makes: residential proxy
 * bandwidth is sold by the gigabyte, and a rotation still fetches every page
 * one at a time. Anyone spending more on proxies than the pass costs, to avoid
 * the pass, has made an arithmetic mistake rather than beaten a detector.
 * Detection is a race; price is not.
 */

import { clientIp } from '@profullstack/x402-gateway';

/**
 * FNV-1a. A credential must never become a map key we might log or dump, and
 * the counter only ever needs to know that two requests carried the same one.
 */
export function fingerprint(value) {
  let hash = 0x811c9dc5;
  const text = String(value);
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/**
 * The credential a request presents, unverified.
 *
 * Unverified on purpose: this layer decides how much budget a caller gets, and
 * the route handler is what actually authenticates. Any auth scheme counts,
 * not just Bearer -- the CoinPay wallet extension signs with
 * `Authorization: Wallet <id>:<sig>:<ts>`, and matching Bearer alone dropped a
 * bulk payout into the anonymous per-address bucket, which it exhausted in
 * seconds.
 */
export function presentedCredential(headers) {
  const authorization = headers.get('authorization');
  if (authorization) {
    const match = /^(\S+)\s+(\S+)/.exec(authorization.trim());
    if (match) return match[2];
  }
  const apiKey = headers.get('x-api-key')?.trim();
  return apiKey ? apiKey : null;
}

/** The address bucket for a request, or null when the edge gave us nothing. */
export function addressOf(request) {
  const ip = clientIp(request);
  return ip ? String(ip) : null;
}
