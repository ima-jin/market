import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ requireSessionOrAppToken: vi.fn() }));

vi.mock('@/db', async () => (await import('../../../../../test/helpers/db-mock')).dbModule);
vi.mock('@ima-jin/auth', () => ({ requireSessionOrAppToken: mocks.requireSessionOrAppToken }));

import { dbState } from '../../../../../test/helpers/db-mock';
import { GET, PATCH } from '../route';

const DID = 'did:imajin:seller';

function get() {
  return GET(new Request('https://market.imajin.ai/api/seller/settings') as Parameters<typeof GET>[0]);
}

function patch(body: unknown) {
  return PATCH(
    new Request('https://market.imajin.ai/api/seller/settings', {
      method: 'PATCH',
      body: JSON.stringify(body),
    }) as Parameters<typeof PATCH>[0]
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  dbState.reset();
  mocks.requireSessionOrAppToken.mockResolvedValue({ auth: { did: DID, scopes: [], via: 'token' } });
});

describe('GET /api/seller/settings', () => {
  it('requires authentication', async () => {
    mocks.requireSessionOrAppToken.mockResolvedValue({ error: 'Not authenticated', status: 401 });

    const res = await get();

    expect(res.status).toBe(401);
    expect(dbState.calls).toHaveLength(0);
  });

  it('returns the existing settings', async () => {
    dbState.queue([{ did: DID, showMarketItems: true }]);

    const res = await get();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ showMarketItems: true });
    expect(dbState.argsOf('values', 'insert')).toHaveLength(0);
  });

  it('creates a default (hidden) row when none exists', async () => {
    dbState.queue([], [{ did: DID, showMarketItems: false }]);

    const res = await get();

    expect(await res.json()).toEqual({ showMarketItems: false });
    expect(dbState.argsOf('values', 'insert')[0][0]).toEqual({ did: DID, showMarketItems: false });
  });

  it('returns 500 when the query fails', async () => {
    dbState.queue(new Error('db down'));

    const res = await get();

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to fetch settings' });
  });
});

describe('PATCH /api/seller/settings', () => {
  it('requires authentication', async () => {
    mocks.requireSessionOrAppToken.mockResolvedValue({ error: 'Not authenticated', status: 401 });

    expect((await patch({ showMarketItems: true })).status).toBe(401);
  });

  it.each([[{}], [{ showMarketItems: 'yes' }], [{ showMarketItems: 1 }], [{ showMarketItems: null }]])(
    'rejects a non-boolean showMarketItems (%j)',
    async (body) => {
      const res = await patch(body);

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'showMarketItems must be a boolean' });
      expect(dbState.calls).toHaveLength(0);
    }
  );

  it('upserts the caller’s settings keyed by DID', async () => {
    dbState.queue([{ did: DID, showMarketItems: true }]);

    const res = await patch({ showMarketItems: true });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ showMarketItems: true });
    expect(dbState.argsOf('values', 'insert')[0][0]).toMatchObject({ did: DID, showMarketItems: true });
    const conflict = dbState.argsOf('onConflictDoUpdate', 'insert')[0][0] as { set: Record<string, unknown> };
    expect(conflict.set.showMarketItems).toBe(true);
    expect(conflict.set.updatedAt).toBeInstanceOf(Date);
  });

  it('accepts false as a valid value', async () => {
    dbState.queue([{ did: DID, showMarketItems: false }]);

    expect(await (await patch({ showMarketItems: false })).json()).toEqual({ showMarketItems: false });
  });

  it('returns 500 when the upsert fails', async () => {
    dbState.queue(new Error('db down'));

    const res = await patch({ showMarketItems: true });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to update settings' });
  });
});
