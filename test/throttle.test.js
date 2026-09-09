import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createGateway, mintPass } from '@profullstack/x402-gateway';
import { createThrottle } from '../src/index.js';

const SITE = 'https://example.com';
const SECRET = 'cp_live_test_secret_0123456789';
const PAY_TO = '0xCC3b072391AE7A8d10cF00DdC5F61DB2cA5541E5';
const CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

const req = (path = '/explorer/eth/tx/0xabc', extra = {}) =>
  new Request(`${SITE}${path}`, {
    headers: { 'user-agent': CHROME, 'x-real-ip': '203.0.113.5', ...extra },
  });

const gateway = () =>
  createGateway({ siteUrl: SITE, coinpay: { apiKey: SECRET }, payTo: PAY_TO });

/** Send `n` requests, return the first response that refused one. */
async function drain(throttle, n, make = req) {
  let refusal = null;
  for (let i = 0; i < n; i++) {
    const answer = await throttle.handle(make());
    if (answer && !refusal) refusal = answer;
  }
  return refusal;
}

describe('the default allowance', () => {
  it('is a hundred requests a minute, and lets ninety-nine through', async () => {
    const throttle = createThrottle({});
    assert.equal(throttle.options.limit, 100);
    assert.equal(throttle.options.windowSeconds, 60);
    for (let i = 0; i < 100; i++) {
      assert.equal(await throttle.handle(req()), null, `request ${i + 1}`);
    }
    assert.ok(await throttle.handle(req()), 'the 101st is refused');
  });

  it('meters page routes, not just /api/', async () => {
    // The whole point: the scraper that started this walked /explorer/**,
    // which every /api/-scoped limiter in the fleet ignored.
    const throttle = createThrottle({ limit: 2 });
    await throttle.handle(req('/explorer/btc/address/bc1q'));
    await throttle.handle(req('/explorer/sol/tx/5LU'));
    assert.ok(await throttle.handle(req('/explorer/xrp/block/1')));
  });

  it('counts each caller separately', async () => {
    const throttle = createThrottle({ limit: 1 });
    assert.equal(await throttle.handle(req('/', { 'x-real-ip': '198.51.100.1' })), null);
    assert.equal(await throttle.handle(req('/', { 'x-real-ip': '198.51.100.2' })), null);
    assert.ok(await throttle.handle(req('/', { 'x-real-ip': '198.51.100.1' })));
  });
});

describe('going over', () => {
  it('is 429 when there is nothing to sell', async () => {
    const throttle = createThrottle({ limit: 1 });
    const answer = await drain(throttle, 3);
    assert.equal(answer.status, 429);
    assert.equal(answer.headers.get('retry-after'), '60');
    assert.equal(answer.headers.get('ratelimit-limit'), '1');
    assert.equal((await answer.json()).error, 'Too many requests');
  });

  it('is 402 with an offer when there is', async () => {
    const throttle = createThrottle({ limit: 1, gateway: gateway() });
    const answer = await drain(throttle, 3);
    assert.equal(answer.status, 402);
    const body = await answer.json();
    assert.match(body.error, /1 requests per 60s/);
    assert.ok(body.accepts.length > 0, 'carries an x402 offer');
    assert.equal(body.pass.price, '1.00 USD');
    assert.equal(answer.headers.get('ratelimit-limit'), '1');
  });

  it('is the sales page when the caller asked for HTML', async () => {
    const throttle = createThrottle({ limit: 1, gateway: gateway() });
    const answer = await drain(throttle, 3, () => req('/explorer', { accept: 'text/html' }));
    assert.equal(answer.status, 402);
    assert.match(answer.headers.get('content-type'), /text\/html/);
  });

  it('quotes the limit that actually stopped the request', async () => {
    const throttle = createThrottle({
      limit: 100,
      gateway: gateway(),
      rules: [{ path: '/feed/', limit: 5 }],
    });
    const answer = await drain(throttle, 7, () => req('/feed/all.xml'));
    assert.match((await answer.json()).error, /5 requests per 60s/);
  });
});

describe('who is not metered', () => {
  it('lets a paid pass straight through', async () => {
    const gate = gateway();
    const throttle = createThrottle({ limit: 1, gateway: gate });
    const now = Math.floor(Date.now() / 1000);
    const pass = await mintPass({ secret: SECRET, ref: 'r1', expiresAt: now + 600, now });
    const paid = () => req('/explorer/eth/tx/0xabc', { 'x-crawl-pass': pass.token });
    for (let i = 0; i < 10; i++) {
      assert.equal(await throttle.handle(paid()), null, `paid request ${i + 1}`);
    }
  });

  it('does not accept a forged pass', async () => {
    const throttle = createThrottle({ limit: 1, gateway: gateway() });
    const forged = () => req('/x', { 'x-crawl-pass': 'cp_nope.nope' });
    await throttle.handle(forged());
    assert.ok(await throttle.handle(forged()));
  });

  it('never meters the page a refused caller has to reach to pay', async () => {
    const throttle = createThrottle({ limit: 1, gateway: gateway() });
    for (let i = 0; i < 5; i++) {
      assert.equal(await throttle.handle(req('/crawl')), null);
      assert.equal(await throttle.handle(req('/robots.txt')), null);
    }
  });

  it('honours exempt, for a signed-in session', async () => {
    const throttle = createThrottle({
      limit: 1,
      exempt: (r) => (r.headers.get('cookie') ?? '').includes('session='),
    });
    const signedIn = () => req('/dashboard', { cookie: 'session=abc' });
    for (let i = 0; i < 5; i++) assert.equal(await throttle.handle(signedIn()), null);
  });

  it('does not charge a caller for our own edge losing the address', async () => {
    const throttle = createThrottle({ limit: 1, identify: () => null });
    for (let i = 0; i < 5; i++) assert.equal(await throttle.handle(req()), null);
  });

  it('lets a rule open a route entirely', async () => {
    const throttle = createThrottle({ limit: 1, rules: [{ path: '/health', open: true }] });
    for (let i = 0; i < 5; i++) assert.equal(await throttle.handle(req('/health')), null);
  });
});

