import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { config, middleware } from '../middleware';

describe('market middleware — standalone dashboard redirect (#2332)', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_SERVICE_PREFIX', 'jin.imajin.ai/');
    vi.stubEnv('NEXT_PUBLIC_DOMAIN', '');
    vi.stubEnv('NEXT_PUBLIC_KERNEL_URL', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('308-redirects the standalone /dashboard route to its hub tab, preserving the query string', () => {
    const res = middleware(new NextRequest('https://market.imajin.ai/dashboard?foo=bar'));

    expect(res.status).toBe(308);
    expect(res.headers.get('location')).toBe('https://jin.imajin.ai/auth/market?foo=bar');
  });

  it('excludes the embed route (`?embed=hub`) from the redirect matcher', () => {
    const dashboardMatcher = (config.matcher as Array<string | { source: string; missing?: unknown }>).find(
      (m): m is { source: string; missing?: unknown } => typeof m === 'object' && m.source === '/dashboard'
    );

    expect(dashboardMatcher?.missing).toEqual([{ type: 'query', key: 'embed' }]);
  });

  it('runs on every API route', () => {
    expect(config.matcher).toContain('/api/:path*');
  });

  it('answers an API preflight with 204 and CORS headers', () => {
    const res = middleware(
      new NextRequest('https://market.imajin.ai/api/listings', {
        method: 'OPTIONS',
        headers: { origin: 'https://jin.imajin.ai' },
      })
    );

    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true');
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
  });

  it('passes ordinary API requests through with CORS headers attached', () => {
    const res = middleware(
      new NextRequest('https://market.imajin.ai/api/listings', { headers: { origin: 'https://evil.example' } })
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('');
    expect(res.headers.get('Vary')).toBe('Origin');
  });
});
