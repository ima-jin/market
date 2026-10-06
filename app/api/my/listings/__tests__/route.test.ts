import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ requireSessionOrAppToken: vi.fn() }));

vi.mock('@/db', async () => (await import('../../../../../test/helpers/db-mock')).dbModule);
vi.mock('@ima-jin/auth', () => ({ requireSessionOrAppToken: mocks.requireSessionOrAppToken }));

import { dbState, renderSql } from '../../../../../test/helpers/db-mock';
import { GET } from '../route';

function get(qs = '') {
  return GET(new Request(`https://market.imajin.ai/api/my/listings${qs}`) as Parameters<typeof GET>[0]);
}

function whereSql() {
  return renderSql(dbState.argsOf('where', 'select')[0][0]);
}

beforeEach(() => {
  vi.clearAllMocks();
  dbState.reset();
  mocks.requireSessionOrAppToken.mockResolvedValue({ auth: { did: 'did:imajin:me', scopes: [], via: 'token' } });
});

describe('GET /api/my/listings', () => {
  it('requires authentication', async () => {
    mocks.requireSessionOrAppToken.mockResolvedValue({ error: 'Not authenticated', status: 401 });

    const res = await get();

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Not authenticated' });
    expect(dbState.calls).toHaveLength(0);
  });

  it("returns only the caller's listings, in every status, newest first", async () => {
    dbState.queue([{ id: 'lst_1' }, { id: 'lst_2' }], [{ count: 2 }]);

    const res = await get();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ listings: [{ id: 'lst_1' }, { id: 'lst_2' }], total: 2, page: 1, limit: 20, hasMore: false });
    const { sql, params } = whereSql();
    expect(sql).toContain('"seller_did" = $1');
    expect(sql).not.toContain('"status"');
    expect(params).toEqual(['did:imajin:me']);
    expect(renderSql(dbState.argsOf('orderBy', 'select')[0][0]).sql).toContain('"created_at" desc');
  });

  it('filters by status, sorts and paginates', async () => {
    dbState.queue([{ id: 'lst_3' }], [{ count: 30 }]);

    const body = await (await get('?status=paused&sort=price_asc&page=2&limit=10')).json();

    expect(whereSql().params).toEqual(['did:imajin:me', 'paused']);
    expect(renderSql(dbState.argsOf('orderBy', 'select')[0][0]).sql).toContain('"price" asc');
    expect(dbState.argsOf('offset', 'select')[0]).toEqual([10]);
    expect(body).toMatchObject({ page: 2, limit: 10, total: 30, hasMore: true });
  });

  it('returns 500 when the query fails', async () => {
    dbState.queue(new Error('db down'), [{ count: 0 }]);

    const res = await get();

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to fetch listings' });
  });
});
