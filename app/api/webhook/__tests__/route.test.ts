import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ emitEvent: vi.fn(), settleListingPurchase: vi.fn() }));

vi.mock('@/db', async () => (await import('../../../../test/helpers/db-mock')).dbModule);
vi.mock('@/lib/kernel/events', () => ({ emitEvent: mocks.emitEvent }));
vi.mock('@/lib/settle', () => ({ settleListingPurchase: mocks.settleListingPurchase }));
// The real pending-checkout reader: the recorded entry is looked up exactly as in production.
vi.mock('@/lib/pending-checkout', async () => import('../../../../src/lib/pending-checkout'));

import { dbState } from '../../../../test/helpers/db-mock';
import { POST } from '../route';

const SECRET = 'whsec_test_value';

function hook(body: unknown, headers: Record<string, string> = {}) {
  return POST(
    new Request('https://market.imajin.ai/api/webhook', {
      method: 'POST',
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }) as Parameters<typeof POST>[0]
  );
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
  vi.stubEnv('WEBHOOK_SECRET', SECRET);
});

describe('POST /api/webhook — authorization', () => {
  const expectRejected = async (res: Response) => {
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(dbState.calls).toHaveLength(0);
    expect(mocks.settleListingPurchase).not.toHaveBeenCalled();
    expect(mocks.emitEvent).not.toHaveBeenCalled();
  };

  it('rejects a request with no secret', async () => {
    await expectRejected(await hook(PAID));
  });

  it('rejects a wrong Bearer secret', async () => {
    await expectRejected(await hook(PAID, { Authorization: 'Bearer nope' }));
  });

  it('rejects a Bearer secret of a different length, and a non-Bearer scheme', async () => {
    await expectRejected(await hook(PAID, { Authorization: `Bearer ${SECRET}x` }));
    await expectRejected(await hook(PAID, { Authorization: `Bearer ${SECRET.slice(1)}` }));
    await expectRejected(await hook(PAID, { Authorization: `Basic ${SECRET}` }));
    await expectRejected(await hook(PAID, { Authorization: SECRET }));
  });

  it('rejects the legacy x-webhook-secret header and the body secret, even with the correct value (#2743)', async () => {
    await expectRejected(await hook(PAID, { 'x-webhook-secret': SECRET }));
    await expectRejected(await hook({ ...PAID, secret: SECRET }));
    await expectRejected(await hook({ ...PAID, secret: 12345 }));
  });

  it('fails closed when WEBHOOK_SECRET is not configured, even with no secret supplied', async () => {
    vi.stubEnv('WEBHOOK_SECRET', '');

    await expectRejected(await hook(PAID));
    await expectRejected(await hook(PAID, { Authorization: 'Bearer ' }));
    await expectRejected(await hook(PAID, { Authorization: 'Bearer undefined' }));
    await expectRejected(await hook(PAID, { Authorization: `Bearer ${SECRET}` }));
  });

  it("accepts the kernel's Bearer secret", async () => {
    dbState.queue([LISTING], undefined);

    const res = await hook(PAID, { Authorization: `Bearer ${SECRET}` });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
  });
});

