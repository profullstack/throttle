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
 * A hundred requests a minute is the default, and every number is then
 * multiplied by `headroom` (5): a heavy reader is never refused, only a
 * caller five times past what the site considers normal. A person reading a
 * site produces a few dozen; a scraper produces that in a second.
 */

import { quotaHeaders, spend } from '@profullstack/x402-gateway';
import { addressOf, fingerprint, presentedCredential } from './identify.js';
import {
  ALWAYS_OPEN,
  DEFAULT_HEADROOM,
  DEFAULT_LIMIT,
  DEFAULT_WINDOW_SECONDS,
  compileRules,
  isGuard,
  matchesAny,
  ruleFor,
  withHeadroom,
} from './rules.js';
import { memoryStore } from './store.js';

/**
 * @param {object} options
 * @param {number} [options.limit=100]              requests per window, per caller, before headroom
 * @param {number} [options.headroom=5]             multiplier on every limit except brute-force guards; 1 to use the numbers as written
 * @param {number} [options.windowSeconds=60]
 * @param {object} [options.gateway]                a @profullstack/x402-gateway; over-limit is answered 402 with its offer
 * @param {object} [options.store]                  shared counter; default is per-process
 * @param {(request: Request) => string|null} [options.identify]  what to count against; default the caller's address
 * @param {(request: Request) => boolean} [options.exempt]        never metered, except on a brute-force guard; prefer `open` rules or `credentialFrom`
 * @param {(request: Request) => string|null} [options.credentialFrom]  what counts as a credential; default an Authorization or X-API-Key header
 * @param {string[]} [options.openPaths]            extra paths never metered
 * @param {Array} [options.rules]                   per-path allowances, most specific wins
 * @param {{limit?: number, ceiling?: number}} [options.credential]  budget for callers presenting a credential
 * @param {{by?: 'ip+ua'|'ip', ceiling?: number}} [options.anonymous]  how uncredentialed callers are bucketed; default per address + user agent, under a per-address ceiling of 5x the rule's limit
 * @param {false|{limit?: number}} [options.subresources]  separate budget for images, fonts, scripts and styles; default 1000
 * @param {(event: object) => void|Promise<void>} [options.onThrottle]  told about every refusal; its errors are swallowed
 */
