import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ lookupProfile: vi.fn() }));

vi.mock('@/lib/kernel/client', () => ({ lookupProfile: mocks.lookupProfile }));

import { GET } from '../route';

function get(did: string) {
  return GET(new Request(`https://market.imajin.ai/api/resolve/${did}`) as Parameters<typeof GET>[0], {
    params: Promise.resolve({ did }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/resolve/:did', () => {
  it('rejects an empty DID', async () => {
    const res = await get('');

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'did is required' });
    expect(mocks.lookupProfile).not.toHaveBeenCalled();
  });

  it('proxies the kernel profile, exposing only did/handle/displayName', async () => {
    mocks.lookupProfile.mockResolvedValue({
      found: true,
      profile: { did: 'did:imajin:a', handle: 'ann', displayName: 'Ann', email: 'secret@example.com' },
    });

    const res = await get('did:imajin:a');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ did: 'did:imajin:a', handle: 'ann', displayName: 'Ann' });
    expect(mocks.lookupProfile).toHaveBeenCalledWith('did:imajin:a');
  });

  it('returns 404 when the kernel does not know the identity', async () => {
    mocks.lookupProfile.mockResolvedValue({ found: false });

    const res = await get('did:imajin:ghost');

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Identity not found' });
  });

  it('returns 500 when the lookup fails', async () => {
    mocks.lookupProfile.mockRejectedValue(new Error('network down'));

    const res = await get('did:imajin:a');

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to resolve identity' });
  });
});
