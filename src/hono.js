import { createThrottle } from './throttle.js';

/**
 * The throttle as Hono middleware.
 *
 *   import { throttle } from '@profullstack/throttle/hono';
 *   app.use('*', throttle({ gateway }));
 *
 * Register it before the routes and after the crawl gateway, so a crawler that
 * declares itself is charged by its own list rather than metered first.
 */
export function throttle(throttleOrOptions) {
  const t =
    throttleOrOptions && typeof throttleOrOptions.handle === 'function'
      ? throttleOrOptions
      : createThrottle(throttleOrOptions);
  return async (c, next) => {
    const answer = await t.handle(c.req.raw);
    if (answer) return answer;
    await next();
  };
}
