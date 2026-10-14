import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalKernelWebhookPayload } from '@ima-jin/auth/kernel-webhook';
import { createLogger } from '@ima-jin/logger';

const mocks = vi.hoisted(() => ({ emitEvent: vi.fn(), settleListingPurchase: vi.fn(), recordByoSettlement: vi.fn() }));

vi.mock('@/db', async () => (await import('../../../../test/helpers/db-mock')).dbModule);
vi.mock('@/lib/kernel/events', () => ({ emitEvent: mocks.emitEvent }));
vi.mock('@/lib/settle', () => ({
  settleListingPurchase: mocks.settleListingPurchase,
  recordByoSettlement: mocks.recordByoSettlement,
}));
// The real pending-checkout reader: the recorded entry is looked up exactly as in production.
vi.mock('@/lib/pending-checkout', async () => import('../../../../src/lib/pending-checkout'));

import { dbState } from '../../../../test/helpers/db-mock';
import { POST } from '../route';

// Ephemeral keys only; requests exercise the real published verifier and file pins.
const signingKey = generateKeyPairSync('ed25519');
const foreignKey = generateKeyPairSync('ed25519');
const publicKey = signingKey.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
const kid = `auth-${createHash('sha256').update(publicKey).digest('hex').slice(0, 16)}`;
const audience = 'did:imajin:market-test';
const callbackUrl = 'https://market.test/market/api/webhook';
const directory = mkdtempSync(join(tmpdir(), 'market-kernel-webhook-'));
const discovery = vi.fn();
const log = createLogger('market');

beforeAll(() => {
  vi.spyOn(process, 'cwd').mockReturnValue(directory);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
afterAll(() => {
  vi.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
});

function signedRequest(body: unknown, options: {
  timestampOffsetSeconds?: number;
  audience?: string;
  privateKey?: typeof signingKey.privateKey;
} = {}): Parameters<typeof POST>[0] {
  const rawBody = typeof body === 'string' ? body : JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000) + (options.timestampOffsetSeconds ?? 0));
  const nonce = randomUUID();
  const recipient = options.audience ?? audience;
  const payload = canonicalKernelWebhookPayload({
    audience: recipient, timestamp, nonce, method: 'POST', url: callbackUrl, rawBody,
  });
  const signature = sign(null, Buffer.from(payload), options.privateKey ?? signingKey.privateKey).toString('hex');
  return new Request(callbackUrl, {
    method: 'POST',
    headers: {
      'x-kernel-audience': recipient,
      'x-kernel-timestamp': timestamp,
      'x-kernel-nonce': nonce,
      'x-kernel-kid': kid,
      'x-kernel-signature': signature,
    },
    body: rawBody,
  }) as Parameters<typeof POST>[0];
}

function unsignedRequest(body: unknown): Parameters<typeof POST>[0] {
  return new Request(callbackUrl, { method: 'POST', body: JSON.stringify(body) }) as Parameters<typeof POST>[0];
}

function hook(body: unknown) {
  return POST(signedRequest(body));
}

function expectNoSideEffects() {
  expect(dbState.calls).toHaveLength(0);
  expect(mocks.settleListingPurchase).not.toHaveBeenCalled();
  expect(mocks.recordByoSettlement).not.toHaveBeenCalled();
  expect(mocks.emitEvent).not.toHaveBeenCalled();
  expect(log.info).not.toHaveBeenCalled();
  expect(log.warn).not.toHaveBeenCalled();
  expect(log.error).not.toHaveBeenCalled();
}

const PAID = {
  type: 'payment.succeeded',
  metadata: { listingId: 'lst_1', buyerDid: 'did:imajin:buyer', amount: 5000, currency: 'CAD' },
};

const LISTING = {
  id: 'lst_1',
  sellerDid: 'did:imajin:seller',
  quantity: 1,
  status: 'active',
  fairManifest: { chain: [] },
};

