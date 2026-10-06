import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_COOKIE_NAME } from '@ima-jin/config';
import { fetchNodeSelf, isHardIdentity, lookupProfile } from '../client';
import { emitEvent } from '../events';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('IMAJIN_KERNEL_URL', 'https://jin.test');
  vi.stubEnv('AUTH_SERVICE_URL', 'https://jin.test/auth');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), { status: 200, ...init });
}

describe('lookupProfile', () => {
  it("calls the kernel's public profile route with an encoded identifier", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ did: 'did:imajin:a', handle: 'ann', displayName: 'Ann' }));

    const result = await lookupProfile('did:imajin:a');

    expect(fetchMock.mock.calls[0][0]).toBe('https://jin.test/profile/api/profile/did%3Aimajin%3Aa');
    expect(result).toEqual({ found: true, profile: { did: 'did:imajin:a', handle: 'ann', displayName: 'Ann' } });
  });

  it('reports not-found on a non-2xx response', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 404 }));
    expect(await lookupProfile('ghost')).toEqual({ found: false });
  });

  it('throws when the kernel URL is not configured', async () => {
    vi.stubEnv('IMAJIN_KERNEL_URL', '');
    await expect(lookupProfile('x')).rejects.toThrow(/IMAJIN_KERNEL_URL/);
  });

  it('propagates network failures so callers can map them to a 500', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    await expect(lookupProfile('x')).rejects.toThrow('network down');
  });
});

describe('fetchNodeSelf', () => {
  it('returns the registry node/self payload', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ nodeFeeBps: 100, buyerCreditBps: 50, nodeOperatorDid: 'did:imajin:op' }));

    expect(await fetchNodeSelf()).toEqual({ nodeFeeBps: 100, buyerCreditBps: 50, nodeOperatorDid: 'did:imajin:op' });
    expect(fetchMock.mock.calls[0][0]).toBe('https://jin.test/registry/api/node/self');
  });

  it('returns null on non-2xx, network failure, or missing kernel URL', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 503 }));
    expect(await fetchNodeSelf()).toBeNull();

    fetchMock.mockRejectedValueOnce(new Error('boom'));
    expect(await fetchNodeSelf()).toBeNull();

    vi.stubEnv('IMAJIN_KERNEL_URL', '');
    expect(await fetchNodeSelf()).toBeNull();
  });
});

describe('isHardIdentity', () => {
  const cookieAuth = { did: 'did:imajin:a', scopes: [], via: 'cookie' as const };
  const cookieRequest = () =>
    new Request('https://market.test/x', { headers: { cookie: `other=1; ${SESSION_COOKIE_NAME}=tok123` } });

  it('fails closed for app-token callers (no tier claim)', async () => {
    const hard = await isHardIdentity(cookieRequest(), { ...cookieAuth, via: 'token' });
    expect(hard).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed without a session cookie or auth service URL', async () => {
    expect(await isHardIdentity(new Request('https://market.test/x'), cookieAuth)).toBe(false);

    vi.stubEnv('AUTH_SERVICE_URL', '');
    expect(await isHardIdentity(cookieRequest(), cookieAuth)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards only the session cookie to the kernel session endpoint', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ did: 'did:imajin:a', tier: 'hard' }));

    expect(await isHardIdentity(cookieRequest(), cookieAuth)).toBe(true);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://jin.test/auth/api/session');
    expect(init.headers).toEqual({ Cookie: `${SESSION_COOKIE_NAME}=tok123` });
  });

  it('rejects soft identities but treats a missing tier as hard (kernel back-compat)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ tier: 'soft' }));
    expect(await isHardIdentity(cookieRequest(), cookieAuth)).toBe(false);

    fetchMock.mockResolvedValueOnce(jsonResponse({}));
    expect(await isHardIdentity(cookieRequest(), cookieAuth)).toBe(true);
  });

  it('fails closed on a non-2xx response or a network error', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 401 }));
    expect(await isHardIdentity(cookieRequest(), cookieAuth)).toBe(false);

    fetchMock.mockRejectedValueOnce(new Error('boom'));
    expect(await isHardIdentity(cookieRequest(), cookieAuth)).toBe(false);
  });
});

describe('emitEvent', () => {
  it('always resolves (fire-and-forget) while the kernel event route is a known gap', async () => {
    await expect(
      emitEvent('listing.created', { issuer: 'did:imajin:a', subject: 'did:imajin:a', scope: 'market', payload: {} })
    ).resolves.toBeUndefined();
  });
});
