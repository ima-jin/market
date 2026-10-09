import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireSessionOrAppToken: vi.fn(),
  isHardIdentity: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock('@/db', async () => (await import('../../../../../../test/helpers/db-mock')).dbModule);
vi.mock('@ima-jin/auth', () => ({ requireSessionOrAppToken: mocks.requireSessionOrAppToken }));
vi.mock('@/lib/kernel/client', () => ({ isHardIdentity: mocks.isHardIdentity }));

import { dbState } from '../../../../../../test/helpers/db-mock';
import { POST } from '../route';

const ROUTE_PARAMS = { params: Promise.resolve({ id: 'lst_1' }) };

const LISTING = {
  id: 'lst_1',
  sellerDid: 'did:imajin:seller',
  title: 'Chair',
  description: 'Oak',
  price: 5000,
  currency: 'CAD',
  status: 'active',
  sellerTier: 'public_onplatform',
  // No `chain`: a chain-less listing checks out plainly (the chain/app-token flow is in settle.test.ts).
  fairManifest: { version: '1.0', distributions: [{ did: 'did:imajin:seller', share: 1 }] },
};

function anonymous() {
  mocks.requireSessionOrAppToken.mockResolvedValue({ error: 'Not authenticated', status: 401 });
}

function signedIn(did = 'did:imajin:buyer', via: 'token' | 'cookie' = 'token') {
  mocks.requireSessionOrAppToken.mockResolvedValue({ auth: { did, scopes: [], via } });
}

function purchase(body?: string) {
  return POST(
    new Request('https://market.imajin.ai/api/listings/lst_1/purchase', { method: 'POST', body }) as Parameters<
      typeof POST
    >[0],
    ROUTE_PARAMS
  );
}

function payOk(body: unknown = { url: 'https://checkout.test/s', id: 'cs_1' }) {
  mocks.fetch.mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
}

function payBody() {
  return JSON.parse(mocks.fetch.mock.calls[0][1].body as string);
}

beforeEach(() => {
  vi.clearAllMocks();
  dbState.reset();
  vi.stubGlobal('fetch', mocks.fetch);
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://market.imajin.ai');
  vi.stubEnv('NEXT_PUBLIC_BASE_PATH', '');
  vi.stubEnv('PAY_SERVICE_URL', 'https://pay.test');
  mocks.isHardIdentity.mockResolvedValue(true);
  anonymous();
  payOk();
});

