import type { Gateway, QuotaStore } from '@profullstack/x402-gateway';

/** The house default: a hundred requests a minute, per caller, everywhere. */
export const DEFAULT_LIMIT: 100;
export const DEFAULT_WINDOW_SECONDS: 60;
/** Every limit is multiplied by this unless the rule is a brute-force guard. */
export const DEFAULT_HEADROOM: 5;
export const ALWAYS_OPEN: string[];

export interface ThrottleRule {
  /** Prefix when it ends in `/`, exact match otherwise. */
  path: string;
  /** Requests per window on this rule. Inherits the default when absent. */
  limit?: number;
  windowSeconds?: number;
  /** Never metered. */
  open?: boolean;
  /**
   * Credentials on this rule. `false` keeps it address-bucketed however the
   * request is authenticated — what the sign-in routes need.
   */
  credential?: false | { limit?: number; ceiling?: number };
  /**
   * A brute-force guard: its numbers are used as written, never multiplied by
   * headroom. Implied by `credential: false` and by auth-looking paths.
   */
  guard?: boolean;
}

export interface CredentialBudget {
  /** Per credential. Default 600. */
  limit?: number;
  /** Per address, whatever credentials it rotates through. Default 1200. */
  ceiling?: number;
}

export interface ThrottleEvent {
  url: string;
  userAgent: string | null;
  limit: number;
  windowSeconds: number;
  count: number;
  /** Whether the refusal came with something to buy. */
  sold: boolean;
}

export interface ThrottleOptions {
  /** Default 100, before headroom. */
  limit?: number;
  /** Default 60. */
  windowSeconds?: number;
  /**
   * Multiplier on every limit (default, rules, credential budget, subresources)
   * except brute-force guards. Default 5; pass 1 to use the numbers as written.
   */
  headroom?: number;
  /** Over-limit is answered 402 with this gateway's offer instead of 429. */
  gateway?: Gateway | null;
  /** Shared counter. Default: one per process, so each instance grants its own. */
  store?: QuotaStore;
  /** What to count against. Default: the caller's address, as the edge reported it. */
  identify?: (request: Request) => string | null;
  /** Never metered, e.g. a health check. */
  exempt?: (request: Request) => boolean;
  /**
   * What counts as a credential for the larger budget. Default: an
   * `Authorization` or `X-API-Key` header. Supply one that also reads a
   * session cookie so signed-in customers are not metered as anonymous.
   */
  credentialFrom?: (request: Request) => string | null;
  /** Extra paths never metered. The gateway's sales page is added for you. */
  openPaths?: string[];
  /** Per-path allowances. Most specific match wins, whatever order they are in. */
  rules?: ThrottleRule[];
  /** Budget for callers presenting a credential. `false` to treat them as anonymous. */
  credential?: false | CredentialBudget;
  /**
   * Images, fonts, scripts and styles (by Sec-Fetch-Dest) count against their
   * own bucket, so a page full of images never spends the page allowance.
   * Default 1000 per window; `false` counts them with pages.
   */
  subresources?: false | { limit?: number };
  /** Told about every refusal. Its errors are swallowed. */
  onThrottle?: (event: ThrottleEvent) => void | Promise<void>;
}

export interface Throttle {
  /** A Response to send, or null to let the request through. */
  handle: (request: Request) => Promise<Response | null>;
  store: QuotaStore;
  options: {
    limit: number;
    windowSeconds: number;
    headroom: number;
    rules: Required<ThrottleRule>[];
    credential: { limit: number; ceiling: number } | null;
    subresources: { limit: number } | null;
    openPaths: string[];
    gateway: boolean;
  };
}

export function createThrottle(options?: ThrottleOptions): Throttle;
/** Whether Sec-Fetch-Dest names an image, font, style, script or media fetch. */
export function isSubresource(request: Request): boolean;

export function memoryStore(options?: {
  now?: () => number;
  sweepEvery?: number;
}): QuotaStore & { sweep(): void; readonly size: number };

export function fingerprint(value: string): string;
export function presentedCredential(headers: Headers): string | null;
export function addressOf(request: Request): string | null;
export function matches(pattern: string, path: string): boolean;
export function matchesAny(patterns: string[], path: string): boolean;
export function compileRules(
  rules: ThrottleRule[],
  defaults: { limit: number; windowSeconds: number },
): Required<ThrottleRule>[];
export function ruleFor<T>(compiled: Required<ThrottleRule>[], path: string, defaults: T): T;
/** Whether a compiled rule is a brute-force guard (never scaled by headroom). */
export function isGuard(rule: { path: string; credential?: unknown; guard?: boolean }): boolean;
/** A compiled rule with its limits multiplied by `headroom`, unless it is a guard. */
export function withHeadroom<T extends { path: string; limit: number }>(rule: T, headroom: number): T;
