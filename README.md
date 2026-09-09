# @profullstack/throttle

An app-wide rate limit whose answer to going over is a price, not a 429.

**100 requests a minute, free. Then `402 Payment Required` with an x402 offer**,
settled by CoinPay in USDC. It meters *every* route, so a scraper wearing a
browser user agent is charged like any other crawler.

```bash
npm i @profullstack/throttle
```

## Why

Every site in our fleet had a rate limiter in its middleware. Each one was
hand-rolled, and each one was scoped to `/api/`.

Then a headless browser in Singapore found a block explorer that had shipped
fifteen hours earlier, and spent two days walking it: **19,000 URLs a day**, a
fresh visitor id on every hit, a plain `Chrome/145` user agent, every page
rendered server-side against a metered upstream API.

Nothing stopped it.

- It was not on a crawler list, because it declared nothing.
- It was not rate limited, because it never touched `/api/`.
- The analytics counted every hit as a **human visit**.

The limiter we had was protecting the routes nobody was attacking. So: meter
everything, and when a caller goes over, sell it a pass.

429 is the right answer when you have nothing to sell. We do. The moment the
allowance runs out is the best sales pitch a site will ever get, because the
caller has just demonstrated it wants more than the free tier and is still
holding the request open.

## Use it

```js
// src/proxy.ts — Next 16 middleware
import { createGateway } from '@profullstack/x402-gateway';
import { createThrottle } from '@profullstack/throttle';

const gateway = createGateway({
  siteUrl: 'https://example.com',
  coinpay: { apiKey: process.env.COINPAY_X402_KEY },
  payTo: process.env.CRAWL_PAY_TO,
});

const throttle = createThrottle({
  gateway,                       // over the limit → 402 with an offer
  limit: 100,                    // the default; per caller, per minute
  exempt: (request) => hasSession(request),
  rules: [
    { path: '/api/auth/', limit: 10, credential: false },
    { path: '/health', open: true },
  ],
});

export async function proxy(request) {
  const answer = await throttle.handle(request);
  if (answer) return answer;
  return NextResponse.next();
}
```

`handle` returns a `Response` to send, or `null` to carry on. Adapters for
[Next](#nextjs) and [Hono](#hono) are one line on top of it.

Without a `gateway` the same throttle answers `429` with `Retry-After`. That is
the fallback, not the goal.

## What a refused caller sees

```
HTTP/1.1 402 Payment Required
ratelimit-limit: 100
ratelimit-remaining: 0
ratelimit-reset: 41
```
```json
{
  "x402Version": 2,
  "accepts": [{ "scheme": "exact", "network": "base", "amount": "1000000", "…": "…" }],
  "error": "Free allowance used: 100 requests per 60s. It resets in 41s. A pass removes the limit for 1.00 USD a day.",
  "pass": { "price": "1.00 USD", "minutes": 1440, "buy": "https://example.com/crawl" }
}
```

Ask for `text/html` and you get the sales page instead, which is what makes
this survivable for a person who tripped it by accident.

Pay it, and the pass comes back as the body of a `200`:

```bash
coinpay x402 pay https://example.com/crawl
curl -H "x-crawl-pass: $PASS" https://example.com/whatever
```

A caller holding a live pass is **not metered at all**. The pass is the thing
being sold; counting it against an allowance it bought its way out of would be
selling the same minute twice.

## Options

| Option | Default | |
|---|---|---|
| `limit` | `100` | requests per window, per caller |
| `windowSeconds` | `60` | |
| `gateway` | — | an `@profullstack/x402-gateway`; makes over-limit a 402 |
| `rules` | `[]` | per-path allowances; most specific match wins |
| `credential` | `{ limit: 600, ceiling: 1200 }` | budget for callers presenting one |
| `exempt` | — | never metered, e.g. a signed-in session |
| `openPaths` | — | extra paths never metered |
| `identify` | the caller's address | what to count against |
| `store` | per-process | supply one to share a count across a fleet |
| `onThrottle` | — | told about every refusal; its errors are swallowed |

### Rules

A rule is a path pattern plus the numbers that replace the defaults for it.
Patterns ending in `/` match by prefix, everything else exactly. The most
specific match wins **whatever order they are written in** — the alternative is
a config where moving two lines silently removes the brute-force limit.

```js
rules: [
  { path: '/api/auth/', limit: 10, credential: false },  // sign-in
  { path: '/feed/', limit: 30 },
  { path: '/health', open: true },                       // never metered
]
```

### Credentialed callers

One host running an integration is not one browser, so a request presenting a
credential gets a larger budget. **Both** buckets are charged: the per-address
`ceiling` is what a caller rotating junk credentials cannot escape, since
nothing here has authenticated any of them.

Any auth scheme counts, not just `Bearer` — matching Bearer alone once dropped
a signed wallet's bulk payout into the anonymous bucket, which it exhausted in
seconds.

`credential: false` on a rule keeps it address-bucketed however the request is
authenticated. **The sign-in routes need this**, or a brute-force attempt bolts
an `Authorization` header onto every guess and buys itself the integration
budget.

### Never metered

`/robots.txt`, `/favicon.ico`, `/.well-known/`, and — when a gateway is
supplied — its sales page and open paths, read off the gateway rather than
restated. A paywall you cannot reach to pay is a wall.

A caller we cannot identify is also within the allowance. Our own edge failing
to hand us an address is our gap, and charging someone for it would be charging
them for our gap.

## Nextjs

```js
import { throttleProxy } from '@profullstack/throttle/next';
export const proxy = throttleProxy({ gateway });
export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] };
```

Put it **after** the crawl gateway and before everything else: the gateway
charges crawlers that declare themselves, the throttle charges the ones that do
not, and there is no point running CORS on a request about to be refused.

Runs at the edge — nothing imports `node:`, and the pass is verified with Web
Crypto rather than a database.

## Hono

```js
import { throttle } from '@profullstack/throttle/hono';
app.use('*', throttle({ gateway }));
```

## On rotating addresses

Rotating addresses defeats an address bucket. That is not a hole to be plugged,
it is the argument the 402 makes: residential proxy bandwidth is sold by the
gigabyte at prices that pass a dollar inside the first day of any serious
crawl, and a rotation still fetches every page one at a time.

Anyone spending more on proxies than the pass costs, in order to avoid the
pass, has made an arithmetic mistake rather than beaten a detector. Detection
is a race. Price is not.

## Counting

The default counter lives in the process, so several instances each grant their
own allowance. That errs toward generosity, which is the right direction to be
wrong in for a free tier. Pass a `store` to share one count across a fleet — the
interface is a single method, so Redis or Postgres is a dozen lines:

```js
{ hit(key, windowSeconds) { return { count, resetSeconds } } }
```

## License

MIT © Profullstack, LLC