function setValues() {
  return dbState.argsOf('set', 'update')[0][0] as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  dbState.reset();
  vi.stubEnv('IMAJIN_APP_DID', audience);
  vi.stubEnv('AUTH_SERVICE_URL', 'https://kernel.test/auth');
  discovery.mockImplementation(async () => Response.json({
    current: kid,
    keys: [{ kid, publicKey, algorithm: 'Ed25519', validFrom: new Date(0).toISOString() }],
  }));
  vi.stubGlobal('fetch', discovery);
});

describe('POST /api/webhook — authorization', () => {
  async function expectRejected(request: Parameters<typeof POST>[0]) {
    const response = await POST(request);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Unauthorized' });
    expectNoSideEffects();
  }

  it('accepts and processes a kernel-signed payment without a shared callback credential', async () => {
    dbState.queue([LISTING], undefined);
    const response = await hook(PAID);
    expect(response.status).toBe(200);
    expect(setValues()).toMatchObject({ status: 'sold' });
    expect(discovery).toHaveBeenCalledWith('https://kernel.test/auth/.well-known/kernel-signing-key', expect.any(Object));
  });

  it('rejects an unsigned request, including malformed JSON, before parsing', async () => {
    await expectRejected(unsignedRequest(PAID));
    const request = new Request(callbackUrl, { method: 'POST', body: '{nope' });
    await expectRejected(request as Parameters<typeof POST>[0]);
  });

  it('rejects legacy Bearer, header and body credentials instead of a signature', async () => {
    const request = unsignedRequest(PAID);
    request.headers.set('authorization', 'Bearer FAKE_LEGACY_PLACEHOLDER');
    request.headers.set('x-webhook-secret', 'FAKE_LEGACY_PLACEHOLDER');
    await expectRejected(request);
    await expectRejected(unsignedRequest({ ...PAID, secret: 'FAKE_LEGACY_PLACEHOLDER' }));
  });

  it.each(['x-kernel-audience', 'x-kernel-timestamp', 'x-kernel-nonce', 'x-kernel-kid', 'x-kernel-signature'])(
    'rejects a missing %s header', async (header) => {
      const request = signedRequest(PAID);
      request.headers.delete(header);
      await expectRejected(request);
    },
  );

  it.each([
    ['x-kernel-signature', '0'.repeat(128)],
    ['x-kernel-nonce', randomUUID()],
    ['x-kernel-timestamp', String(Math.floor(Date.now() / 1000) - 10)],
    ['x-kernel-signature', 'not-a-signature'],
  ])('rejects a tampered %s header (%s)', async (header, value) => {
    const request = signedRequest(PAID);
    request.headers.set(header, value);
    await expectRejected(request);
  });

  it.each([
    ['wrong audience', { audience: 'did:imajin:another-app' }],
    ['wrong key', { privateKey: foreignKey.privateKey }],
    ['stale timestamp', { timestampOffsetSeconds: -301 }],
    ['future timestamp', { timestampOffsetSeconds: 301 }],
  ])('rejects a %s', async (_label, options) => {
    await expectRejected(signedRequest(PAID, options));
  });

  it.each([
    ['body bytes', { body: JSON.stringify(PAID) + ' ' }],
    ['path', { url: 'https://market.test/api/webhook' }],
    ['query', { url: `${callbackUrl}?changed=true` }],
    ['method', { method: 'PUT' }],
  ])('rejects tampered %s', async (_label, changes: { url?: string; method?: string; body?: string }) => {
    const request = signedRequest(PAID);
    const changed = new Request(changes.url ?? request.url, {
      method: changes.method ?? request.method, headers: request.headers,
      body: changes.body ?? JSON.stringify(PAID),
    });
    await expectRejected(changed as Parameters<typeof POST>[0]);
  });

  it('rejects replay without repeating business side effects', async () => {
    dbState.queue([LISTING], undefined);
    const request = signedRequest(PAID);
    const replay = request.clone() as Parameters<typeof POST>[0];
    expect((await POST(request)).status).toBe(200);
    vi.clearAllMocks();
    dbState.reset();
    await expectRejected(replay);
  });

  it.each(['', 'market'])('fails closed for a missing/malformed local audience (%j)', async (value) => {
    vi.stubEnv('IMAJIN_APP_DID', value);
    await expectRejected(signedRequest(PAID));
  });

  it('rejects a key not present in public discovery', async () => {
    vi.stubEnv('AUTH_SERVICE_URL', 'https://unknown-key.test/auth');
    const request = signedRequest(PAID);
    request.headers.set('x-kernel-kid', `auth-${'0'.repeat(16)}`);
    await expectRejected(request);
  });

  it('fails closed on discovery failure without exposing internal details', async () => {
    vi.stubEnv('AUTH_SERVICE_URL', 'https://offline-kernel.test/auth');
    discovery.mockRejectedValue(new Error('internal discovery details'));
    const response = await hook(PAID);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Webhook verification unavailable' });
    expectNoSideEffects();
  });

  it.each(['trust', 'store'] as const)('fails closed on a public pin %s failure', async (failure) => {
    const namespace = `https://${failure}-kernel.test/auth`;
    vi.stubEnv('AUTH_SERVICE_URL', namespace);
    const root = join(directory, 'data', 'kernel-webhook-pins');
    mkdirSync(root, { recursive: true });
    const pin = join(root, createHash('sha256').update(namespace).digest('hex') + '.json');
    if (failure === 'trust') {
      writeFileSync(pin, JSON.stringify([{ kid: 'invalid-public-pin' }]));
    } else {
      mkdirSync(pin + '.lock');
    }
    const response = await hook(PAID);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Webhook verification unavailable' });
    expectNoSideEffects();
  });

  it('returns 400 for correctly signed non-JSON without business side effects', async () => {
    const response = await hook('{nope');
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid webhook body' });
    expectNoSideEffects();
  });
});