describe('credentialed callers', () => {
  const withKey = (path = '/api/payments') => req(path, { 'x-api-key': 'k_integration' });

  it('get a bigger budget than a browser', async () => {
    const throttle = createThrottle({ limit: 2, credential: { limit: 10, ceiling: 20 } });
    for (let i = 0; i < 10; i++) {
      assert.equal(await throttle.handle(withKey()), null, `request ${i + 1}`);
    }
    assert.ok(await throttle.handle(withKey()), 'the 11th is refused');
  });

  it('cannot escape the per-address ceiling by rotating credentials', async () => {
    const throttle = createThrottle({ limit: 2, credential: { limit: 10, ceiling: 5 } });
    let refused = null;
    for (let i = 0; i < 8; i++) {
      const answer = await throttle.handle(req('/api/x', { 'x-api-key': `k_${i}` }));
      if (answer && !refused) refused = answer;
    }
    assert.ok(refused, 'the ceiling stops a rotation no per-key budget would');
  });

  it('reads any auth scheme, not just Bearer', async () => {
    // The CoinPay wallet extension signs `Authorization: Wallet <id>:<sig>:<ts>`;
    // matching Bearer alone dropped a bulk payout into the anonymous bucket.
    const throttle = createThrottle({ limit: 1, credential: { limit: 6, ceiling: 60 } });
    const wallet = () => req('/api/payouts', { authorization: 'Wallet w1:sig:123' });
    for (let i = 0; i < 6; i++) assert.equal(await throttle.handle(wallet()), null);
    assert.ok(await throttle.handle(wallet()));
  });

  it('keeps sign-in address-bucketed however it is credentialed', async () => {
    // Or a brute-force attempt buys the integration budget with one header.
    const throttle = createThrottle({
      limit: 100,
      credential: { limit: 600, ceiling: 1200 },
      rules: [{ path: '/api/auth/', limit: 3, credential: false }],
    });
    const guess = () => req('/api/auth/login', { authorization: 'Bearer junk' });
    for (let i = 0; i < 3; i++) assert.equal(await throttle.handle(guess()), null);
    const answer = await throttle.handle(guess());
    assert.ok(answer, 'the fourth guess is refused');
    assert.equal((await answer.json()).limit, 3);
  });
});

describe('rules', () => {
  it('take the most specific match whatever order they were written in', async () => {
    const throttle = createThrottle({
      limit: 100,
      rules: [{ path: '/api/', limit: 50 }, { path: '/api/auth/', limit: 2 }],
    });
    for (let i = 0; i < 2; i++) assert.equal(await throttle.handle(req('/api/auth/login')), null);
    assert.ok(await throttle.handle(req('/api/auth/login')));
    assert.equal(await throttle.handle(req('/api/other')), null);
  });

  it('give each rule its own counter', async () => {
    const throttle = createThrottle({ limit: 2, rules: [{ path: '/feed/', limit: 2 }] });
    await throttle.handle(req('/feed/a'));
    await throttle.handle(req('/feed/b'));
    assert.ok(await throttle.handle(req('/feed/c')), '/feed/ is spent');
    assert.equal(await throttle.handle(req('/page')), null, 'the default is not');
  });
});

describe('onThrottle', () => {
  it('is told about a refusal, and its failure never costs an answer', async () => {
    const seen = [];
    const throttle = createThrottle({
      limit: 1,
      onThrottle: (event) => {
        seen.push(event);
        throw new Error('the log is down');
      },
    });
    await throttle.handle(req());
    const answer = await throttle.handle(req());
    assert.equal(answer.status, 429);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].limit, 1);
    assert.equal(seen[0].sold, false);
    assert.match(seen[0].userAgent, /Chrome\/145/);
  });
});

describe('credentialFrom', () => {
  it('lets a session cookie buy the credentialed budget', async () => {
    // Exempting sessions outright would hand an unmetered site to anyone
    // willing to sign up first. A session is a credential, not a bypass.
    const throttle = createThrottle({
      limit: 2,
      credential: { limit: 8, ceiling: 100 },
      credentialFrom: (r) => /session=([^;]+)/.exec(r.headers.get('cookie') ?? '')?.[1] ?? null,
    });
    const signedIn = () => req('/dashboard', { cookie: 'session=merchant-1' });
    for (let i = 0; i < 8; i++) assert.equal(await throttle.handle(signedIn()), null, `hit ${i + 1}`);
    assert.ok(await throttle.handle(signedIn()), 'a session is still bounded');
    // ...and an anonymous caller still gets the small one.
    const anon = createThrottle({ limit: 2, credentialFrom: () => null });
    await anon.handle(req());
    await anon.handle(req());
    assert.ok(await anon.handle(req()));
  });
});
