import { NextRequest, NextResponse } from 'next/server';
import { standaloneDashboardMiddleware } from '@ima-jin/config';

/**
 * Standalone `/dashboard` -> kernel hub tab redirect, plus `/api/:path*` CORS
 * pass-through (ima-jin/imajin-ai#2332, #1525). The body lives in the published
 * `@ima-jin/config`'s `standaloneDashboardMiddleware`; the `matcher` below must
 * stay a literal in this file because Next.js statically analyses it.
 */
export function middleware(request: NextRequest): NextResponse {
  return standaloneDashboardMiddleware(request, { service: 'market' });
}

export const config = {
  matcher: [
    '/api/:path*',
    // Only fires when `embed` is absent, so the hub's iframe load
    // (`/dashboard?embed=hub&did=...`) never gets redirected (#2332).
    { source: '/dashboard', missing: [{ type: 'query', key: 'embed' }] },
  ],
};