describe('POST /api/webhook — payment handling', () => {

  it.each([
    [{ type: 'payment.succeeded' }],
    [{ status: 'paid' }],
    [{ status: 'succeeded' }],
  ])('treats %j as a successful payment', async (marker) => {
    dbState.reset();
    dbState.queue([LISTING], undefined);

    await hook({ ...marker, metadata: PAID.metadata });

    expect(setValues()).toMatchObject({ status: 'sold' });
  });

  it('acknowledges but ignores other events', async () => {
    const res = await hook({ type: 'payment.failed', metadata: PAID.metadata });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
    expect(dbState.calls).toHaveLength(0);
    expect(mocks.emitEvent).not.toHaveBeenCalled();
  });

  it('acknowledges a payment with no listingId without touching the database', async () => {
    const res = await hook({ type: 'payment.succeeded', metadata: {} });

    expect(res.status).toBe(200);
    expect(dbState.calls).toHaveLength(0);
  });

  it('acknowledges a payment for an unknown listing without updating anything', async () => {
    dbState.queue([]);

    const res = await hook(PAID);

    expect(res.status).toBe(200);
    expect(dbState.argsOf('set', 'update')).toHaveLength(0);
    expect(mocks.emitEvent).not.toHaveBeenCalled();
  });

  it('marks a single-quantity listing sold', async () => {
    dbState.queue([{ ...LISTING, quantity: 1 }], undefined);

    await hook(PAID);

    expect(setValues()).toMatchObject({ status: 'sold' });
    expect(setValues().quantity).toBeUndefined();
  });

  it('marks an unlimited-quantity (null) listing sold', async () => {
    dbState.queue([{ ...LISTING, quantity: null }], undefined);

    await hook(PAID);

    expect(setValues()).toMatchObject({ status: 'sold' });
  });

  it('decrements a multi-quantity listing and keeps its status while stock remains', async () => {
    dbState.queue([{ ...LISTING, quantity: 3, status: 'active' }], undefined);

    await hook(PAID);

    expect(setValues()).toMatchObject({ quantity: 2, status: 'active' });
  });

  it('emits listing.purchased with the buyer, seller and manifest', async () => {
    dbState.queue([LISTING], undefined);

    await hook(PAID);

    expect(mocks.emitEvent).toHaveBeenCalledWith('listing.purchased', {
      issuer: 'did:imajin:buyer',
      subject: 'did:imajin:seller',
      scope: 'market',
      payload: {
        context_id: 'lst_1',
        context_type: 'market',
        amount: 5000,
        currency: 'CAD',
        fairManifest: { chain: [] },
        funded: true,
        funded_provider: 'stripe',
        buyerDid: 'did:imajin:buyer',
        metadata: { listingId: 'lst_1' },
        interestDids: ['did:imajin:buyer', 'did:imajin:seller'],
      },
    });
  });

  it('defaults the event for an anonymous buyer with no amount/currency', async () => {
    dbState.queue([{ ...LISTING, fairManifest: null }], undefined);

    await hook({ type: 'payment.succeeded', metadata: { listingId: 'lst_1' } });

    expect(mocks.emitEvent).toHaveBeenCalledWith(
      'listing.purchased',
      expect.objectContaining({
        issuer: '',
        payload: expect.objectContaining({
          amount: 0,
          currency: 'CAD',
          fairManifest: null,
          buyerDid: '',
          interestDids: ['did:imajin:seller'],
        }),
      })
    );
  });

  it('returns 500 when processing fails', async () => {
    dbState.queue(new Error('db down'));

    const res = await hook(PAID);

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Webhook processing failed' });
  });

  it('returns 400 on a signed unparseable body', async () => {
    expect((await hook('{nope')).status).toBe(400);
  });
});

