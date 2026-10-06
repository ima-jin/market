import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ requireSessionOrAppToken: vi.fn() }));

vi.mock('@ima-jin/auth', () => ({ requireSessionOrAppToken: mocks.requireSessionOrAppToken }));

import { GET } from '../route';

function get() {
  return GET(new Request('https://market.imajin.ai/api/me') as Parameters<typeof GET>[0]);
}

describe('GET /api/me', () => {
  beforeEach(() => {
    mocks.requireSessionOrAppToken.mockReset();
  });

  it('returns did: null (200) when the caller is not authenticated', async () => {
    mocks.requireSessionOrAppToken.mockResolvedValue({ error: 'Not authenticated', status: 401 });

    const res = await get();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ did: null });
  });

  it("returns the caller's DID for a scoped app token", async () => {
    mocks.requireSessionOrAppToken.mockResolvedValue({
      auth: { did: 'did:imajin:abc123', scopes: [], via: 'token' },
    });

    const res = await get();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ did: 'did:imajin:abc123', scopeLabel: null });
  });

  it('also accepts the session-cookie fallback', async () => {
    mocks.requireSessionOrAppToken.mockResolvedValue({
      auth: { did: 'did:imajin:abc123', scopes: [], via: 'cookie' },
    });

    expect(await (await get()).json()).toEqual({ did: 'did:imajin:abc123', scopeLabel: null });
  });
});
