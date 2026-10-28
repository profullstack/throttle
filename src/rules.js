/**
 * Which allowance applies to a request.
 *
 * A site does not have one rate limit, it has a few. Signing in has to be
 * tighter than reading, because ten guesses a minute is a brute-force budget
 * and a hundred is a giveaway. A server-to-server integration has to be looser
 * than a browser, because one host legitimately sends a burst that would look
 * like abuse from a person. Everything else -- every page, every feed, every
 * lookup -- shares one default, and that default is the whole point of this
 * package: it meters routes nobody thought to protect, which is where the
 * scrapers actually are.
 */

/** The house default: a hundred requests a minute, per caller, everywhere. */
export const DEFAULT_LIMIT = 100;
export const DEFAULT_WINDOW_SECONDS = 60;

/**
 * How far above the configured numbers a caller may go before it is refused.
 * Every limit a site writes down is multiplied by this, so the numbers in a
 * config read as "what a normal reader uses" and the throttle only catches
 * callers far past that. On 2026-10-28 people complained that ordinary heavy
 * use was being refused; the limits had been sized to typical consumption
 * with no room above it. Brute-force guards (see `isGuard`) are never scaled.
 */
export const DEFAULT_HEADROOM = 5;

/**
 * Paths whose limit is a brute-force budget, not a reading allowance. Ten
 * guesses a minute at a password is the point of the rule; five times that is
 * a giveaway, so these keep the number the site wrote.
 */
const GUARD_PATH = /(^|[/_-])(auth|oauth|log-?in|sign-?in|sign-?up|register|password|passwd|reset|otp|verify|magic|2fa|mfa|totp)([/_.-]|$)/i;

/**
 * Paths that are never metered, whatever the rules say.
 *
 * A refused caller has to be able to read the terms and buy its way out, or
 * the 402 is a dead end: the sales page, robots.txt and the well-known paths
 * are how a crawler complies. The gateway already knows which those are, so
 * when one is supplied they are read off it rather than restated here.
 */
export const ALWAYS_OPEN = ['/robots.txt', '/favicon.ico', '/.well-known/'];

const trim = (path) => String(path ?? '').trim();

/** Prefix when it ends in `/`, exact match otherwise -- the gateway's rule. */
export function matches(pattern, path) {
  const p = trim(pattern);
  if (!p) return false;
  return p.endsWith('/') ? path.startsWith(p) : path === p;
}

export function matchesAny(patterns, path) {
  return patterns.some((p) => matches(p, path));
}

/**
 * Normalise one rule. A rule is a path pattern plus the numbers that replace
 * the defaults for it; anything it leaves out it inherits, so `{ path:
 * '/api/auth/', limit: 10 }` is a complete rule.
 */
function normaliseRule(rule, defaults) {
  const limit = Number(rule?.limit);
  const windowSeconds = Number(rule?.windowSeconds);
  return {
    path: trim(rule?.path),
    limit: Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : defaults.limit,
    windowSeconds:
      Number.isFinite(windowSeconds) && windowSeconds > 0
        ? Math.floor(windowSeconds)
        : defaults.windowSeconds,
    /**
     * A rule can opt out of metering entirely (`{ path: '/health', open: true }`),
     * which is how an app exempts a route without having to restate the whole
     * skip list.
     */
    open: Boolean(rule?.open),
    /** Credentialed callers on this rule, if it wants different numbers. */
    credential: rule?.credential ?? null,
    /** A brute-force guard: its numbers are never multiplied by headroom. */
    guard: Boolean(rule?.guard),
  };
}

/**
 * Whether a compiled rule is a brute-force guard: marked `guard: true`, marked
 * `credential: false` (the documented sign-in pattern), or on an auth-looking
 * path.
 */
export function isGuard(rule) {
  return Boolean(rule.guard) || rule.credential === false || GUARD_PATH.test(rule.path);
}

/** A rule with its limits multiplied by `headroom`, unless it is a guard. */
export function withHeadroom(rule, headroom) {
  if (headroom === 1 || isGuard(rule)) return rule;
  const credential = rule.credential && typeof rule.credential === 'object'
    ? {
        ...rule.credential,
        ...(rule.credential.limit ? { limit: Math.floor(rule.credential.limit * headroom) } : {}),
        ...(rule.credential.ceiling ? { ceiling: Math.floor(rule.credential.ceiling * headroom) } : {}),
      }
    : rule.credential;
  return { ...rule, limit: Math.floor(rule.limit * headroom), credential };
}

/**
 * Compile the rule list. Longest pattern first, so `/api/auth/` is consulted
 * before `/api/` however the site happened to order them -- the alternative is
 * a config where moving two lines silently removes the brute-force limit.
 */
export function compileRules(rules = [], defaults) {
  return rules
    .filter((rule) => trim(rule?.path))
    .map((rule) => normaliseRule(rule, defaults))
    .sort((a, b) => b.path.length - a.path.length);
}

/** The rule for a path: the most specific match, or the default allowance. */
export function ruleFor(compiled, path, defaults) {
  return compiled.find((rule) => matches(rule.path, path)) ?? defaults;
}