describe('POST /api/webhook — settlement (#2740)', () => {
  const SESSION_ID = 'cs_test_1';
  const FAIR_MANIFEST = { version: '1.0', chain: [{ did: 'did:imajin:seller', role: 'seller', share: 1 }] };
  const PENDING = {
    transactionId: 'tx_abc',
    amountCents: 5000,
    chain: [{ did: 'did:imajin:seller', role: 'seller', amount: 50 }],
    at: '2026-10-08T12:00:00.000Z',
  };

  function settlable(overrides: Record<string, unknown> = {}) {
    return {
      ...LISTING,
      currency: 'CAD',
      fairManifest: FAIR_MANIFEST,
      metadata: { pendingCheckouts: { [SESSION_ID]: PENDING } },
      ...overrides,
    };
  }

  const paid = (overrides: Record<string, unknown> = {}) => ({ ...PAID, sessionId: SESSION_ID, ...overrides });

  beforeEach(() => {
    mocks.settleListingPurchase.mockResolvedValue(undefined);
  });

  it('settles a paid purchase with the checkout recorded for its Stripe session', async () => {
    dbState.queue([settlable()], undefined);

    const res = await hook(paid());

    expect(res.status).toBe(200);
    expect(setValues()).toMatchObject({ status: 'sold' });
    expect(mocks.emitEvent).toHaveBeenCalledWith('listing.purchased', expect.objectContaining({ scope: 'market' }));
    expect(mocks.settleListingPurchase).toHaveBeenCalledTimes(1);
    expect(mocks.settleListingPurchase).toHaveBeenCalledWith({
      listingId: 'lst_1',
      sessionId: SESSION_ID,
      pending: PENDING,
      currency: 'CAD',
      fairManifest: FAIR_MANIFEST,
    });
  });

  it('finds the session id in metadata and falls back to the listing currency, then CAD', async () => {
    dbState.queue([settlable({ currency: 'USD' })], undefined);
    await hook(
      paid({ sessionId: undefined, metadata: { listingId: 'lst_1', buyerDid: 'did:imajin:buyer', sessionId: SESSION_ID } })
    );
    expect(mocks.settleListingPurchase).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionId: SESSION_ID, currency: 'USD' })
    );

    dbState.reset();
    dbState.queue([settlable({ currency: null })], undefined);
    await hook(paid({ metadata: { listingId: 'lst_1' } }));
    expect(mocks.settleListingPurchase).toHaveBeenLastCalledWith(expect.objectContaining({ currency: 'CAD' }));
  });

  it('does not settle when the webhook carries no Stripe session id', async () => {
    dbState.queue([settlable()], undefined);

    const res = await hook(paid({ sessionId: undefined }));

    expect(res.status).toBe(200);
    expect(mocks.settleListingPurchase).not.toHaveBeenCalled();
  });

  it('does not settle when no checkout was recorded for the session (e.g. a replay after settling)', async () => {
    dbState.queue([settlable({ metadata: { pendingCheckouts: {} } })], undefined);

    const res = await hook(paid());

    expect(res.status).toBe(200);
    expect(mocks.settleListingPurchase).not.toHaveBeenCalled();
  });

  it('skips settlement for a listing without a .fair manifest chain', async () => {
    dbState.queue([settlable({ fairManifest: null })], undefined);
    await hook(paid());
    expect(mocks.settleListingPurchase).not.toHaveBeenCalled();

    dbState.reset();
    dbState.queue([settlable({ fairManifest: { version: '1.0', chain: [] } })], undefined);
    await hook(paid());
    expect(mocks.settleListingPurchase).not.toHaveBeenCalled();
  });

  it('does not settle a payment that did not succeed', async () => {
    const res = await hook({ ...paid(), type: 'payment.failed' });

    expect(res.status).toBe(200);
    expect(mocks.settleListingPurchase).not.toHaveBeenCalled();
  });

  it('decrements a multi-quantity listing and still settles', async () => {
    dbState.queue([settlable({ quantity: 3 })], undefined);

    await hook(paid());

    expect(setValues()).toMatchObject({ quantity: 2, status: 'active' });
    expect(mocks.settleListingPurchase).toHaveBeenCalledTimes(1);
  });

  describe('paid on the seller\'s own Stripe account (#2773)', () => {
    const byo = (overrides: Record<string, unknown> = {}) => paid({ rail: 'stripe-byo', ...overrides });

    beforeEach(() => {
      mocks.recordByoSettlement.mockResolvedValue(undefined);
    });

    it('treats the kernel notification as the settlement: records it and never calls /pay/api/settle', async () => {
      dbState.queue([settlable()], undefined);

      const res = await hook(byo());

      expect(res.status).toBe(200);
      expect(setValues()).toMatchObject({ status: 'sold' });
      expect(mocks.emitEvent).toHaveBeenCalledWith('listing.purchased', expect.objectContaining({ scope: 'market' }));
      expect(mocks.settleListingPurchase).not.toHaveBeenCalled();
      expect(mocks.recordByoSettlement).toHaveBeenCalledWith({
        listingId: 'lst_1',
        sessionId: SESSION_ID,
        amountCents: 5000,
        currency: 'CAD',
        fairManifest: FAIR_MANIFEST,
      });
    });

    it('records the receipt even for a listing with no .fair chain or no recorded pending checkout', async () => {
      dbState.queue([settlable({ fairManifest: null, metadata: {} })], undefined);

      await hook(byo());

      expect(mocks.settleListingPurchase).not.toHaveBeenCalled();
      expect(mocks.recordByoSettlement).toHaveBeenCalledWith(expect.objectContaining({ fairManifest: null }));
    });

    it('falls back to the recorded amount, then 0, when the webhook carries none', async () => {
      dbState.queue([settlable()], undefined);
      await hook(byo({ metadata: { listingId: 'lst_1' } }));
      expect(mocks.recordByoSettlement).toHaveBeenLastCalledWith(expect.objectContaining({ amountCents: 5000 }));

      dbState.reset();
      dbState.queue([settlable({ metadata: {} })], undefined);
      await hook(byo({ metadata: { listingId: 'lst_1' } }));
      expect(mocks.recordByoSettlement).toHaveBeenLastCalledWith(expect.objectContaining({ amountCents: 0 }));
    });

    it('records nothing when the webhook carries no Stripe session id', async () => {
      dbState.queue([settlable()], undefined);

      const res = await hook(byo({ sessionId: undefined }));

      expect(res.status).toBe(200);
      expect(mocks.recordByoSettlement).not.toHaveBeenCalled();
      expect(mocks.settleListingPurchase).not.toHaveBeenCalled();
    });

    it('still settles a platform-collected payment (no rail) through /pay/api/settle', async () => {
      dbState.queue([settlable()], undefined);

      await hook(paid());

      expect(mocks.settleListingPurchase).toHaveBeenCalledTimes(1);
      expect(mocks.recordByoSettlement).not.toHaveBeenCalled();
    });
  });
});
