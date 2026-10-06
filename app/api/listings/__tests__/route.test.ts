import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireSessionOrAppToken: vi.fn(),
  fetchNodeSelf: vi.fn(),
}));

vi.mock('@/db', async () => (await import('../../../../test/helpers/db-mock')).dbModule);
vi.mock('@ima-jin/auth', () => ({ requireSessionOrAppToken: mocks.requireSessionOrAppToken }));
vi.mock('@/lib/kernel/client', () => ({ fetchNodeSelf: mocks.fetchNodeSelf }));

import { dbState, renderSql } from '../../../../test/helpers/db-mock';
import { GET, POST } from '../route';

const SELLER = 'did:imajin:seller';

function signedIn(did = SELLER, via: 'token' | 'cookie' = 'token') {
  mocks.requireSessionOrAppToken.mockResolvedValue({ auth: { did, scopes: [], via } });
}

function anonymous() {
  mocks.requireSessionOrAppToken.mockResolvedValue({ error: 'Not authenticated', status: 401 });
}

function post(body: unknown) {
  return POST(
    new Request('https://market.imajin.ai/api/listings', {
      method: 'POST',
      body: JSON.stringify(body),
    }) as Parameters<typeof POST>[0]
  );
}

function get(qs = '') {
  return GET(new Request(`https://market.imajin.ai/api/listings${qs}`) as Parameters<typeof GET>[0]);
}

const VALID = { title: 'Vintage Chair', price: 5000, contactInfo: { email: 'seller@example.com' } };

beforeEach(() => {
  vi.clearAllMocks();
  dbState.reset();
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://market.imajin.ai');
  vi.stubEnv('NEXT_PUBLIC_MEDIA_URL', 'https://media.test');
  mocks.fetchNodeSelf.mockResolvedValue(null);
  signedIn();
});

describe('POST /api/listings', () => {
  it('requires authentication and passes the auth failure through', async () => {
    anonymous();

    const res = await post(VALID);

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Not authenticated' });
    expect(dbState.calls).toHaveLength(0);
  });

  it('authenticates with an app token scoped to this app host', async () => {
    dbState.queue([{ id: 'lst_x' }]);

    await post(VALID);

    expect(mocks.requireSessionOrAppToken).toHaveBeenCalledWith(expect.any(Request), {
      aud: 'market.imajin.ai',
      requireScopes: undefined,
    });
  });

  it.each([
    [{ ...VALID, title: '' }, 'title is required'],
    [{ ...VALID, title: undefined }, 'title is required'],
    [{ ...VALID, price: 0 }, 'price must be greater than 0'],
    [{ ...VALID, price: -5 }, 'price must be greater than 0'],
    [{ ...VALID, price: undefined }, 'price must be greater than 0'],
    [{ ...VALID, images: 'not-an-array' }, 'images must be an array with at most 8 items'],
    [{ ...VALID, images: Array.from({ length: 9 }, (_, i) => `img${i}`) }, 'images must be an array with at most 8 items'],
    [{ ...VALID, sellerTier: 'vip' }, 'sellerTier must be one of: public_offplatform, public_onplatform, trust_gated'],
    [
      { title: 'x', price: 1 },
      'contactInfo must include at least one of: phone, email, whatsapp for public_offplatform tier',
    ],
    [
      { title: 'x', price: 1, sellerTier: 'public_offplatform', contactInfo: {} },
      'contactInfo must include at least one of: phone, email, whatsapp for public_offplatform tier',
    ],
  ])('rejects an invalid body with 400 before touching the database (%#)', async (body, message) => {
    const res = await post(body);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: message });
    expect(dbState.calls).toHaveLength(0);
    expect(mocks.fetchNodeSelf).not.toHaveBeenCalled();
  });

  it('does not require contact info for on-platform tiers', async () => {
    dbState.queue([{ id: 'lst_1', currency: 'CAD' }]);

    const res = await post({ title: 'x', price: 100, sellerTier: 'public_onplatform' });

    expect(res.status).toBe(201);
  });

  it('creates the listing for the caller with defaults applied and a .fair manifest', async () => {
    dbState.queue([{ id: 'lst_created', currency: 'CAD' }]);

    const res = await post(VALID);

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: 'lst_created', currency: 'CAD' });

    const [values] = dbState.argsOf('values', 'insert')[0] as [Record<string, unknown>];
    expect(values).toMatchObject({
      sellerDid: SELLER,
      title: 'Vintage Chair',
      price: 5000,
      description: null,
      currency: 'CAD',
      category: null,
      images: [],
      imageAssetIds: [],
      quantity: 1,
      sellerTier: 'public_offplatform',
      contactInfo: { email: 'seller@example.com' },
      trustThreshold: null,
      rangeKm: 50,
      metadata: {},
      type: 'sale',
      showContactInfo: false,
      expiresAt: null,
    });
    expect(values.id).toMatch(/^lst_/);
    const manifest = values.fairManifest as { chain: Array<{ did: string }> };
    expect(manifest.chain.some((entry) => entry.did === SELLER)).toBe(true);
  });

  it('honours every optional field the caller supplies', async () => {
    dbState.queue([{ id: 'lst_1', currency: 'USD' }]);

    await post({
      ...VALID,
      description: 'Solid oak',
      currency: 'USD',
      category: 'furniture',
      images: ['a.jpg'],
      imageAssetIds: ['asset_1'],
      quantity: 0,
      trustThreshold: 3,
      rangeKm: 0,
      metadata: { condition: 'good' },
      type: 'rental',
      showContactInfo: true,
      expiresAt: '2030-01-01T00:00:00.000Z',
    });

    const [values] = dbState.argsOf('values', 'insert')[0] as [Record<string, unknown>];
    expect(values).toMatchObject({
      description: 'Solid oak',
      currency: 'USD',
      category: 'furniture',
      images: ['a.jpg'],
      imageAssetIds: ['asset_1'],
      quantity: 0,
      trustThreshold: 3,
      rangeKm: 0,
      metadata: { condition: 'good' },
      type: 'rental',
      showContactInfo: true,
      expiresAt: new Date('2030-01-01T00:00:00.000Z'),
    });
  });

  it("sources the manifest's fee config from the kernel registry", async () => {
    mocks.fetchNodeSelf.mockResolvedValue({ nodeFeeBps: 200, buyerCreditBps: 50, nodeOperatorDid: 'did:imajin:operator' });
    dbState.queue([{ id: 'lst_1', currency: 'CAD' }]);

    await post(VALID);

    const [values] = dbState.argsOf('values', 'insert')[0] as [Record<string, unknown>];
    const chain = (values.fairManifest as { chain: Array<{ did: string }> }).chain;
    expect(chain.some((entry) => entry.did === 'did:imajin:operator')).toBe(true);
  });

  it('returns 500 when the insert fails', async () => {
    dbState.queue(new Error('db down'));

    const res = await post(VALID);

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to create listing' });
  });

  it('returns 500 on an unparseable body', async () => {
    const res = await POST(
      new Request('https://market.imajin.ai/api/listings', { method: 'POST', body: '{nope' }) as Parameters<
        typeof POST
      >[0]
    );

    expect(res.status).toBe(500);
  });
});

