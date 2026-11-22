# Changelog

## 0.4.3 (2026-11-22)

**Security.** Brute-force guard rules (`guard: true`, `credential: false`, or an
auth-looking path such as `/api/auth/` or `/login`) are no longer touched by the
gateway:

- Over a guard's limit is always a plain `429` (with `retry-after` and the
  `ratelimit-*` headers), never a `402` with `gateway.sell(...)`. `onThrottle`
  reports `sold: false` and a new `guard: true` field.
- A paid pass (`passFrom` / `verifyPass`) and a welcomed crawler (`isWelcome`)
  no longer bypass metering on a guard rule. They still bypass every other rule.

Before this release a 1 USD pass bought unlimited password guessing on any site
running the throttle with a gateway, and hitting the sign-in limit offered to
sell one. Upgrade every site that configures a gateway.

Non-guard behaviour is unchanged.
