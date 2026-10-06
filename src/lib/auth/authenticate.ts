import { requireSessionOrAppToken } from '@ima-jin/auth';
import { thisAppHost } from '@/lib/env';

/**
 * This app's entire inbound-auth surface, deliberately funneled through one
 * function. Every route calls `authenticate(request)` and nothing else — no
 * route imports `@ima-jin/auth`'s `requireSessionOrAppToken` (or any other
 * auth primitive) directly. Same shape as `ima-jin/links` and `ima-jin/dykil`
 * (#1974 reference adoption of the #1069 Phase 1 scoped app-token), so a
 * future change to the mechanism is a one-file change.
 *
 * `requireSessionOrAppToken` accepts EITHER a scoped
 * `Authorization: Bearer <app-token>` (audience = this app's host) OR the
 * shared kernel session cookie as a fallback.
 */
export interface AuthenticatedCaller {
  /** DID of the authenticated caller. */
  did: string;
  /** Capability scopes granted to this call (empty on the cookie fallback path). */
  scopes: string[];
  /** Which path authenticated this request — surfaced for logging/debugging only. */
  via: 'token' | 'cookie';
}

export type AuthenticateSuccess = { auth: AuthenticatedCaller };
export type AuthenticateFailure = { error: string; status: number };
export type AuthenticateResult = AuthenticateSuccess | AuthenticateFailure;

export interface AuthenticateOptions {
  requireScopes?: string[];
}

export async function authenticate(
  request: Request,
  options?: AuthenticateOptions
): Promise<AuthenticateResult> {
  const result = await requireSessionOrAppToken(request, {
    aud: thisAppHost(),
    requireScopes: options?.requireScopes,
  });
  if ('error' in result) {
    return { error: result.error, status: result.status };
  }
  return { auth: result.auth };
}

/**
 * Optional authentication: resolves the caller if the request carries valid
 * credentials, otherwise `null` (anonymous). Never fails the request — used
 * by public read routes that only vary their output for signed-in callers.
 */
export async function authenticateOptional(request: Request): Promise<AuthenticatedCaller | null> {
  const result = await authenticate(request);
  return 'auth' in result ? result.auth : null;
}
