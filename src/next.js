import { createThrottle } from './throttle.js';

/**
 * The throttle for Next.js, in `proxy.ts` (Next 16) or `middleware.ts`.
 *
 *   import { throttleProxy } from '@profullstack/throttle/next';
 *   export const proxy = throttleProxy({ gateway });
 *
 * Returning `undefined` means "carry on", which is what the throttle's null
 * becomes. Most apps already have a proxy doing CORS and security headers, so
 * compose instead:
 *
 *   const answer = await throttle.handle(request);
 *   if (answer) return answer;
 *
 * Put it after the crawl gateway and before everything else. The gateway
 * charges crawlers that declare themselves; the throttle charges the ones that
 * do not, and there is no point running CORS on a request about to be refused.
 *
 * Runs at the edge: nothing here imports node:, and the pass is verified with
 * Web Crypto rather than a database.
 */
export function throttleProxy(throttleOrOptions) {
  const throttle =
    throttleOrOptions && typeof throttleOrOptions.handle === 'function'
      ? throttleOrOptions
      : createThrottle(throttleOrOptions);
  return async (request) => (await throttle.handle(request)) ?? undefined;
}
