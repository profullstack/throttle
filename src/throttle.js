/**
 * An app-wide rate limit whose answer to going over is a price.
 *
 * WHY THIS EXISTS. Every site in the fleet had a rate limiter in its
 * middleware, each one hand-rolled, each one scoped to `/api/`. Then a
 * headless browser in Singapore found a newly shipped block explorer and spent
 * two days walking it: 19,000 URLs a day, one fresh visitor id per hit, a
 * plain `Chrome/145` user agent, every page rendered server-side against a
 * paid upstream API. Nothing stopped it. It was not on a crawler list, because
 * it declared nothing; it was not rate limited, because it never touched
 * `/api/`; and the analytics counted every hit as a human visit. The limiter
 * we had protected the routes nobody was attacking.
 *
 * So: meter everything, and when a caller goes over, sell it a pass. 429 is
 * the right answer when you have nothing to sell. We do. The moment the
 * allowance runs out is the best sales pitch the site will ever get, because
 * the caller has just demonstrated it wants more than the free tier and is
 * still holding the request open.
 *
 * A hundred requests a minute is the default. A person reading a site produces
 * a few dozen; a scraper produces that in a second.
 */

import { quotaHeaders, spend } from '@profullstack/x402-gateway';
import { addressOf, fingerprint, presentedCredential } from './identify.js';
import {
  ALWAYS_OPEN,
  DEFAULT_LIMIT,
  DEFAULT_WINDOW_SECONDS,
  compileRules,
  matchesAny,
  ruleFor,
} from './rules.js';
import { memoryStore } from './store.js';

/**
 * @param {object} options
 * @param {number} [options.limit=100]              requests per window, per caller
 * @param {number} [options.windowSeconds=60]
 * @param {object} [options.gateway]                a @profullstack/x402-gateway; over-limit is answered 402 with its offer
 * @param {object} [options.store]                  shared counter; default is per-process
 * @param {(request: Request) => string|null} [options.identify]  what to count against; default the caller's address
 * @param {(request: Request) => boolean} [options.exempt]        never metered, e.g. a signed-in session
 * @param {string[]} [options.openPaths]            extra paths never metered
 * @param {Array} [options.rules]                   per-path allowances, most specific wins
 * @param {{limit?: number, ceiling?: number}} [options.credential]  budget for callers presenting a credential
 * @param {(event: object) => void|Promise<void>} [options.onThrottle]  told about every refusal; its errors are swallowed
 */
