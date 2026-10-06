import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchNodeSelfMock } = vi.hoisted(() => ({ fetchNodeSelfMock: vi.fn() }));

vi.mock('@/db', async () => (await import('../../../test/helpers/db-mock')).dbModule);
vi.mock('@/lib/kernel/client', () => ({ fetchNodeSelf: fetchNodeSelfMock }));

import { renderSql } from '../../../test/helpers/db-mock';
import {
  andAll,
  buildListingFairManifest,
  buildListingUpdates,
  buildListingsWhereConditions,
  parseListingsQuery,
  parsePagination,
  recalculateFairManifest,
  resolveListingsSortOrder,
  validateStatusTransition,
} from '../listings';

const ORDER_PARAMS = (qs: string) => new URLSearchParams(qs);

function where(qs: string, overrides: Partial<Parameters<typeof buildListingsWhereConditions>[0]> = {}) {
  const searchParams = ORDER_PARAMS(qs);
  const query = parseListingsQuery(searchParams);
  const conditions = buildListingsWhereConditions({
    searchParams,
    status: query.status,
    sellerDid: query.sellerDid,
    authSellerDid: null,
    hasSession: true,
    exclude: query.exclude,
    category: query.category,
    currency: query.currency,
    sellerTier: query.sellerTier,
    ...overrides,
  });
  return renderSql(andAll(conditions));
}

describe('validateStatusTransition', () => {
  it.each([
    ['active', 'paused'],
    ['active', 'sold'],
    ['active', 'rented'],
    ['active', 'unavailable'],
    ['paused', 'active'],
    ['paused', 'removed'],
    ['unavailable', 'active'],
    ['sold', 'removed'],
    ['rented', 'removed'],
  ])('allows %s -> %s', (from, to) => {
    expect(validateStatusTransition(from, to)).toBeNull();
  });

  it('rejects invalid transitions with the allowed set in the message', () => {
    expect(validateStatusTransition('active', 'removed')).toBe(
      "Cannot transition listing from 'active' to 'removed'. Allowed: paused, sold, rented, unavailable"
    );
  });

  it('reports "none" for terminal and unknown states', () => {
    expect(validateStatusTransition('removed', 'active')).toBe(
      "Cannot transition listing from 'removed' to 'active'. Allowed: none"
    );
    expect(validateStatusTransition('mystery', 'active')).toContain('Allowed: none');
  });
});

describe('parsePagination', () => {
  it('defaults to page 1, limit 20', () => {
    expect(parsePagination(ORDER_PARAMS(''))).toEqual({ page: 1, limit: 20, offset: 0 });
  });

  it('computes the offset and clamps page >= 1 and 1 <= limit <= 100', () => {
    expect(parsePagination(ORDER_PARAMS('page=3&limit=10'))).toEqual({ page: 3, limit: 10, offset: 20 });
    expect(parsePagination(ORDER_PARAMS('page=-4&limit=0'))).toEqual({ page: 1, limit: 1, offset: 0 });
    expect(parsePagination(ORDER_PARAMS('limit=5000')).limit).toBe(100);
  });

  it('falls back to defaults for non-numeric input instead of NaN', () => {
    expect(parsePagination(ORDER_PARAMS('page=abc&limit=xyz'))).toEqual({ page: 1, limit: 20, offset: 0 });
  });
});

describe('parseListingsQuery', () => {
  it('applies defaults', () => {
    expect(parseListingsQuery(ORDER_PARAMS(''))).toMatchObject({
      category: null,
      status: 'active',
      currency: null,
      sellerTier: null,
      sellerDid: null,
      exclude: null,
      sort: 'newest',
      page: 1,
      limit: 20,
    });
  });

  it('reads every supported filter', () => {
    const query = parseListingsQuery(
      ORDER_PARAMS('category=chairs&status=paused&currency=cad&seller_tier=trust_gated&seller_did=did:x&exclude=lst_1&sort=price_asc')
    );
    expect(query).toMatchObject({
      category: 'chairs',
      status: 'paused',
      currency: 'cad',
      sellerTier: 'trust_gated',
      sellerDid: 'did:x',
      exclude: 'lst_1',
      sort: 'price_asc',
    });
  });
});

describe('resolveListingsSortOrder', () => {
  it('maps sort keys to column ordering', () => {
    expect(renderSql(resolveListingsSortOrder('price_asc')).sql).toContain('"price" asc');
    expect(renderSql(resolveListingsSortOrder('price_desc')).sql).toContain('"price" desc');
    expect(renderSql(resolveListingsSortOrder('newest')).sql).toContain('"created_at" desc');
    expect(renderSql(resolveListingsSortOrder('anything-else')).sql).toContain('"created_at" desc');
  });
});

