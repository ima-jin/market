import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_COOKIE_NAME } from '@ima-jin/config';
import { authenticate } from '../authenticate';

const DELEGATE = 'did:imajin:delegate';
const OWNER = 'did:imajin:owner';
const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubEnv('AUTH_SERVICE_URL', 'https://auth.test');
  vi.stubEnv('AUTH_INTERNAL_API_KEY', 'test-only-delegation-transport');
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('published SDK delegation identity baseline (#28)', () => {
  it.each(['token', 'cookie'] as const)('%s keeps the delegate DID even when the owner grant verifies', async (via) => {
    fetchMock
      .mockResolvedValueOnce(Response.json(via === 'token'
        ? { sub: DELEGATE, aud: 'market', scopes: [] }
        : { did: DELEGATE, tier: 'hard' }))
      .mockResolvedValueOnce(Response.json({ allowed: true }));
    const credentials: Record<string, string> = via === 'token'
      ? { Authorization: 'Bearer test-token' }
      : { Cookie: `${SESSION_COOKIE_NAME}=test-session` };

    const result = await authenticate(new Request('https://market.test/api/listings/lst_1', {
      headers: { ...credentials, 'X-Acting-For': OWNER },
    }));

    expect(result).toEqual({ auth: { did: DELEGATE, actingFor: OWNER, scopes: [], via } });
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'https://auth.test/api/internal/verify-delegation', expect.objectContaining({
      body: JSON.stringify({ agentDid: DELEGATE, principalDid: OWNER }),
    }));
    // All existing market ownership checks consume auth.did, not actingFor.
    expect('auth' in result && result.auth.did === OWNER).toBe(false);
  });

  it.each(['token', 'cookie'] as const)('%s returns a countersign proposal after real SDK grant verification', async (via) => {
    fetchMock
      .mockResolvedValueOnce(Response.json(via === 'token'
        ? { sub: DELEGATE, aud: 'market', scopes: [] }
        : { did: DELEGATE, tier: 'hard' }))
      .mockResolvedValueOnce(Response.json({ allowed: true }));
    const headers = new Headers({ 'X-Acting-For': OWNER });
    if (via === 'token') headers.set('Authorization', 'Bearer test-token');
    else headers.set('Cookie', `${SESSION_COOKIE_NAME}=test-session`);

    expect(await authenticate(new Request('https://market.test/api/listings/lst_1', {
      method: 'DELETE', headers,
    }))).toMatchObject({
      status: 403,
      proposal: { code: 'AGENT_APPROVAL_REQUIRED', ownerDid: OWNER, delegateDid: DELEGATE, action: 'delete', class: 'irreversible', resourceId: 'lst_1' },
    });
  });

  it('rejects an unverified owner header instead of surfacing it', async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json({ sub: DELEGATE, aud: 'market', scopes: [] }))
      .mockResolvedValueOnce(Response.json({ allowed: false }));

    expect(await authenticate(new Request('https://market.test/api/listings', {
      headers: { Authorization: 'Bearer test-token', 'X-Acting-For': OWNER },
    }))).toEqual({ error: 'Not authorized to act for this identity', status: 403 });
  });
});
