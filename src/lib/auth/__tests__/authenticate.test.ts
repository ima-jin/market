import { beforeEach, describe, expect, it, vi } from 'vitest';

const { requireSessionOrAppTokenMock } = vi.hoisted(() => ({ requireSessionOrAppTokenMock: vi.fn() }));

vi.mock('@ima-jin/auth', () => ({
  requireSessionOrAppToken: requireSessionOrAppTokenMock,
}));

import { authenticate, authenticateOptional } from '../authenticate';

describe('authenticate', () => {
  beforeEach(() => {
    requireSessionOrAppTokenMock.mockReset();
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://market.imajin.ai');
  });

  it("scopes the token audience to this app's own host (#1974 pattern)", async () => {
    requireSessionOrAppTokenMock.mockResolvedValue({ auth: { did: 'did:imajin:owner', scopes: [], via: 'token' } });

    const request = new Request('https://market.imajin.ai/api/listings');
    const result = await authenticate(request);

    expect(requireSessionOrAppTokenMock).toHaveBeenCalledWith(request, {
      aud: 'market.imajin.ai',
      requireScopes: undefined,
    });
    expect('auth' in result && result.auth).toEqual({ did: 'did:imajin:owner', scopes: [], via: 'token' });
  });

  it('forwards a failure as { error, status }', async () => {
    requireSessionOrAppTokenMock.mockResolvedValue({ error: 'Not authenticated', status: 401 });

    const result = await authenticate(new Request('https://market.imajin.ai/api/listings'));

    expect(result).toEqual({ error: 'Not authenticated', status: 401 });
  });

  it('forwards requireScopes to the underlying check', async () => {
    requireSessionOrAppTokenMock.mockResolvedValue({ error: 'Missing required scope(s): market:write', status: 403 });

    const result = await authenticate(new Request('https://market.imajin.ai/api/listings'), {
      requireScopes: ['market:write'],
    });

    expect(requireSessionOrAppTokenMock).toHaveBeenCalledWith(expect.anything(), {
      aud: 'market.imajin.ai',
      requireScopes: ['market:write'],
    });
    expect(result).toEqual({ error: 'Missing required scope(s): market:write', status: 403 });
  });
});

describe('authenticateOptional', () => {
  beforeEach(() => {
    requireSessionOrAppTokenMock.mockReset();
  });

  it('returns the caller when credentials are valid', async () => {
    requireSessionOrAppTokenMock.mockResolvedValue({ auth: { did: 'did:imajin:a', scopes: ['x'], via: 'cookie' } });

    const caller = await authenticateOptional(new Request('https://market.imajin.ai/api/me'));

    expect(caller).toEqual({ did: 'did:imajin:a', scopes: ['x'], via: 'cookie' });
  });

  it('returns null (anonymous) instead of failing when credentials are missing or invalid', async () => {
    requireSessionOrAppTokenMock.mockResolvedValue({ error: 'Invalid or expired session', status: 401 });

    expect(await authenticateOptional(new Request('https://market.imajin.ai/api/me'))).toBeNull();
  });
});
