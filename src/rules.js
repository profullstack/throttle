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
  };
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