export function createThrottle(options = {}) {
  const defaults = {
    path: '',
    limit: positive(options.limit, DEFAULT_LIMIT),
    windowSeconds: positive(options.windowSeconds, DEFAULT_WINDOW_SECONDS),
    open: false,
    credential: null,
  };

  const store = options.store?.hit ? options.store : memoryStore();
  const rules = compileRules(options.rules, defaults);
  const gateway = options.gateway ?? null;
  const identify = options.identify ?? addressOf;
  const exempt = options.exempt ?? null;
  const onThrottle = options.onThrottle ?? null;

  /**
   * A credentialed caller gets its own, larger budget -- one host running an
   * integration is not one browser. Both buckets are charged: the per-address
   * ceiling is what a caller rotating junk credentials cannot escape, since
   * this layer has not authenticated any of them.
   */
  const credential = options.credential === false ? null : {
    limit: positive(options.credential?.limit, 600),
    ceiling: positive(options.credential?.ceiling, 1200),
  };

  /*
   * The paths a refused caller must still be able to read. Taken off the
   * gateway when there is one, so the sales page it points at in the 402 is
   * never itself throttled -- a paywall you cannot reach to pay is a wall.
   */
  const openPaths = [
    ...ALWAYS_OPEN,
    ...(gateway ? [gateway.options.path, ...(gateway.options.openPaths ?? [])] : []),
    ...(options.openPaths ?? []),
  ];

  const quotaFor = (rule) => ({
    requests: rule.limit,
    windowSeconds: rule.windowSeconds,
    store,
  });

  /** 429, for a site with nothing to sell. */
  const tooMany = (rule, usage) => {
    const headers = {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'retry-after': String(usage.resetSeconds),
      ...quotaHeaders(quotaFor(rule), usage),
    };
    return new Response(
      JSON.stringify(
        {
          error: 'Too many requests',
          limit: rule.limit,
          windowSeconds: rule.windowSeconds,
          retryAfter: usage.resetSeconds,
        },
        null,
        2,
      ),
      { status: 429, headers },
    );
  };

  /**
   * What a caller over the limit is answered with. A gateway that can take
   * money answers 402 with an offer -- or the sales page, if the caller asked
   * for HTML, which is what makes this survivable for a person who tripped it
   * by accident. Without one there is nothing to sell, so 429.
   */
  async function refuse(request, rule, usage) {
    if (onThrottle) {
      try {
        await onThrottle({
          url: request.url,
          userAgent: request.headers.get('user-agent') ?? null,
          limit: rule.limit,
          windowSeconds: rule.windowSeconds,
          count: usage.count,
          sold: Boolean(gateway?.enabled),
        });
      } catch {
        // Telling someone must never cost the caller its answer.
      }
    }
    if (!gateway) return tooMany(rule, usage);
    return gateway.sell(request, {
      usage,
      quota: { requests: rule.limit, windowSeconds: rule.windowSeconds },
    });
  }

  /**
   * The throttle. Null means "not for me, carry on".
   */
  async function handle(request) {
    const path = new URL(request.url).pathname;

    if (matchesAny(openPaths, path)) return null;
    if (exempt && exempt(request)) return null;

    const rule = ruleFor(rules, path, defaults);
    if (rule.open) return null;

    /*
     * Whoever already paid is not metered. The pass is the thing being sold;
     * charging a caller that holds one, or counting it toward an allowance it
     * bought its way out of, is selling the same minute twice.
     */
    if (gateway) {
      const token = gateway.passFrom(request);
      if (token && (await gateway.verifyPass(token))) return null;
    }

    const key = identify(request);
    /*
     * A caller we cannot identify is within the allowance. Our own edge
     * failing to hand us an address is our gap, and charging someone for it
     * would be charging them for our gap.
     */
    if (!key) return null;

    /*
     * A rule can refuse to honour credentials at all (`credential: false`),
     * and the sign-in routes must: auth endpoints stay address-bucketed
     * whatever headers accompany them, or a brute-force attempt would bolt an
     * Authorization header onto every guess and buy itself the integration
     * budget.
     */
    const honoursCredential = Boolean(credential) && rule.credential !== false;
    const presented = honoursCredential ? presentedCredential(request.headers) : null;
    if (presented) {
      const ceilingRule = { ...rule, limit: rule.credential?.ceiling ?? credential.ceiling };
      const perKeyRule = { ...rule, limit: rule.credential?.limit ?? credential.limit };
      const ceiling = await spend(quotaFor(ceilingRule), `ceiling:${key}`);
      const perKey = await spend(quotaFor(perKeyRule), `cred:${fingerprint(presented)}`);
      /*
       * The host ceiling is what a credential-rotating caller cannot escape,
       * so a denial there beats a healthy per-credential budget.
       */
      if (ceiling?.overLimit) return refuse(request, ceilingRule, ceiling);
      if (perKey?.overLimit) return refuse(request, perKeyRule, perKey);
      return null;
    }

    const usage = await spend(quotaFor(rule), `${rule.path || '*'}:${key}`);
    if (usage?.overLimit) return refuse(request, rule, usage);
    return null;
  }

  return {
    handle,
    /** For tests and for a site that wants to reclaim memory on demand. */
    store,
    options: { ...defaults, rules, credential, openPaths, gateway: Boolean(gateway) },
  };
}

function positive(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}
