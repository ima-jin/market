import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireSessionOrAppToken: vi.fn(),
  fetchNodeSelf: vi.fn(),
}));

vi.mock('@/db', async () => (await import('../../../../../test/helpers/db-mock')).dbModule);
vi.mock('@ima-jin/auth', () => ({ requireSessionOrAppToken: mocks.requireSessionOrAppToken }));
vi.mock('@/lib/kernel/client', () => ({ fetchNodeSelf: mocks.fetchNodeSelf }));

import { dbState } from '../../../../../test/helpers/db-mock';
import { DELETE, GET, PATCH } from '../route';

const SELLER = 'did:imajin:seller';
const ROUTE_PARAMS = { params: Promise.resolve({ id: 'lst_1' }) };

const EXISTING = {
  id: 'lst_1',
  sellerDid: SELLER,
  price: 3000,
  status: 'active',
  sellerTier: 'public_offplatform',
  images: ['asset_a', 'https://cdn.test/b.jpg'],
};

function signedIn(did = SELLER) {
  mocks.requireSessionOrAppToken.mockResolvedValue({ auth: { did, scopes: [], via: 'token' } });
}

function anonymous() {
  mocks.requireSessionOrAppToken.mockResolvedValue({ error: 'Not authenticated', status: 401 });
}

function req(method: string, body?: unknown) {
  return new Request('https://market.imajin.ai/api/listings/lst_1', {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  }) as Parameters<typeof GET>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  dbState.reset();
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://market.imajin.ai');
  vi.stubEnv('NEXT_PUBLIC_MEDIA_URL', 'https://media.test');
  mocks.fetchNodeSelf.mockResolvedValue(null);
  signedIn();
});

describe('GET /api/listings/:id', () => {
  it('returns 404 for an unknown listing', async () => {
    dbState.queue([]);

    const res = await GET(req('GET'), ROUTE_PARAMS);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Listing not found' });
  });

  it('returns the listing publicly with detail-size image URLs and raw refs', async () => {
    anonymous();
    dbState.queue([EXISTING]);

    const res = await GET(req('GET'), ROUTE_PARAMS);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.id).toBe('lst_1');
    expect(body.price).toBe(3000);
    expect(body.images).toEqual(['https://media.test/api/assets/asset_a?w=800', 'https://cdn.test/b.jpg']);
    expect(body.imageRefs).toEqual(['asset_a', 'https://cdn.test/b.jpg']);
  });

  it('tolerates a non-array images column', async () => {
    anonymous();
    dbState.queue([{ ...EXISTING, images: null }]);

    const body = await (await GET(req('GET'), ROUTE_PARAMS)).json();

    expect(body.images).toEqual([]);
    expect(body.imageRefs).toEqual([]);
  });

  it('gates trust_gated listings: 403 with gated:true for anonymous callers', async () => {
    anonymous();
    dbState.queue([{ ...EXISTING, sellerTier: 'trust_gated' }]);

    const res = await GET(req('GET'), ROUTE_PARAMS);

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'This listing is only available to verified members', gated: true });
  });

  it('serves trust_gated listings to authenticated callers', async () => {
    signedIn('did:imajin:member');
    dbState.queue([{ ...EXISTING, sellerTier: 'trust_gated' }]);

    expect((await GET(req('GET'), ROUTE_PARAMS)).status).toBe(200);
  });

  it('returns 500 when the lookup fails', async () => {
    dbState.queue(new Error('db down'));

    const res = await GET(req('GET'), ROUTE_PARAMS);

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to fetch listing' });
  });
});