describe('POST /api/listings/:id/purchase', () => {
  it('returns 404 for an unknown listing', async () => {
    dbState.queue([]);

    const res = await purchase();

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Listing not found' });
  });

  it('refuses listings that are not active', async () => {
    dbState.queue([{ ...LISTING, status: 'sold' }]);

    const res = await purchase();

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'This listing is not available' });
  });

  it('refuses off-platform listings (contact the seller directly)', async () => {
    dbState.queue([{ ...LISTING, sellerTier: 'public_offplatform' }]);

    const res = await purchase();

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'This listing requires direct contact with the seller' });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('lets an anonymous buyer check out an on-platform listing via the pay service', async () => {
    dbState.queue([LISTING]);

    const res = await purchase();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: 'https://checkout.test/s', sessionId: 'cs_1' });

    const [url, init] = mocks.fetch.mock.calls[0];
    expect(url).toBe('https://pay.test/api/checkout');
    expect(init.method).toBe('POST');
    const body = payBody();
    expect(body).toMatchObject({
      items: [{ name: 'Chair', description: 'Oak', amount: 5000, quantity: 1 }],
      currency: 'CAD',
      successUrl: 'https://market.imajin.ai/checkout/success?session_id={CHECKOUT_SESSION_ID}&listing=lst_1',
      cancelUrl: 'https://market.imajin.ai/listings/lst_1',
      fairManifest: LISTING.fairManifest,
      metadata: {
        service: 'market',
        listingId: 'lst_1',
        listingTitle: 'Chair',
        sellerDid: 'did:imajin:seller',
      },
    });
    expect(body.metadata.buyerDid).toBeUndefined();
  });

  it('records the signed-in buyer DID', async () => {
    signedIn('did:imajin:buyer');
    dbState.queue([LISTING]);

    await purchase();

    expect(payBody().metadata.buyerDid).toBe('did:imajin:buyer');
  });

  it('mounts redirect URLs under the app base path', async () => {
    vi.stubEnv('NEXT_PUBLIC_BASE_PATH', '/market');
    dbState.queue([LISTING]);

    await purchase();

    expect(payBody().successUrl).toBe(
      'https://market.imajin.ai/market/checkout/success?session_id={CHECKOUT_SESSION_ID}&listing=lst_1'
    );
    expect(payBody().cancelUrl).toBe('https://market.imajin.ai/market/listings/lst_1');
  });

  it('honours a positive numeric quantity and ignores everything else', async () => {
    for (const [raw, expected] of [
      ['{"quantity":3}', 3],
      ['{"quantity":0}', 1],
      ['{"quantity":-2}', 1],
      ['{"quantity":"5"}', 1],
      ['not json', 1],
      [undefined, 1],
    ] as const) {
      dbState.reset();
      mocks.fetch.mockClear();
      payOk();
      dbState.queue([LISTING]);

      await purchase(raw);

      expect(payBody().items[0].quantity).toBe(expected);
    }
  });

  it("falls back to a 99/1 seller/platform split when the listing has no .fair manifest", async () => {
    dbState.queue([{ ...LISTING, fairManifest: null }]);

    await purchase();

    expect(payBody().fairManifest).toEqual({
      version: '1.0',
      type: 'market:purchase',
      distributions: [
        { did: 'did:imajin:seller', share: 0.99, role: 'seller' },
        { did: 'did:imajin:platform', share: 0.01, role: 'platform' },
      ],
    });
  });

  it('omits an empty description from the checkout item', async () => {
    dbState.queue([{ ...LISTING, description: null }]);

    await purchase();

    expect(payBody().items[0].description).toBeUndefined();
  });

  describe('trust_gated listings', () => {
    const GATED = { ...LISTING, sellerTier: 'trust_gated' };

    it('rejects anonymous buyers with 403', async () => {
      dbState.queue([GATED]);

      const res = await purchase();

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'This listing requires a verified identity to purchase' });
      expect(mocks.fetch).not.toHaveBeenCalled();
    });

    it('rejects authenticated buyers without a hard identity', async () => {
      signedIn('did:imajin:soft', 'cookie');
      mocks.isHardIdentity.mockResolvedValue(false);
      dbState.queue([GATED]);

      expect((await purchase()).status).toBe(403);
      expect(mocks.fetch).not.toHaveBeenCalled();
    });

    it('lets a hard-identity buyer purchase and records their DID', async () => {
      signedIn('did:imajin:hard', 'cookie');
      dbState.queue([GATED]);

      const res = await purchase();

      expect(res.status).toBe(200);
      expect(mocks.isHardIdentity).toHaveBeenCalledWith(expect.any(Request), {
        did: 'did:imajin:hard',
        scopes: [],
        via: 'cookie',
      });
      expect(payBody().metadata.buyerDid).toBe('did:imajin:hard');
    });
  });

  it('surfaces a pay-service error as 500 with its message', async () => {
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ error: 'card declined' }), { status: 402 }));
    dbState.queue([LISTING]);

    const res = await purchase();

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'card declined' });
  });

  describe('seller card rail (#2773)', () => {
    function payRefuses(body: unknown, status: number) {
      mocks.fetch.mockResolvedValue(new Response(JSON.stringify(body), { status }));
      dbState.queue([LISTING]);
    }

    it('answers a seller with no card rail with a plain 400 and the code, never a generic error', async () => {
      payRefuses({ error: "This seller hasn't set up card payments", code: 'SELLER_NO_CARD_RAIL' }, 400);

      const res = await purchase();

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "Card payments aren't set up for this seller yet. Please contact the seller about another way to pay.",
        code: 'SELLER_NO_CARD_RAIL',
      });
    });

    it.each(['CARD_RAIL_KEY_MISSING', 'CARD_RAIL_KEY_REJECTED', 'CARD_RAIL_UNAVAILABLE', 'CARD_RAIL_REQUEST_REJECTED'])(
      'answers %s with a plain 502 that names the seller\'s Stripe account',
      async (code) => {
        payRefuses({ error: "Card payment could not be started on the seller's Stripe account", code }, 502);

        const res = await purchase();

        expect(res.status).toBe(502);
        expect(await res.json()).toEqual({
          error: "Card payment couldn't be started on the seller's Stripe account. Please try again later or contact the seller.",
          code,
        });
      }
    );

    it('does not record a pending checkout or emit a purchase event for a refused checkout', async () => {
      payRefuses({ code: 'SELLER_NO_CARD_RAIL' }, 400);

      await purchase();

      expect(dbState.argsOf('set', 'update')).toHaveLength(0);
    });

    it('keeps the generic 500 for an unrelated pay error code and for a non-JSON error body', async () => {
      payRefuses({ error: 'boom', code: 'SOMETHING_ELSE' }, 500);
      expect(await (await purchase()).json()).toEqual({ error: 'boom' });

      mocks.fetch.mockResolvedValue(new Response('<html>bad gateway</html>', { status: 502 }));
      dbState.queue([LISTING]);
      const res = await purchase();
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'Payment service error' });
    });
  });

  it('uses a generic message when the pay service gives none', async () => {
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify({}), { status: 500 }));
    dbState.queue([LISTING]);

    expect(await (await purchase()).json()).toEqual({ error: 'Payment service error' });
  });

  it('returns 500 "Purchase failed" on unexpected errors', async () => {
    dbState.queue(new Error('db down'));

    const res = await purchase();

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Purchase failed' });
  });

  it('returns 500 when PAY_SERVICE_URL is not configured', async () => {
    vi.stubEnv('PAY_SERVICE_URL', '');
    dbState.queue([LISTING]);

    expect((await purchase()).status).toBe(500);
  });
});