export function createThrottle(options = {}) {
  const headroom = positiveReal(options.headroom, DEFAULT_HEADROOM);
  const scale = (n) => Math.floor(n * headroom);

  /*
   * Rules inherit the unscaled default and are scaled once afterwards, so a
   * rule that leaves out its limit is not multiplied twice.
   */
  const base = {
    path: '',
    limit: positive(options.limit, DEFAULT_LIMIT),
    windowSeconds: positive(options.windowSeconds, DEFAULT_WINDOW_SECONDS),
    open: false,
    credential: null,
  };
  const defaults = { ...base, limit: scale(base.limit) };

  const store = options.store?.hit ? options.store : memoryStore();
  const rules = compileRules(options.rules, base).map((rule) => withHeadroom(rule, headroom));
  const gateway = options.gateway ?? null;
  const identify = options.identify ?? addressOf;
  /*
   * What counts as a credential. The default reads the request's own auth
   * headers, but a site whose customers arrive in a browser needs its session
   * cookie to count too: a signed-in merchant watching a dashboard is not a
   * scraper, and the alternative -- exempting sessions outright -- hands an
   * unmetered site to anyone willing to sign up first.
   */
  const credentialFrom = options.credentialFrom ?? ((request) => presentedCredential(request.headers));
  const exempt = options.exempt ?? null;
  const onThrottle = options.onThrottle ?? null;

  /**
   * A credentialed caller gets its own, larger budget -- one host running an
   * integration is not one browser. Both buckets are charged: the per-address
   * ceiling is what a caller rotating junk credentials cannot escape, since
   * this layer has not authenticated any of them.
   */
  const credential = options.credential === false ? null : {
    limit: scale(positive(options.credential?.limit, 600)),
    ceiling: scale(positive(options.credential?.ceiling, 1200)),
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

  /*
   * Images, fonts, scripts and styles get a bucket of their own, ten times the
   * page allowance. On 2026-10-23 one refresh of an admin page that listed
   * ~1,500 logos at relative paths spent the whole page allowance in a second,
   * and the page itself answered 402: the reader was billed for markup they
   * did not write. Kept separate rather than exempt, because Sec-Fetch-Dest is
   * a header the client writes; a scraper that claims every page is an image
   * buys itself a bigger bucket, not an unmetered site.
   */
  /*
   * Anonymous callers are counted per address + user agent, so two people
   * behind one NAT (an office, a phone carrier, a university) running
   * different browsers do not share one allowance. A per-address ceiling
   * across all of those buckets is what a caller rotating user agents cannot
   * escape: the UA is a header the client writes, so it may split the
   * allowance but never multiply it past `ceiling` times the rule's limit.
   * `by: 'ip'` is the pre-0.5.0 behaviour, one bucket per address.
   */
  const anonymous = {
    by: options.anonymous?.by === 'ip' ? 'ip' : 'ip+ua',
    ceiling: positiveReal(options.anonymous?.ceiling, 5),
  };

  const subresources = options.subresources === false ? null : {
    limit: scale(positive(options.subresources?.limit, 1000)),
  };

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
   *
   * A brute-force guard is never sold, gateway or not. Its limit is a cap on
   * password guesses, not a reading allowance, and offering a pass at the
   * moment it trips is offering to sell unlimited guessing (0.5.0).
   */
  async function refuse(request, rule, usage, { guard = false, bucket }) {
    const sold = !guard && Boolean(gateway?.enabled);
    if (onThrottle) {
      try {
        await onThrottle({
          url: request.url,
          userAgent: request.headers.get('user-agent') ?? null,
          ua: request.headers.get('user-agent') ?? null,
          bucket,
          limit: rule.limit,
          windowSeconds: rule.windowSeconds,
          count: usage.count,
          sold,
          guard,
        });
      } catch {
        // Telling someone must never cost the caller its answer.
      }
    }
    /*
     * A gateway with no CoinPay key and no payTo cannot take money, and its
     * 402 carries an empty `accepts` list -- a price tag on a locked door. A
     * refusal nobody can buy their way out of is a 429, and saying so is
     * honest about which one this is.
     */
    if (!sold) return tooMany(rule, usage);
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

    const rule = ruleFor(rules, path, defaults);
    if (rule.open) return null;
    const guard = isGuard(rule);

    /*
     * `exempt` never reaches a brute-force guard (0.5.1). Sites wrote it as
     * "the session cookie's name appears in Cookie", which any client can
     * send: `Cookie: site_session=x` then skipped the sign-in limit entirely,
     * because exempt ran before any rule was consulted. A route that must be
     * unmetered is an `open` rule or an `openPaths` entry, both of which are
     * the site's own words about a path, not the caller's about itself.
     */
    if (!guard && exempt && exempt(request)) return null;

    /*
     * Whoever already paid is not metered. The pass is the thing being sold;
     * charging a caller that holds one, or counting it toward an allowance it
     * bought its way out of, is selling the same minute twice.
     *
     * Except on a brute-force guard. A pass buys reading, never guesses: until
     * 0.5.0 a 1 USD pass (or a crawler the gateway welcomed) skipped the
     * sign-in limit entirely, which made unlimited password guessing a
     * product. Guards are metered for everyone.
     */
    if (gateway && !guard) {
      const token = gateway.passFrom(request);
      if (token && (await gateway.verifyPass(token))) return null;
      /*
       * A search crawler whose address matches its name (gateway 0.8+) reads
       * unmetered. Googlebot walks a large site from a handful of addresses,
       * outruns any per-address allowance, and a 402 to it is how a site
       * drops out of the index.
       */
      if (typeof gateway.isWelcome === 'function' && gateway.isWelcome(request)) return null;
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
    /*
     * A brute-force guard is counted per address only. Neither a user agent
     * nor a credential is allowed to split it: both are headers the guesser
     * writes, and each would hand it a fresh budget of guesses.
     */
    if (guard) {
      const usage = await spend(quotaFor(rule), `${rule.path || '*'}:${key}`);
      if (usage?.overLimit) return refuse(request, rule, usage, { guard, bucket: 'guard' });
      return null;
    }

    const honoursCredential = Boolean(credential) && rule.credential !== false;
    const presented = honoursCredential ? credentialFrom(request) : null;
    if (presented) {
      const ceilingRule = { ...rule, limit: rule.credential?.ceiling ?? credential.ceiling };
      const perKeyRule = { ...rule, limit: rule.credential?.limit ?? credential.limit };
      const ceiling = await spend(quotaFor(ceilingRule), `ceiling:${key}`);
      const perKey = await spend(quotaFor(perKeyRule), `cred:${fingerprint(presented)}`);
      /*
       * The host ceiling is what a credential-rotating caller cannot escape,
       * so a denial there beats a healthy per-credential budget.
       */
      if (ceiling?.overLimit) return refuse(request, ceilingRule, ceiling, { bucket: 'credential' });
      if (perKey?.overLimit) return refuse(request, perKeyRule, perKey, { bucket: 'credential' });
      return null;
    }

    if (subresources && isSubresource(request)) {
      const assetRule = { ...rule, limit: subresources.limit };
      const usage = await spend(quotaFor(assetRule), `asset:${rule.path || '*'}:${key}`);
      if (usage?.overLimit) return refuse(request, assetRule, usage, { bucket: 'subresource' });
      return null;
    }

    const scope = rule.path || '*';
    if (anonymous.by === 'ip') {
      const usage = await spend(quotaFor(rule), `${scope}:${key}`);
      if (usage?.overLimit) return refuse(request, rule, usage, { bucket: 'ip' });
      return null;
    }

    /*
     * Both buckets are charged; whichever runs out first refuses. The ceiling
     * is checked first because it is the one a UA-rotating caller hits.
     */
    const ceilingRule = { ...rule, limit: Math.floor(rule.limit * anonymous.ceiling) };
    const ceiling = await spend(quotaFor(ceilingRule), `anon-ceiling:${scope}:${key}`);
    const perAgent = await spend(quotaFor(rule), `${scope}:${key}:ua:${fingerprint(normaliseAgent(request))}`);
    if (ceiling?.overLimit) return refuse(request, ceilingRule, ceiling, { bucket: 'ip-ceiling' });
    if (perAgent?.overLimit) return refuse(request, rule, perAgent, { bucket: 'ip+ua' });
    return null;
  }

  return {
    handle,
    /** For tests and for a site that wants to reclaim memory on demand. */
    store,
    options: { ...defaults, headroom, rules, credential, anonymous, subresources, openPaths, gateway: Boolean(gateway) },
  };
}

/**
 * What a browser fetches to render a page, by its own account
 * (Sec-Fetch-Dest). A navigation says `document`, fetch() and XHR say `empty`;
 * both stay on the page allowance.
 */
const SUBRESOURCE = new Set(['image', 'font', 'style', 'script', 'audio', 'video', 'track', 'manifest']);

export function isSubresource(request) {
  return SUBRESOURCE.has(request.headers.get('sec-fetch-dest') ?? '');
}

/** Trimmed and lowercased; a request with no user agent is its own bucket. */
function normaliseAgent(request) {
  return (request.headers.get('user-agent') ?? '').trim().toLowerCase();
}

function positiveReal(value, fallback) {
  const n = Number(value);
  return value !== undefined && value !== null && Number.isFinite(n) && n >= 1 ? n : fallback;
}

function positive(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}
