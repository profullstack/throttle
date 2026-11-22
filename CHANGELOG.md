# Changelog

## 0.5.1 (2026-11-22)

**Security.** `exempt` no longer applies to brute-force guard rules (`guard: true`,
`credential: false`, or an auth-looking path). The throttle used to call
`exempt` before it looked at any rule, and several sites exempted any request
whose `Cookie` header merely contained the session cookie's name. A forged
`Cookie: <name>=x` then skipped every limit, sign-in guards included. Guards
are now metered for everyone; `exempt` still applies to every other rule.

A route that must never be metered belongs in an `open: true` rule or in
`openPaths`. To give signed-in callers a bigger budget, use `credentialFrom`
(a bucket, still under a per-address ceiling), not `exempt`.

## 0.5.0 (2026-11-22)

**Security.** Brute-force guard rules (`guard: true`, `credential: false`, or an
auth-looking path such as `/api/auth/` or `/login`) are no longer touched by the
gateway:

- Over a guard's limit is always a plain `429` (with `retry-after` and the
  `ratelimit-*` headers), never a `402` with `gateway.sell(...)`. `onThrottle`
  reports `sold: false` and `guard: true`.
- A paid pass (`passFrom` / `verifyPass`) and a welcomed crawler (`isWelcome`)
  no longer bypass metering on a guard rule. They still bypass every other rule.
- Guards are counted per address only: neither a user agent nor a credential
  header splits them into fresh budgets.

Before this release a 1 USD pass bought unlimited password guessing on any site
running the throttle with a gateway, and hitting the sign-in limit offered to
sell one. Upgrade every site that configures a gateway.

**Anonymous callers are bucketed by address + user agent.** New option
`anonymous: { by: 'ip+ua' | 'ip', ceiling?: number }`, default
`{ by: 'ip+ua', ceiling: 5 }`. Each address + normalized user agent (trimmed,
lowercased, hashed; empty is its own bucket) gets the rule's limit, and all
agents from one address share a ceiling of `ceiling` times that limit, so
rotating user agents cannot multiply the allowance. `by: 'ip'` restores the
old one-bucket-per-address behaviour. The credential path (600 per credential,
1200 per address ceiling, before headroom) is unchanged.

`onThrottle` events gain `ua` and `bucket` (`ip+ua`, `ip-ceiling`, `ip`,
`credential`, `guard`, `subresource`).
