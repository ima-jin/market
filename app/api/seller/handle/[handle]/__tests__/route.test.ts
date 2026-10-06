import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ lookupProfile: vi.fn() }));

vi.mock('@/db', async () => (await import('../../../../../../test/helpers/db-mock')).dbModule);
vi.mock('@/lib/kernel/client', () => ({ lookupProfile: mocks.lookupProfile }));

import { dbState, renderSql } from '../../../../../../test/helpers/db-mock';
import { GET } from '../route';

function get(handle: string) {
  return GET(new Request(`https://market.imajin.ai/api/seller/handle/${handle}`) as Parameters<typeof GET>[0], {
    params: Promise.resolve({ handle }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  dbState.reset();
});

describe('GET /api/seller/handle/:handle', () => {
  it('rejects an empty handle', async () => {
    const res = await get('');

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'handle is required' });
  });

  it('returns 404 when the handle is unknown', async () => {
    mocks.lookupProfile.mockResolvedValue({ found: false });

    const res = await get('ghost');

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Seller not found' });
    expect(dbState.calls).toHaveLength(0);
  });

  it('returns 404 when the profile carries no DID', async () => {
    mocks.lookupProfile.mockResolvedValue({ found: true, profile: { handle: 'ann' } });

    expect((await get('ann')).status).toBe(404);
  });

  it("resolves handle -> DID -> the seller's active listings (up to 100), without a settings gate", async () => {
    mocks.lookupProfile.mockResolvedValue({
      found: true,
      profile: { did: 'did:imajin:a', handle: 'ann', displayName: 'Ann' },
    });
    const previews = [{ id: 'lst_1', title: 'Chair' }];
    dbState.queue(previews);

    const res = await get('ann');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      seller: { handle: 'ann', displayName: 'Ann', did: 'did:imajin:a' },
      listings: previews,
      enabled: true,
    });
    expect(mocks.lookupProfile).toHaveBeenCalledWith('ann');
    expect(renderSql(dbState.argsOf('where', 'select')[0][0]).params).toEqual(['did:imajin:a', 'active']);
    expect(dbState.argsOf('limit', 'select')[0]).toEqual([100]);
  });

  it('returns 500 when the profile lookup or query fails', async () => {
    mocks.lookupProfile.mockRejectedValue(new Error('network down'));

    const res = await get('ann');

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to fetch seller listings' });
  });
});