describe('buildListingsWhereConditions', () => {
  it('shows only active listings by default', () => {
    const { sql, params } = where('');
    expect(sql).toContain('"status" = $1');
    expect(params).toEqual(['active']);
  });

  it('hides trust_gated listings from anonymous callers only', () => {
    expect(where('', { hasSession: false }).sql).toContain("!= 'trust_gated'");
    expect(where('', { hasSession: true }).sql).not.toContain('trust_gated');
  });

  it('applies the public filters', () => {
    const { sql, params } = where('category=chair&currency=cad&seller_tier=public_onplatform&exclude=lst_9&seller_did=did:s');
    expect(sql).toContain('"seller_did" =');
    expect(sql).toContain('"id" <>');
    expect(sql).toContain('ilike');
    expect(sql).toContain('"currency" =');
    expect(sql).toContain('"seller_tier" =');
    expect(params).toEqual(
      expect.arrayContaining(['active', 'did:s', 'lst_9', '%chair%', 'CAD', 'public_onplatform'])
    );
  });

  it('lets a seller viewing their own listings see every status unless they filter', () => {
    const own = where('seller_did=did:me', { authSellerDid: 'did:me' });
    expect(own.sql).toContain('"seller_did" =');
    expect(own.sql).not.toContain('"status"');

    const ownFiltered = where('seller_did=did:me&status=paused', { authSellerDid: 'did:me' });
    expect(ownFiltered.sql).toContain('"status" =');
    expect(ownFiltered.params).toContain('paused');
  });

  it("does not widen visibility when browsing someone else's listings", () => {
    const other = where('seller_did=did:other', { authSellerDid: 'did:me' });
    expect(other.sql).toContain('"status" =');
    expect(other.params).toEqual(expect.arrayContaining(['active', 'did:other']));
  });
});

describe('andAll', () => {
  it('returns undefined for no conditions', () => {
    expect(andAll([])).toBeUndefined();
  });
});

describe('buildListingUpdates', () => {
  it('copies only whitelisted, defined fields and stamps updatedAt', () => {
    const updates = buildListingUpdates({
      title: 'New',
      price: 10,
      status: 'paused',
      // @ts-expect-error — sellerDid is not patchable and must be ignored
      sellerDid: 'did:evil',
    });
    expect(updates.title).toBe('New');
    expect(updates.price).toBe(10);
    expect(updates.status).toBe('paused');
    expect(updates.sellerDid).toBeUndefined();
    expect(updates.updatedAt).toBeInstanceOf(Date);
    expect('description' in updates).toBe(false);
  });

  it('converts expiresAt to a Date, or null when cleared', () => {
    expect(buildListingUpdates({ expiresAt: '2030-01-01T00:00:00.000Z' }).expiresAt).toEqual(
      new Date('2030-01-01T00:00:00.000Z')
    );
    expect(buildListingUpdates({ expiresAt: '' }).expiresAt).toBeNull();
    expect('expiresAt' in buildListingUpdates({})).toBe(false);
  });
});

describe('.fair manifest', () => {
  beforeEach(() => {
    fetchNodeSelfMock.mockReset();
  });

  it("builds the manifest for the creator's DID with registry fee config", async () => {
    fetchNodeSelfMock.mockResolvedValue({ nodeFeeBps: 150, buyerCreditBps: 50, nodeOperatorDid: 'did:imajin:operator' });

    const manifest = await buildListingFairManifest('did:imajin:seller', 'lst_1');

    const chain = manifest.chain as Array<{ did: string; role: string; share: number }>;
    expect(chain.length).toBeGreaterThan(0);
    expect(chain.some((entry) => entry.did === 'did:imajin:seller')).toBe(true);
    expect(chain.some((entry) => entry.did === 'did:imajin:operator')).toBe(true);
  });

  it('falls back to .fair defaults when the registry is unavailable', async () => {
    fetchNodeSelfMock.mockResolvedValue(null);

    const manifest = await buildListingFairManifest('did:imajin:seller', 'lst_1');

    expect((manifest.chain as unknown[]).length).toBeGreaterThan(0);
  });

  const existing = {
    id: 'lst_1',
    sellerDid: 'did:imajin:seller',
    price: 3000,
    sellerTier: 'public_offplatform',
  } as Parameters<typeof recalculateFairManifest>[0]['listing'];

  it('does not recalculate (or call the registry) when nothing relevant changed', async () => {
    const result = await recalculateFairManifest({ did: 'did:imajin:seller', listing: existing, listingId: 'lst_1' });
    expect(result).toBeUndefined();
    expect(fetchNodeSelfMock).not.toHaveBeenCalled();

    const samePrice = await recalculateFairManifest({
      did: 'did:imajin:seller',
      listing: existing,
      listingId: 'lst_1',
      price: 3000,
      sellerTier: 'public_offplatform',
    });
    expect(samePrice).toBeUndefined();
  });

  it.each([
    ['price', { price: 5000 }, 'did:imajin:seller'],
    ['tier', { sellerTier: 'public_onplatform' }, 'did:imajin:seller'],
    ['seller DID', {}, 'did:imajin:new-owner'],
  ])('recalculates when the %s changes', async (_label, change, did) => {
    fetchNodeSelfMock.mockResolvedValue(null);

    const result = await recalculateFairManifest({ did, listing: existing, listingId: 'lst_1', ...change });

    expect(result).toBeDefined();
    expect(fetchNodeSelfMock).toHaveBeenCalledTimes(1);
  });

  it('treats a failed rebuild as non-fatal', async () => {
    fetchNodeSelfMock.mockRejectedValue(new Error('registry exploded'));

    const result = await recalculateFairManifest({
      did: 'did:imajin:seller',
      listing: existing,
      listingId: 'lst_1',
      price: 9999,
    });

    expect(result).toBeUndefined();
  });
});
