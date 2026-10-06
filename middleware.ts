import { NextResponse, type NextRequest } from 'next/server';
import { standaloneDashboardMiddleware } from '@ima-jin/config';
import { readKeystore, resolveKeystorePath } from '@ima-jin/auth-client';
import { withBasePath } from '@/lib/base-path';

/**
 * Gates every route on this app's claim state (#2427). Runs on the Node.js
 * middleware runtime (stable since Next.js 15.5) because it needs
 * `node:fs` to check for the bootstrap keystore — the same file
 * `@ima-jin/auth-client`'s `loadAppSigningKey()` writes on a successful
 * claim exchange (see `src/lib/signing-identity.ts`).
 *
 * Deliberately does NOT import `src/lib/signing-identity.ts`'s in-memory
 * `isAppClaimed()`: Next.js compiles middleware as its own bundle, isolated
 * from the rest of the server (see the "you should not attempt relying on
 * shared modules or globals" note in Next's own middleware docs), so an
 * in-memory flag set by `app/api/claim/route.ts` cannot be trusted to be
 * visible here. The keystore file on disk is the one source of truth both
 * sides can read — and it's written synchronously, before that route ever
 * responds to the browser, so there is no race.
 */
export const config = {
  runtime: 'nodejs',
  // Two patterns, not one: with a non-empty `basePath` configured (see
  // next.config.js), Next's compiled matcher wraps the catch-all capture
  // group in a mandatory leading `/`, so the bare basePath root (no
  // trailing path segment, e.g. `/dykil` with no trailing slash) fails to
  // match `'/((?!…).*)'` alone and middleware silently never runs for it.
  // `'/'` covers exactly that root; the catch-all covers everything else.
  matcher: ['/', '/((?!_next/static|_next/image|favicon.ico).*)'],
};

/** Routes servable before this app has been claimed. Every other route gets the "not claimed yet" page. */
const ALLOWED_WHEN_UNCLAIMED = new Set(['/claim', '/api/claim', '/api/health']);

/** Routes that stop existing once this app has been claimed — the claim code is single-use. */
const GATED_AFTER_CLAIM = new Set(['/claim', '/api/claim']);

function hasKeystore(): boolean {
  const keystorePath = resolveKeystorePath(process.env.IMAJIN_APP_KEYSTORE);
  return readKeystore(keystorePath) !== null;
}

function htmlResponse(status: number, title: string, message: string): NextResponse {
  const body = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
  </head>
  <body style="font-family: system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1rem; color: #1f2937;">
    <h1>${title}</h1>
    <p>${message}</p>
  </body>
</html>`;
  return new NextResponse(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

function isHubEmbed(request: NextRequest): boolean {
  return request.nextUrl.searchParams.has('embed');
}

/** Routes the standalone dashboard/CORS middleware owns: every `/api/*` route and the bare `/dashboard`. */
function needsStandaloneHandling(request: NextRequest): boolean {
  const { pathname } = request.nextUrl;
  if (pathname === '/dashboard') {
    return !isHubEmbed(request);
  }
  return pathname.startsWith('/api/');
}

export function middleware(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  const claimed = hasKeystore();

  if (claimed && GATED_AFTER_CLAIM.has(pathname)) {
    return htmlResponse(404, 'Not found', 'This page could not be found.');
  }

  if (!claimed && !ALLOWED_WHEN_UNCLAIMED.has(pathname)) {
    // Built from this app's own NEXT_PUBLIC_BASE_PATH config (`withBasePath`,
    // shared with `app/claim/page.tsx`) rather than `request.nextUrl` —
    // config, never request input, ever ends up in this HTML string.
    const claimUrl = withBasePath('/claim');
    return htmlResponse(
      200,
      'Not claimed yet',
      `This app has not been claimed yet. An operator needs to open <a href="${claimUrl}">${claimUrl}</a> ` +
        `and paste the claim code from the kernel operator's /jin approval card.`
    );
  }

  if (needsStandaloneHandling(request)) {
    return standaloneDashboardMiddleware(request, { service: 'market' });
  }

  return NextResponse.next();
}
