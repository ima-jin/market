import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/db', async () => (await import('../../../../../../test/helpers/db-mock')).dbModule);

import { dbState, renderSql } from '../../../../../../test/helpers/db-mock';
import { GET } from '../route';

function get(did: string) {
  return GET(new Request(`https://market.imajin.ai/api/seller/${did}/profile-listings`) as Parameters<typeof GET>[0], {
    params: Promise.resolve({ did }),
  });
}

beforeEach(() => {
  dbState.reset();
});

describe('GET /api/seller/:did/profile-listings', () => {
  it('rejects an empty DID', async () => {
    const res = await get('');

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'did is required' });
  });

  it('is public and returns an empty, disabled result when the seller has no settings row', async () => {
    dbState.queue([]);

    const res = await get('did:imajin:a');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ listings: [], enabled: false });
    expect(dbState.argsOf('where', 'select')).toHaveLength(1);
  });

  it('returns disabled when the seller turned profile integration off', async () => {
    dbState.queue([{ did: 'did:imajin:a', showMarketItems: false }]);

    expect(await (await get('did:imajin:a')).json()).toEqual({ listings: [], enabled: false });
  });

  it("returns up to 8 of the seller's active listings, newest first, when enabled", async () => {
    const previews = [{ id: 'lst_1', title: 'Chair', price: 100 }];
    dbState.queue([{ did: 'did:imajin:a', showMarketItems: true }], previews);

    const res = await get('did:imajin:a');

    expect(await res.json()).toEqual({ listings: previews, enabled: true });
    const listingsWhere = renderSql(dbState.argsOf('where', 'select')[1][0]);
    expect(listingsWhere.sql).toContain('"seller_did" =');
    expect(listingsWhere.sql).toContain('"status" =');
    expect(listingsWhere.params).toEqual(['did:imajin:a', 'active']);
    expect(dbState.argsOf('limit', 'select')[0]).toEqual([8]);
  });

  it('returns 500 when the query fails', async () => {
    dbState.queue(new Error('db down'));

    const res = await get('did:imajin:a');

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to fetch profile listings' });
  });
});
