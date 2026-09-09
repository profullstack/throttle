import type { Gateway, QuotaStore } from '@profullstack/x402-gateway';

/** The house default: a hundred requests a minute, per caller, everywhere. */
export const DEFAULT_LIMIT: 100;
export const DEFAULT_WINDOW_SECONDS: 60;
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
  /** Default 100. */
  limit?: number;
  /** Default 60. */
  windowSeconds?: number;
  /** Over-limit is answered 402 with this gateway's offer instead of 429. */
  gateway?: Gateway | null;
  /** Shared counter. Default: one per process, so each instance grants its own. */
  store?: QuotaStore;
  /** What to count against. Default: the caller's address, as the edge reported it. */
  identify?: (request: Request) => string | null;
  /** Never metered, e.g. a request carrying a signed-in session cookie. */
  exempt?: (request: Request) => boolean;
  /** Extra paths never metered. The gateway's sales page is added for you. */
  openPaths?: string[];
  /** Per-path allowances. Most specific match wins, whatever order they are in. */
  rules?: ThrottleRule[];
  /** Budget for callers presenting a credential. `false` to treat them as anonymous. */
  credential?: false | CredentialBudget;
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
    rules: Required<ThrottleRule>[];
    credential: { limit: number; ceiling: number } | null;
    openPaths: string[];
    gateway: boolean;
  };
}

export function createThrottle(options?: ThrottleOptions): Throttle;

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
