/**
 * Tests for app/api/listings/[id]/purchase/route.ts (#2740) — a listing with a
 * .fair chain checks out with market's OWN app-service token and a
 * `payeeManifest`, and the resulting kernel payment is remembered so the
 * purchase webhook can settle it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireSessionOrAppToken: vi.fn(),
  isHardIdentity: vi.fn(),
  getAppServiceToken: vi.fn(),
  recordPendingCheckout: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock('@/db', async () => (await import('../../../../../../test/helpers/db-mock')).dbModule);
vi.mock('@ima-jin/auth', () => ({ requireSessionOrAppToken: mocks.requireSessionOrAppToken }));
vi.mock('@/lib/kernel/client', () => ({ isHardIdentity: mocks.isHardIdentity }));
vi.mock('@/lib/app-token', () => ({ getAppServiceToken: mocks.getAppServiceToken }));
vi.mock('@/lib/pending-checkout', () => ({
  recordPendingCheckout: mocks.recordPendingCheckout,
  saveSettlementSnapshot: vi.fn(),
}));
// buildPayeeChain is intentionally the real implementation (its own deps are mocked above).
vi.mock('@/lib/settle', async () => import('../../../../../../src/lib/settle'));

import { dbState } from '../../../../../../test/helpers/db-mock';
import { POST } from '../route';

const SELLER = 'did:imajin:seller';
const BUYER = 'did:imajin:buyer';
const NODE = 'did:imajin:node';
const PROTOCOL = 'did:imajin:protocol';
const LISTING_ID = 'lst_1';
const CHECKOUT_URL = 'https://pay.test/checkout/cs_test_1';
const PAY_CHECKOUT = 'https://kernel.test/pay/api/checkout';
const ROUTE_PARAMS = { params: Promise.resolve({ id: LISTING_ID }) };

const CHAIN_MANIFEST = {
  version: '1.0',
  fees: [{ role: 'processor', name: 'Stripe', rateBps: 290, fixedCents: 30 }],
  chain: [
    { did: SELLER, role: 'seller', share: 0.97 },
    { did: 'NODE_PLACEHOLDER', role: 'node', share: 0.01 },
    { did: PROTOCOL, role: 'protocol', share: 0.01 },
    { did: 'BUYER_PLACEHOLDER', role: 'buyer_credit', share: 0.01 },
  ],
};

function listingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: LISTING_ID,
    sellerDid: SELLER,
    title: 'Vintage Chair',
    description: 'A chair',
    price: 2500,
    currency: 'CAD',
    status: 'active',
    sellerTier: 'public_onplatform',
    fairManifest: CHAIN_MANIFEST,
    ...overrides,
  };
}

function signedIn(did = BUYER) {
  mocks.requireSessionOrAppToken.mockResolvedValue({ auth: { did, scopes: [], via: 'token' } });
}

function anonymous() {
  mocks.requireSessionOrAppToken.mockResolvedValue({ error: 'Not authenticated', status: 401 });
}

function checkoutOk(overrides: Record<string, unknown> = {}) {
  return Response.json({
    id: 'cs_test_1',
    url: CHECKOUT_URL,
    expiresAt: '2026-10-09T00:00:00.000Z',
    transactionId: 'tx_abc',
    ...overrides,
  });
}

function purchase(body?: unknown) {
  return POST(
    new Request(`https://market.test/api/listings/${LISTING_ID}/purchase`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }) as unknown as Parameters<typeof POST>[0],
    ROUTE_PARAMS
  );
}

const checkoutRequest = () => {
  const [url, init] = mocks.fetch.mock.calls[0] as [string, RequestInit];
  return { url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) };
};

type ChainEntry = { did: string; role: string; amount: number };

beforeEach(() => {
  vi.clearAllMocks();
  dbState.reset();
  vi.stubGlobal('fetch', mocks.fetch);
  vi.stubEnv('PAY_SERVICE_URL', 'https://kernel.test/pay');
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://market.test');
  vi.stubEnv('NEXT_PUBLIC_BASE_PATH', '');
  vi.stubEnv('NODE_DID', NODE);
  signedIn();
  mocks.isHardIdentity.mockResolvedValue(true);
  mocks.getAppServiceToken.mockReset().mockResolvedValue('app-token-1');
  mocks.recordPendingCheckout.mockReset().mockResolvedValue(undefined);
  mocks.fetch.mockReset().mockImplementation(async () => checkoutOk());
  dbState.queue([listingRow()]);
});

describe('POST /api/listings/:id/purchase — listing with a .fair chain', () => {
  it("checks out with market's own app-service token and declares the payee manifest", async () => {
    const res = await purchase();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: CHECKOUT_URL, sessionId: 'cs_test_1' });

    const { url, headers, body } = checkoutRequest();
    expect(url).toBe(PAY_CHECKOUT);
    expect(headers.Authorization).toBe('Bearer app-token-1');
    // The listing manifest still drives pay's fee calculation; the payee manifest is what settle is verified against.
    expect(body.fairManifest).toEqual(CHAIN_MANIFEST);
    const payee = body.payeeManifest.chain as ChainEntry[];
    expect(payee.map((e) => [e.did, e.role])).toEqual([
      [SELLER, 'seller'],
      [NODE, 'node'],
      [PROTOCOL, 'protocol'],
      [BUYER, 'buyer_credit'],
    ]);
    // Σchain == the gross payment the kernel records ($25.00): nothing is skimmed off for processing.
    expect(payee.reduce((sum, e) => sum + e.amount, 0)).toBeCloseTo(25, 2);
    expect(body.metadata).toMatchObject({ service: 'market', listingId: LISTING_ID, sellerDid: SELLER, buyerDid: BUYER });
  });

  it('remembers the kernel payment so the webhook can settle it', async () => {
    await purchase();

    const { body } = checkoutRequest();
    expect(mocks.recordPendingCheckout).toHaveBeenCalledTimes(1);
    expect(mocks.recordPendingCheckout).toHaveBeenCalledWith(LISTING_ID, 'cs_test_1', {
      transactionId: 'tx_abc',
      amountCents: 2500,
      chain: body.payeeManifest.chain,
    });
  });

  it('scales the declared amount by the requested quantity', async () => {
    await purchase({ quantity: 3 });

    const { body } = checkoutRequest();
    expect(body.items[0]).toMatchObject({ amount: 2500, quantity: 3 });
    const total = (body.payeeManifest.chain as ChainEntry[]).reduce((sum, e) => sum + e.amount, 0);
    expect(total).toBeCloseTo(75, 2);
    expect(mocks.recordPendingCheckout).toHaveBeenCalledWith(
      LISTING_ID,
      'cs_test_1',
      expect.objectContaining({ amountCents: 7500 })
    );
  });

  it('declares an anonymous buyer as the kernel will record them', async () => {
    anonymous();
    await purchase();

    const { body } = checkoutRequest();
    expect((body.payeeManifest.chain as ChainEntry[]).find((e) => e.role === 'buyer_credit')!.did).toBe('anonymous');
    expect(body.metadata).not.toHaveProperty('buyerDid');
  });

  it('uses the verified identity for a trust-gated listing', async () => {
    dbState.reset();
    dbState.queue([listingRow({ sellerTier: 'trust_gated' })]);
    await purchase();

    expect(mocks.isHardIdentity).toHaveBeenCalledTimes(1);
    expect(checkoutRequest().body.metadata.buyerDid).toBe(BUYER);
  });

  it('fails closed with 503 when the app token cannot be minted — no checkout, no money taken', async () => {
    mocks.getAppServiceToken.mockRejectedValue(new Error('getSigningIdentity: signing identity not bootstrapped yet'));

    const res = await purchase();

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Payment service unavailable' });
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.recordPendingCheckout).not.toHaveBeenCalled();
  });

  it('still returns the checkout URL when pay returns no transactionId', async () => {
    mocks.fetch.mockImplementation(async () => checkoutOk({ transactionId: undefined }));

    const res = await purchase();

    expect(res.status).toBe(200);
    expect(mocks.recordPendingCheckout).not.toHaveBeenCalled();
  });

  it('still returns the checkout URL when pay returns no session id', async () => {
    mocks.fetch.mockImplementation(async () => checkoutOk({ id: undefined }));

    const res = await purchase();

    expect(res.status).toBe(200);
    expect(mocks.recordPendingCheckout).not.toHaveBeenCalled();
  });

  it('still returns the checkout URL when recording the checkout fails', async () => {
    mocks.recordPendingCheckout.mockRejectedValue(new Error('db down'));

    const res = await purchase();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: CHECKOUT_URL, sessionId: 'cs_test_1' });
  });

  it('never sends a shared pay key', async () => {
    vi.stubEnv('PAY_SERVICE_API_KEY', 'legacy-shared-key');

    await purchase();

    expect(JSON.stringify(mocks.fetch.mock.calls)).not.toContain('legacy-shared-key');
  });

  it("returns pay's error message when checkout is refused", async () => {
    mocks.fetch.mockImplementation(async () =>
      Response.json({ error: "Forbidden - scope 'pay:settle' was not granted" }, { status: 403 })
    );

    const res = await purchase();

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Forbidden - scope 'pay:settle' was not granted" });
    expect(mocks.recordPendingCheckout).not.toHaveBeenCalled();
  });
});

describe('POST /api/listings/:id/purchase — listing without a .fair chain', () => {
  it('checks out plainly: no token, no payee manifest, nothing recorded', async () => {
    dbState.reset();
    dbState.queue([listingRow({ fairManifest: null })]);

    const res = await purchase();

    expect(res.status).toBe(200);
    expect(mocks.getAppServiceToken).not.toHaveBeenCalled();
    const { headers, body } = checkoutRequest();
    expect(headers).not.toHaveProperty('Authorization');
    expect(body).not.toHaveProperty('payeeManifest');
    // Falls back to the default platform manifest, as before.
    expect(body.fairManifest.type).toBe('market:purchase');
    expect(mocks.recordPendingCheckout).not.toHaveBeenCalled();
  });
});
