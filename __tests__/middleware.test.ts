import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const { readKeystoreMock, resolveKeystorePathMock } = vi.hoisted(() => ({
  readKeystoreMock: vi.fn(),
  resolveKeystorePathMock: vi.fn(() => '/tmp/keystore.json'),
}));

vi.mock('@ima-jin/auth-client', () => ({
  readKeystore: readKeystoreMock,
  resolveKeystorePath: resolveKeystorePathMock,
}));

/** Runs the middleware for `path` with the given claim state, mocking only the on-disk keystore check. */
async function middlewareFor(path: string, options: { claimed: boolean }): Promise<NextResponse> {
  readKeystoreMock.mockReturnValue(options.claimed ? { publicKey: 'pub', privateKey: 'priv' } : null);
  const { middleware } = await import('../middleware');
  return middleware(new NextRequest(new URL(path, 'http://localhost:3000')));
}

describe('middleware — claim gate (#2427)', () => {
  afterEach(() => {
    readKeystoreMock.mockReset();
    resolveKeystorePathMock.mockClear();
  });

  it('serves the "not claimed yet" page for an ordinary route when unclaimed', async () => {
    const response = await middlewareFor('/', { claimed: false });

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text.toLowerCase()).toContain('not claimed yet');
  });

  it('passes /claim through when unclaimed', async () => {
    const response = await middlewareFor('/claim', { claimed: false });

    expect(response.headers.get('x-middleware-next')).toBe('1');
  });

  it('passes /api/health and /api/claim through when unclaimed', async () => {
    expect((await middlewareFor('/api/health', { claimed: false })).headers.get('x-middleware-next')).toBe('1');
    expect((await middlewareFor('/api/claim', { claimed: false })).headers.get('x-middleware-next')).toBe('1');
  });

  it('404s /claim once claimed', async () => {
    const response = await middlewareFor('/claim', { claimed: true });

    expect(response.status).toBe(404);
  });

  it('404s /api/claim once claimed', async () => {
    const response = await middlewareFor('/api/claim', { claimed: true });

    expect(response.status).toBe(404);
  });

  it('passes ordinary routes through once claimed', async () => {
    const response = await middlewareFor('/', { claimed: true });

    expect(response.headers.get('x-middleware-next')).toBe('1');
  });

  it('gates /dashboard and /api/listings behind the claim while unclaimed', async () => {
    expect((await middlewareFor('/dashboard', { claimed: false })).status).toBe(200);
    expect((await (await middlewareFor('/api/listings', { claimed: false })).text()).toLowerCase()).toContain(
      'not claimed yet'
    );
  });
});

describe('middleware — standalone dashboard redirect + CORS (#2332), claimed app', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_SERVICE_PREFIX', 'jin.imajin.ai/');
    vi.stubEnv('NEXT_PUBLIC_DOMAIN', '');
    vi.stubEnv('NEXT_PUBLIC_KERNEL_URL', '');
    readKeystoreMock.mockReturnValue({ publicKey: 'pub', privateKey: 'priv' });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    readKeystoreMock.mockReset();
  });

  async function run(url: string, init?: ConstructorParameters<typeof NextRequest>[1]): Promise<NextResponse> {
    const { middleware } = await import('../middleware');
    return middleware(new NextRequest(url, init));
  }

  it('308-redirects the standalone /dashboard route to its hub tab, preserving the query string', async () => {
    const res = await run('https://market.imajin.ai/dashboard?foo=bar');

    expect(res.status).toBe(308);
    expect(res.headers.get('location')).toBe('https://jin.imajin.ai/auth/market?foo=bar');
  });

  it('does not redirect the hub embed route (`?embed=hub`)', async () => {
    const res = await run('https://market.imajin.ai/dashboard?embed=hub&did=did:imajin:x');

    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
    expect(res.headers.get('x-middleware-next')).toBe('1');
  });

  it('runs on every route, including the bare basePath root', async () => {
    const { config } = await import('../middleware');

    expect(config.matcher).toContain('/');
    expect(config.matcher).toContain('/((?!_next/static|_next/image|favicon.ico).*)');
  });

  it('answers an API preflight with 204 and CORS headers', async () => {
    const res = await run('https://market.imajin.ai/api/listings', {
      method: 'OPTIONS',
      headers: { origin: 'https://jin.imajin.ai' },
    });

    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true');
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
  });

  it('passes ordinary API requests through with CORS headers attached', async () => {
    const res = await run('https://market.imajin.ai/api/listings', { headers: { origin: 'https://evil.example' } });

    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('');
    expect(res.headers.get('Vary')).toBe('Origin');
  });

  it('leaves non-API pages untouched', async () => {
    const res = await run('https://market.imajin.ai/listings/abc');

    expect(res.headers.get('x-middleware-next')).toBe('1');
    expect(res.headers.get('Vary')).toBeNull();
  });
});