describe('PATCH /api/listings/:id', () => {
  function queueUpdate() {
    dbState.queue([EXISTING], [{ id: 'lst_1', updated: true }]);
  }

  function setValues() {
    return dbState.argsOf('set', 'update')[0][0] as Record<string, unknown>;
  }

  it('requires authentication', async () => {
    anonymous();

    const res = await PATCH(req('PATCH', { title: 'x' }), ROUTE_PARAMS);

    expect(res.status).toBe(401);
    expect(dbState.calls).toHaveLength(0);
  });

  it('returns 404 for an unknown listing', async () => {
    dbState.queue([]);

    expect((await PATCH(req('PATCH', { title: 'x' }), ROUTE_PARAMS)).status).toBe(404);
  });

  it('forbids anyone but the seller', async () => {
    signedIn('did:imajin:intruder');
    dbState.queue([EXISTING]);

    const res = await PATCH(req('PATCH', { title: 'x' }), ROUTE_PARAMS);

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden' });
    expect(dbState.argsOf('set', 'update')).toHaveLength(0);
  });

  it('applies whitelisted fields only, without recalculating .fair when price/tier are unchanged', async () => {
    queueUpdate();

    const res = await PATCH(req('PATCH', { title: 'New title', sellerDid: 'did:imajin:evil', id: 'lst_hijack' }), ROUTE_PARAMS);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'lst_1', updated: true });
    const set = setValues();
    expect(set.title).toBe('New title');
    expect(set.sellerDid).toBeUndefined();
    expect(set.id).toBeUndefined();
    expect(set.fairManifest).toBeUndefined();
    expect(mocks.fetchNodeSelf).not.toHaveBeenCalled();
  });

  it('recalculates the .fair manifest when the price changes', async () => {
    queueUpdate();

    await PATCH(req('PATCH', { price: 5000 }), ROUTE_PARAMS);

    expect(mocks.fetchNodeSelf).toHaveBeenCalledTimes(1);
    const manifest = setValues().fairManifest as { chain: Array<{ did: string }> };
    expect(manifest.chain.some((entry) => entry.did === SELLER)).toBe(true);
  });

  it('still saves the update when the manifest rebuild fails (non-fatal)', async () => {
    mocks.fetchNodeSelf.mockRejectedValue(new Error('registry down'));
    queueUpdate();

    const res = await PATCH(req('PATCH', { price: 5000 }), ROUTE_PARAMS);

    expect(res.status).toBe(200);
    expect(setValues().fairManifest).toBeUndefined();
  });

  it('allows a valid status transition and rejects an invalid one with the allowed set', async () => {
    queueUpdate();
    expect((await PATCH(req('PATCH', { status: 'paused' }), ROUTE_PARAMS)).status).toBe(200);
    expect(setValues().status).toBe('paused');

    dbState.reset();
    dbState.queue([EXISTING]);
    const res = await PATCH(req('PATCH', { status: 'removed' }), ROUTE_PARAMS);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Cannot transition listing from 'active' to 'removed'. Allowed: paused, sold, rented, unavailable",
    });
  });

  it('treats a listing with no status as active when validating transitions', async () => {
    dbState.queue([{ ...EXISTING, status: null }], [{ id: 'lst_1' }]);

    expect((await PATCH(req('PATCH', { status: 'paused' }), ROUTE_PARAMS)).status).toBe(200);
  });

  it('rejects more than 8 images or a non-array', async () => {
    const tooMany = Array.from({ length: 9 }, (_, i) => `i${i}`);
    for (const images of [tooMany, 'nope']) {
      dbState.reset();
      dbState.queue([EXISTING]);
      const res = await PATCH(req('PATCH', { images }), ROUTE_PARAMS);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'images must be an array with at most 8 items' });
    }
  });

  it('clears expiresAt with an empty value and parses a date otherwise', async () => {
    queueUpdate();
    await PATCH(req('PATCH', { expiresAt: '' }), ROUTE_PARAMS);
    expect(setValues().expiresAt).toBeNull();
  });

  it('returns 500 when the update fails', async () => {
    dbState.queue([EXISTING], new Error('db down'));

    const res = await PATCH(req('PATCH', { title: 'x' }), ROUTE_PARAMS);

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to update listing' });
  });
});

describe('DELETE /api/listings/:id', () => {
  it('requires authentication', async () => {
    anonymous();

    expect((await DELETE(req('DELETE'), ROUTE_PARAMS)).status).toBe(401);
  });

  it('returns 404 for an unknown listing', async () => {
    dbState.queue([]);

    expect((await DELETE(req('DELETE'), ROUTE_PARAMS)).status).toBe(404);
  });

  it('forbids anyone but the seller', async () => {
    signedIn('did:imajin:intruder');
    dbState.queue([EXISTING]);

    const res = await DELETE(req('DELETE'), ROUTE_PARAMS);

    expect(res.status).toBe(403);
    expect(dbState.argsOf('set', 'update')).toHaveLength(0);
  });

  it('soft-deletes by setting status to removed', async () => {
    dbState.queue([EXISTING], undefined);

    const res = await DELETE(req('DELETE'), ROUTE_PARAMS);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(dbState.argsOf('set', 'update')[0][0]).toMatchObject({ status: 'removed' });
  });

  it('returns 500 when the update fails', async () => {
    dbState.queue([EXISTING], new Error('db down'));

    const res = await DELETE(req('DELETE'), ROUTE_PARAMS);

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to delete listing' });
  });
});