describe('GET /api/listings', () => {
  const rows = [
    { id: 'lst_1', images: ['asset_a', 'https://cdn.test/b.jpg'], price: 100 },
    { id: 'lst_2', images: 'legacy-not-array', price: 200 },
  ];

  function queueRows(total: number) {
    dbState.queue(rows, [{ count: total }]);
  }

  function whereSql() {
    return renderSql(dbState.argsOf('where', 'select')[0][0]);
  }

  it('is public: anonymous callers get active, non-trust_gated listings, paginated', async () => {
    anonymous();
    queueRows(2);

    const res = await get();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ total: 2, page: 1, limit: 20, hasMore: false });
    const { sql, params } = whereSql();
    expect(sql).toContain('"status" = $1');
    expect(sql).toContain("!= 'trust_gated'");
    expect(params).toEqual(['active']);
    expect(dbState.argsOf('limit', 'select')[0]).toEqual([20]);
    expect(dbState.argsOf('offset', 'select')[0]).toEqual([0]);
  });

  it('shows trust_gated listings to authenticated callers', async () => {
    queueRows(2);

    await get();

    expect(whereSql().sql).not.toContain('trust_gated');
  });

  it('resolves asset refs to CDN card URLs and leaves legacy URLs and non-arrays alone', async () => {
    queueRows(2);

    const body = await (await get()).json();

    expect(body.listings[0].images).toEqual(['https://media.test/api/assets/asset_a?w=400', 'https://cdn.test/b.jpg']);
    expect(body.listings[1].images).toBe('legacy-not-array');
  });

  it('computes hasMore from page, limit and total', async () => {
    queueRows(45);

    const body = await (await get('?page=1&limit=2')).json();

    expect(body).toMatchObject({ total: 45, page: 1, limit: 2, hasMore: true });
  });

  it('lets a seller see all of their own statuses when no status filter is given', async () => {
    signedIn(SELLER);
    queueRows(2);

    await get(`?seller_did=${SELLER}`);

    expect(whereSql().sql).not.toContain('"status"');
  });

  it('applies filters and sort order', async () => {
    anonymous();
    queueRows(0);

    await get('?category=chair&currency=cad&seller_tier=public_onplatform&exclude=lst_9&sort=price_desc&page=2&limit=5');

    const { params } = whereSql();
    expect(params).toEqual(expect.arrayContaining(['%chair%', 'CAD', 'public_onplatform', 'lst_9']));
    expect(renderSql(dbState.argsOf('orderBy', 'select')[0][0]).sql).toContain('"price" desc');
    expect(dbState.argsOf('offset', 'select')[0]).toEqual([5]);
  });

  it('returns 500 when the query fails', async () => {
    dbState.queue(new Error('db down'), [{ count: 0 }]);

    const res = await get();

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to fetch listings' });
  });
});
