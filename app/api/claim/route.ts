import { NextResponse, type NextRequest } from 'next/server';
import { AppDidMismatchError, claimWithCode, isAppClaimed } from '@/lib/signing-identity';
import { isRateLimited, recordAttempt, UNKNOWN_CLIENT_KEY } from '@/lib/claim-rate-limit';

/**
 * POST /api/claim — the operator `/claim` page's server-side counterpart
 * (#2427). Takes the claim code an operator pasted from the kernel's `/jin`
 * approval card, redeems it against the kernel's own
 * `POST /api/apps/claim` (via `@ima-jin/auth-client`'s `loadAppSigningKey()`,
 * see `src/lib/signing-identity.ts`'s `claimWithCode()`), and hot-swaps this
 * app's in-memory signing identity — no restart required.
 *
 * The raw signing private key never leaves this server process: only the
 * app DID and public key are returned to the browser. The claim code itself
 * is never logged, on success or failure.
 */
export const dynamic = 'force-dynamic';

const MAX_CLAIM_CODE_LENGTH = 200;

interface ClaimRequestBody {
  claimCode?: unknown;
}

/**
 * Resolves the caller's address to key the rate limiter on. Trusts only the
 * LAST `x-forwarded-for` hop — the one OUR OWN front-door reverse proxy
 * (Caddy) appends — never the first: an attacker controls every hop before
 * the proxy's own, including the first one a naive reader would reach for,
 * and can bypass a per-key limit entirely just by sending a fresh fabricated
 * leading hop on every request.
 *
 * `x-real-ip` is deliberately NOT trusted. Caddy's `reverse_proxy` does not
 * set it by default, so any value that reaches this app is client-supplied
 * and spoofable — keying on it would let an attacker send a fresh fabricated
 * `x-real-ip` on every request and bypass the limit entirely.
 *
 * Falls back to `UNKNOWN_CLIENT_KEY` (its own, separately-capped bucket —
 * see `claim-rate-limit.ts`) when no usable `x-forwarded-for` hop is present.
 */
function clientKeyFor(request: NextRequest): string {
  const forwardedFor = request.headers.get('x-forwarded-for');
  if (forwardedFor) {
    const hops = forwardedFor
      .split(',')
      .map((hop) => hop.trim())
      .filter((hop) => hop.length > 0);
    const lastHop = hops.at(-1);
    if (lastHop) {
      return lastHop;
    }
  }
  return UNKNOWN_CLIENT_KEY;
}

function validateClaimBody(body: ClaimRequestBody): { ok: true; claimCode: string } | { ok: false; error: string } {
  if (typeof body.claimCode !== 'string' || body.claimCode.length === 0) {
    return { ok: false, error: 'Claim code is required' };
  }
  if (body.claimCode.length > MAX_CLAIM_CODE_LENGTH) {
    return { ok: false, error: 'Claim code is too long' };
  }
  return { ok: true, claimCode: body.claimCode };
}

export async function POST(request: NextRequest) {
  if (isAppClaimed()) {
    return NextResponse.json({ error: 'This app has already been claimed' }, { status: 404 });
  }

  const clientKey = clientKeyFor(request);
  if (isRateLimited(clientKey)) {
    return NextResponse.json({ error: 'Too many claim attempts — please try again later' }, { status: 429 });
  }

  let body: ClaimRequestBody;
  try {
    body = (await request.json()) as ClaimRequestBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const validation = validateClaimBody(body);
  if (!validation.ok) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  recordAttempt(clientKey);

  try {
    const identity = await claimWithCode({ claimCode: validation.claimCode });
    return NextResponse.json({ appDid: identity.appDid, publicKey: identity.publicKey });
  } catch (error) {
    if (error instanceof AppDidMismatchError) {
      // Both DIDs are public identifiers, never key material — safe to
      // return and to have logged, though nothing here logs them anyway.
      return NextResponse.json(
        {
          error: 'This claim code was issued for a different app — ask the operator to re-approve with a fresh code',
          expectedAppDid: error.expectedAppDid,
          claimedAppDid: error.claimedAppDid,
        },
        { status: 409 }
      );
    }
    // Deliberately logs only a fixed message — never the claim code, and
    // never the raw kernel error body (which could echo request input).
    console.error(
      'POST /api/claim: claim exchange failed',
      error instanceof Error ? error.message : 'unknown error'
    );
    return NextResponse.json({ error: 'Unable to redeem this claim code' }, { status: 400 });
  }
}
