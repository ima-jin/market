import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ emitEvent: vi.fn() }));

vi.mock('@/db', async () => (await import('../../../../test/helpers/db-mock')).dbModule);
vi.mock('@/lib/kernel/events', () => ({ emitEvent: mocks.emitEvent }));

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
  it('rejects a request with no secret', async () => {
    const res = await hook(PAID);

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(dbState.calls).toHaveLength(0);
  });

  it('rejects a wrong secret (header and body)', async () => {
    expect((await hook(PAID, { 'x-webhook-secret': 'nope' })).status).toBe(401);
    expect((await hook({ ...PAID, secret: 'nope' })).status).toBe(401);
    expect((await hook({ ...PAID, secret: 12345 })).status).toBe(401);
  });

  it('rejects a secret of a different length without leaking via comparison errors', async () => {
    expect((await hook(PAID, { 'x-webhook-secret': `${SECRET}x` })).status).toBe(401);
    expect((await hook(PAID, { 'x-webhook-secret': SECRET.slice(1) })).status).toBe(401);
  });

  it('fails closed when WEBHOOK_SECRET is not configured, even with no secret supplied', async () => {
    vi.stubEnv('WEBHOOK_SECRET', '');

    expect((await hook(PAID)).status).toBe(401);
    expect((await hook(PAID, { 'x-webhook-secret': '' })).status).toBe(401);
    expect((await hook({ ...PAID, secret: '' })).status).toBe(401);
    expect(dbState.calls).toHaveLength(0);
  });

  it('accepts the secret from the x-webhook-secret header', async () => {
    dbState.queue([LISTING], undefined);

    const res = await hook(PAID, { 'x-webhook-secret': SECRET });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
  });

  it('accepts the secret from the body', async () => {
    dbState.queue([LISTING], undefined);

    expect((await hook({ ...PAID, secret: SECRET })).status).toBe(200);
  });
});

describe('POST /api/webhook — payment handling', () => {
  const authed = { 'x-webhook-secret': SECRET };

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
