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
  sessionId: 'cs_test_1',
  paymentId: 'pi_test_1',
  sellerDid: 'did:imajin:seller',
  metadata: { listingId: 'lst_1', buyerDid: 'did:imajin:buyer', amount: 5000, currency: 'CAD' },
};

const LISTING = {
  id: 'lst_1',
  sellerDid: 'did:imajin:seller',
  quantity: 1,
  price: 5000,
  currency: 'CAD',
  status: 'active',
  fairManifest: { chain: [] },
};

const CHECKOUT = {
  sessionId: 'cs_test_1', transactionId: 'tx_abc', paymentId: null,
  listingId: 'lst_1', sellerDid: LISTING.sellerDid, buyerDid: 'did:imajin:buyer',
  quantity: 1, unitPrice: 5000, amountCents: 5000, currency: 'CAD', chain: [],
  createdAt: new Date('2026-10-18T12:00:00Z'), fulfilledAt: null,
};

function queuePurchase(listing: Record<string, unknown> = LISTING, checkout: Record<string, unknown> = CHECKOUT) {
  dbState.queue([checkout], [listing], undefined, undefined);
}

function setValues() {
  return dbState.argsOf('set', 'update')[1][0] as Record<string, unknown>;
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
    queuePurchase();
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
    queuePurchase();
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

describe('POST /api/webhook — bound fulfillment (#30)', () => {
  function expectNoFulfillment() {
    expect(dbState.argsOf('set', 'update')).toHaveLength(0);
    expect(mocks.emitEvent).not.toHaveBeenCalled();
    expect(mocks.recordByoSettlement).not.toHaveBeenCalled();
    expect(mocks.settleListingPurchase).not.toHaveBeenCalled();
  }

  it.each(['stripe-byo', undefined])('requires recorded checkout ownership on rail %s', async (rail) => {
    dbState.queue([]);
    expect((await hook({ ...PAID, rail })).status).toBe(400);
    expectNoFulfillment();
  });

  const invalidNotifications = [
    { label: 'wrong attested seller', sellerDid: 'did:imajin:attacker' },
    { label: 'missing attested seller', sellerDid: undefined },
    { label: 'missing session', sessionId: undefined },
    { label: 'metadata-only session', sessionId: undefined, metadata: { ...PAID.metadata, sessionId: CHECKOUT.sessionId } },
    { label: 'missing payment id', paymentId: undefined },
    { label: 'wrong listing', metadata: { ...PAID.metadata, listingId: 'lst_victim' } },
    { label: 'missing listing', metadata: { ...PAID.metadata, listingId: undefined } },
    { label: 'underpayment', metadata: { ...PAID.metadata, amount: 1 } },
    { label: 'overpayment', metadata: { ...PAID.metadata, amount: 5001 } },
    { label: 'missing amount', metadata: { ...PAID.metadata, amount: undefined } },
    { label: 'string amount', metadata: { ...PAID.metadata, amount: '5000' } },
    { label: 'wrong currency', metadata: { ...PAID.metadata, currency: 'USD' } },
    { label: 'missing currency', metadata: { ...PAID.metadata, currency: undefined } },
    { label: 'changed buyer', metadata: { ...PAID.metadata, buyerDid: 'did:imajin:attacker' } },
    { label: 'missing recorded buyer', metadata: { ...PAID.metadata, buyerDid: undefined } },
    { label: 'conflicting session', metadata: { ...PAID.metadata, sessionId: 'cs_other' } },
    { label: 'conflicting seller metadata', metadata: { ...PAID.metadata, sellerDid: 'did:imajin:attacker' } },
  ];

  describe.each(['stripe-byo', undefined])('refusals on rail %s', (rail) => {
    it.each(invalidNotifications)('rejects $label before any fulfillment side effect', async (override) => {
      dbState.queue([CHECKOUT], [LISTING]);
      expect((await hook({ ...PAID, rail, ...override })).status).toBe(400);
      expectNoFulfillment();
    });

    it.each([
      { label: 'changed DB seller', sellerDid: 'did:imajin:other' },
      { label: 'changed DB price', price: 6000 },
      { label: 'changed DB currency', currency: 'USD' },
      { label: 'missing DB currency', currency: null },
      { label: 'insufficient stock', quantity: 0 },
      { label: 'unavailable listing', status: 'sold' },
    ])('rejects $label', async (override) => {
      dbState.queue([CHECKOUT], [{ ...LISTING, ...override }]);
      expect((await hook({ ...PAID, rail })).status).toBe(400);
      expectNoFulfillment();
    });
  });

  it.each(['type', 'paid', 'succeeded'])('accepts supported payment success marker %s', async (marker) => {
    queuePurchase();
    const body = marker === 'type' ? PAID : { ...PAID, type: undefined, status: marker };
    expect((await hook(body)).status).toBe(200);
    expect(setValues()).toMatchObject({ status: 'sold', quantity: 0 });
  });

  it('acknowledges non-payment events without any database access', async () => {
    expect((await hook({ ...PAID, type: 'payment.failed' })).status).toBe(200);
    expectNoSideEffects();
  });

  it('rejects signed non-object bodies', async () => {
    for (const body of [null, 123, 'null']) {
      expect((await hook(body)).status).toBe(400);
    }
    expectNoFulfillment();
  });

  it('refuses an unknown listing even with a recorded checkout', async () => {
    dbState.queue([CHECKOUT], []);
    expect((await hook(PAID)).status).toBe(400);
    expectNoFulfillment();
  });

  it('records valid BYO without a .fair chain and never calls platform settlement', async () => {
    queuePurchase({ ...LISTING, fairManifest: null });
    expect((await hook({ ...PAID, rail: 'stripe-byo' })).status).toBe(200);
    expect(setValues()).toMatchObject({ quantity: 0, status: 'sold' });
    expect(mocks.recordByoSettlement).toHaveBeenCalledWith({
      listingId: LISTING.id, sessionId: CHECKOUT.sessionId,
      amountCents: 5000, currency: 'CAD', fairManifest: null,
    });
    expect(mocks.settleListingPurchase).not.toHaveBeenCalled();
    expect(mocks.emitEvent).toHaveBeenCalledWith('listing.purchased', expect.objectContaining({
      issuer: CHECKOUT.buyerDid, subject: CHECKOUT.sellerDid,
      payload: expect.objectContaining({ amount: 5000, currency: 'CAD', funded: true, buyerDid: CHECKOUT.buyerDid }),
    }));
  });

  it('uses the recorded quantity, not caller metadata, to decrement stock', async () => {
    queuePurchase({ ...LISTING, quantity: 5 }, { ...CHECKOUT, quantity: 3, amountCents: 15000 });
    expect((await hook({ ...PAID, rail: 'stripe-byo', metadata: { ...PAID.metadata, amount: 15000, quantity: 1 } })).status).toBe(200);
    expect(setValues()).toMatchObject({ quantity: 2, status: 'active' });
    expect(mocks.recordByoSettlement).toHaveBeenCalledWith(expect.objectContaining({ amountCents: 15000 }));
  });

  it('keeps unlimited listings available', async () => {
    dbState.queue([CHECKOUT], [{ ...LISTING, quantity: null }], undefined, undefined);
    expect((await hook(PAID)).status).toBe(200);
    expect(setValues()).toMatchObject({ quantity: null, status: 'active' });
  });

  it('uses the server-recorded anonymous buyer', async () => {
    queuePurchase(LISTING, { ...CHECKOUT, buyerDid: '' });
    expect((await hook({ ...PAID, metadata: { ...PAID.metadata, buyerDid: undefined } })).status).toBe(200);
    expect(mocks.emitEvent).toHaveBeenCalledWith('listing.purchased', expect.objectContaining({
      issuer: '', payload: expect.objectContaining({ buyerDid: '', interestDids: [LISTING.sellerDid] }),
    }));
  });

  it('settles a platform-collected checkout with its recorded transaction and payee chain', async () => {
    const chain = [{ did: LISTING.sellerDid, role: 'seller', amount: 50 }];
    queuePurchase(LISTING, { ...CHECKOUT, chain });
    expect((await hook(PAID)).status).toBe(200);
    expect(mocks.settleListingPurchase).toHaveBeenCalledWith({
      listingId: LISTING.id, sessionId: CHECKOUT.sessionId, currency: 'CAD', fairManifest: LISTING.fairManifest,
      pending: { transactionId: CHECKOUT.transactionId, amountCents: 5000, chain, at: CHECKOUT.createdAt.toISOString() },
    });
    expect(mocks.recordByoSettlement).not.toHaveBeenCalled();
  });

  it('deduplicates a freshly signed redelivery with a different nonce', async () => {
    queuePurchase();
    expect((await hook({ ...PAID, rail: 'stripe-byo' })).status).toBe(200);
    dbState.queue([{ ...CHECKOUT, paymentId: PAID.paymentId, fulfilledAt: new Date() }]);
    expect((await hook({ ...PAID, rail: 'stripe-byo' })).status).toBe(200);
    expect(dbState.argsOf('set', 'update')).toHaveLength(2);
    expect(mocks.emitEvent).toHaveBeenCalledTimes(1);
    expect(mocks.recordByoSettlement).toHaveBeenCalledTimes(1);
  });

  it('rejects a different payment id against an already fulfilled session', async () => {
    dbState.queue([{ ...CHECKOUT, paymentId: 'pi_other', fulfilledAt: new Date() }]);
    expect((await hook(PAID)).status).toBe(400);
    expectNoFulfillment();
  });

  it('does not emit or record a receipt if the atomic inventory transaction fails', async () => {
    dbState.queue([CHECKOUT], [LISTING], undefined, new Error('db down'));
    expect((await hook({ ...PAID, rail: 'stripe-byo' })).status).toBe(500);
    expect(mocks.emitEvent).not.toHaveBeenCalled();
    expect(mocks.recordByoSettlement).not.toHaveBeenCalled();
  });
});
