import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { readKeystoreMock, cookieGetMock } = vi.hoisted(() => ({
  readKeystoreMock: vi.fn(() => ({})),
  cookieGetMock: vi.fn(),
}));

vi.mock('@ima-jin/auth-client', async (importOriginal) => ({
  ...await importOriginal<typeof import('@ima-jin/auth-client')>(),
  readKeystore: readKeystoreMock,
  resolveKeystorePath: () => '/unused-test-keystore',
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: cookieGetMock }),
}));

// No vault, keystore, or real credentials: only an in-memory test fixture.
vi.mock('@/lib/self-secrets', () => ({
  getSessionSecret: () => 'non-secret-test-fixture-for-session-roundtrip',
}));

function appRequest(path: string, cookie?: string): NextRequest {
  return new NextRequest(new URL(path, 'https://app.example'), {
    nextConfig: { basePath: '/market' },
    headers: cookie ? { cookie } : undefined,
  });
}

describe('standalone callback route — session round trip (#23)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_BASE_PATH', '/market');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.example/market');
    vi.stubEnv('IMAJIN_AUTH_URL', 'https://kernel.example');
    readKeystoreMock.mockReturnValue({});
    cookieGetMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('forwards to the existing callback, sets a readable session, and lands without another login redirect', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({
      did: 'did:imajin:test',
      displayName: 'Test operator',
      handle: 'test-operator',
    }));
    vi.stubGlobal('fetch', fetchMock);
    const { middleware } = await import('../middleware');
    const { GET: callback } = await import('../app/api/auth/callback/route');
    const { GET: session } = await import('../app/api/auth/session/route');
    const root = appRequest('/market?attestation_id=test-attestation&user_did=did%3Aimajin%3Atest');

    const forwarded = middleware(root);
    expect(forwarded.status).toBe(307);
    const callbackUrl = forwarded.headers.get('location')!;
    expect(new URL(callbackUrl).pathname).toBe('/market/api/auth/callback');
    const callbackRequest = appRequest(callbackUrl);
    expect(middleware(callbackRequest).headers.get('x-middleware-next')).toBe('1');
    const response = await callback(callbackRequest);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://kernel.example/profile/api/profile/did%3Aimajin%3Atest',
      expect.objectContaining({ headers: { 'Content-Type': 'application/json' } }),
    );
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://app.example/market/');
    const cookie = response.cookies.get('imajin_session');
    expect(cookie).toBeDefined();
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/' });
    expect(cookie!.maxAge).toBeGreaterThan(0);
    cookieGetMock.mockReturnValue({ value: cookie!.value });
    const sessionResponse = await session();
    expect(await sessionResponse.json()).toMatchObject({
      did: 'did:imajin:test',
      attestationId: 'test-attestation',
    });
    expect(cookieGetMock).toHaveBeenCalledWith('imajin_session');

    const landing = middleware(appRequest(response.headers.get('location')!, `imajin_session=${cookie!.value}`));
    expect(landing.headers.get('x-middleware-next')).toBe('1');
    expect(landing.headers.get('location')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps missing-parameter errors under the basePath without setting a session', async () => {
    const { GET } = await import('../app/api/auth/callback/route');
    const response = await GET(appRequest('/market/api/auth/callback?attestation_id=test-attestation'));

    expect(response.headers.get('location')).toBe('https://app.example/market/?auth_error=missing_params');
    expect(response.cookies.get('imajin_session')).toBeUndefined();
  });
});