describe('POST /api/webhook — payment handling', () => {
  const authed = { Authorization: `Bearer ${SECRET}` };

  it.each([
    [{ type: 'payment.succeeded' }],
    [{ status: 'paid' }],
    [{ status: 'succeeded' }],
  ])('treats %j as a successful payment', async (marker) => {
    dbState.reset();
    dbState.queue([LISTING], undefined);

    await hook({ ...marker, metadata: PAID.metadata }, authed);

    expect(setValues()).toMatchObject({ status: 'sold' });
  });

  it('acknowledges but ignores other events', async () => {
    const res = await hook({ type: 'payment.failed', metadata: PAID.metadata }, authed);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
    expect(dbState.calls).toHaveLength(0);
    expect(mocks.emitEvent).not.toHaveBeenCalled();
  });

  it('acknowledges a payment with no listingId without touching the database', async () => {
    const res = await hook({ type: 'payment.succeeded', metadata: {} }, authed);

    expect(res.status).toBe(200);
    expect(dbState.calls).toHaveLength(0);
  });

  it('acknowledges a payment for an unknown listing without updating anything', async () => {
    dbState.queue([]);

    const res = await hook(PAID, authed);

    expect(res.status).toBe(200);
    expect(dbState.argsOf('set', 'update')).toHaveLength(0);
    expect(mocks.emitEvent).not.toHaveBeenCalled();
  });

  it('marks a single-quantity listing sold', async () => {
    dbState.queue([{ ...LISTING, quantity: 1 }], undefined);

    await hook(PAID, authed);

    expect(setValues()).toMatchObject({ status: 'sold' });
    expect(setValues().quantity).toBeUndefined();
  });

  it('marks an unlimited-quantity (null) listing sold', async () => {
    dbState.queue([{ ...LISTING, quantity: null }], undefined);

    await hook(PAID, authed);

    expect(setValues()).toMatchObject({ status: 'sold' });
  });

  it('decrements a multi-quantity listing and keeps its status while stock remains', async () => {
    dbState.queue([{ ...LISTING, quantity: 3, status: 'active' }], undefined);

    await hook(PAID, authed);

    expect(setValues()).toMatchObject({ quantity: 2, status: 'active' });
  });

  it('emits listing.purchased with the buyer, seller and manifest', async () => {
    dbState.queue([LISTING], undefined);

    await hook(PAID, authed);

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

    await hook({ type: 'payment.succeeded', metadata: { listingId: 'lst_1' } }, authed);

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

    const res = await hook(PAID, authed);

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Webhook processing failed' });
  });

  it('returns 500 on an unparseable body', async () => {
    expect((await hook('{nope', authed)).status).toBe(500);
  });
});

describe('POST /api/webhook — settlement (#2740)', () => {
  const authed = { Authorization: `Bearer ${SECRET}` };
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

    const res = await hook(paid(), authed);

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
      paid({ sessionId: undefined, metadata: { listingId: 'lst_1', buyerDid: 'did:imajin:buyer', sessionId: SESSION_ID } }),
      authed
    );
    expect(mocks.settleListingPurchase).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionId: SESSION_ID, currency: 'USD' })
    );

    dbState.reset();
    dbState.queue([settlable({ currency: null })], undefined);
    await hook(paid({ metadata: { listingId: 'lst_1' } }), authed);
    expect(mocks.settleListingPurchase).toHaveBeenLastCalledWith(expect.objectContaining({ currency: 'CAD' }));
  });

  it('does not settle when the webhook carries no Stripe session id', async () => {
    dbState.queue([settlable()], undefined);

    const res = await hook(paid({ sessionId: undefined }), authed);

    expect(res.status).toBe(200);
    expect(mocks.settleListingPurchase).not.toHaveBeenCalled();
  });

  it('does not settle when no checkout was recorded for the session (e.g. a replay after settling)', async () => {
    dbState.queue([settlable({ metadata: { pendingCheckouts: {} } })], undefined);

    const res = await hook(paid(), authed);

    expect(res.status).toBe(200);
    expect(mocks.settleListingPurchase).not.toHaveBeenCalled();
  });

  it('skips settlement for a listing without a .fair manifest chain', async () => {
    dbState.queue([settlable({ fairManifest: null })], undefined);
    await hook(paid(), authed);
    expect(mocks.settleListingPurchase).not.toHaveBeenCalled();

    dbState.reset();
    dbState.queue([settlable({ fairManifest: { version: '1.0', chain: [] } })], undefined);
    await hook(paid(), authed);
    expect(mocks.settleListingPurchase).not.toHaveBeenCalled();
  });

  it('does not settle a payment that did not succeed', async () => {
    const res = await hook({ ...paid(), type: 'payment.failed' }, authed);

    expect(res.status).toBe(200);
    expect(mocks.settleListingPurchase).not.toHaveBeenCalled();
  });

  it('decrements a multi-quantity listing and still settles', async () => {
    dbState.queue([settlable({ quantity: 3 })], undefined);

    await hook(paid(), authed);

    expect(setValues()).toMatchObject({ quantity: 2, status: 'active' });
    expect(mocks.settleListingPurchase).toHaveBeenCalledTimes(1);
  });
});
