import { SESSION_COOKIE_NAME } from '@ima-jin/config';
import { createLogger } from '@ima-jin/logger';
import { kernelUrl } from '@/lib/env';
import type { AuthenticatedCaller } from '@/lib/auth/authenticate';

const log = createLogger('market');

/**
 * Everything this app asks of the kernel goes through the kernel's public
 * HTTP surface (`IMAJIN_KERNEL_URL`) — never a kernel database or an
 * internal package (AGENTS.md §2).
 */

export interface KernelProfile {
  did?: string;
  handle?: string;
  displayName?: string;
}

export type ProfileLookup =
  | { found: true; profile: KernelProfile }
  | { found: false };

/**
 * Looks up a profile by DID or handle via the kernel profile service's
 * public `GET /profile/api/profile/{didOrHandle}` route. A non-2xx response
 * is `{ found: false }`; a network failure or an unconfigured kernel URL
 * throws so callers can map it to a 500, exactly like the original app.
 */
export async function lookupProfile(didOrHandle: string): Promise<ProfileLookup> {
  const base = kernelUrl();
  if (!base) {
    throw new Error('IMAJIN_KERNEL_URL is not set — see .env.example.');
  }
  const res = await fetch(`${base}/profile/api/profile/${encodeURIComponent(didOrHandle)}`, {
    cache: 'no-store',
  });
  if (!res.ok) {
    return { found: false };
  }
  return { found: true, profile: (await res.json()) as KernelProfile };
}

export interface NodeSelfInfo {
  nodeFeeBps?: number | null;
  buyerCreditBps?: number | null;
  nodeOperatorDid?: string | null;
}

/**
 * This node's fee configuration from the kernel registry's public
 * `GET /registry/api/node/self`. Best effort: `null` when unavailable, in
 * which case `.fair` manifest defaults apply.
 */
export async function fetchNodeSelf(): Promise<NodeSelfInfo | null> {
  const base = kernelUrl();
  if (!base) return null;
  try {
    const res = await fetch(`${base}/registry/api/node/self`, { cache: 'no-store' });
    if (!res.ok) {
      log.warn({ status: res.status }, 'node/self returned non-2xx — using .fair defaults');
      return null;
    }
    return (await res.json()) as NodeSelfInfo;
  } catch (err) {
    log.warn({ err: String(err) }, 'node/self fetch failed — using .fair defaults');
    return null;
  }
}

function extractSessionCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    if (trimmed.startsWith(`${SESSION_COOKIE_NAME}=`)) {
      return trimmed.slice(SESSION_COOKIE_NAME.length + 1) || null;
    }
  }
  return null;
}

/**
 * Whether the caller holds a "hard" (keypair-based) identity, as opposed to
 * a soft email-only one. `requireSessionOrAppToken` does not expose the
 * identity tier (ima-jin/imajin-ai#2640), so this asks the kernel's public
 * session endpoint directly. Fails closed:
 *  - scoped app-token callers carry no tier claim, so they are not hard;
 *  - any lookup failure is not hard.
 */
export async function isHardIdentity(request: Request, auth: AuthenticatedCaller): Promise<boolean> {
  if (auth.via !== 'cookie') return false;

  const authUrl = process.env.AUTH_SERVICE_URL;
  const sessionToken = extractSessionCookie(request.headers.get('cookie'));
  if (!authUrl || !sessionToken) return false;

  try {
    const res = await fetch(`${authUrl}/api/session`, {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${sessionToken}` },
      cache: 'no-store',
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { tier?: string };
    // Matches the kernel: a missing tier is treated as hard (back-compat).
    return (data.tier ?? 'hard') !== 'soft';
  } catch (err) {
    log.error({ err: String(err) }, 'Identity tier lookup failed');
    return false;
  }
}
