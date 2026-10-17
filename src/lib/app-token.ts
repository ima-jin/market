/**
 * Market's own app-service token (#2740, kernel #2642).
 *
 * `POST /pay/api/settle` no longer accepts a shared pay service key; a
 * registered app authenticates as itself with an app-service token
 * (`typ: app-service+jwt`) carrying the operator-approved `pay:settle` scope.
 * The same token authenticates market's `/pay/api/checkout` call, which is
 * what binds the payment to market's app DID.
 *
 * The token is minted via `POST {IMAJIN_KERNEL_URL}/auth/api/apps/token/service`
 * with proof of possession of the app's signing key (a signature over
 * `${appDid}:${nonce}:${timestamp}`). The key is the one `bootstrapSigningIdentity()`
 * / `claimWithCode()` hold in memory (`src/lib/signing-identity.ts`) — never
 * written to disk, env or a log line — and the token is cached until 80% of
 * its TTL.
 *
 * The published `@ima-jin/auth-client`'s `requestAppServiceToken` performs the
 * proof-of-possession mint. Its default audience is `imajin:apps`, also accepted
 * by the kernel's `/api/events`; no user session or delegated token is used.
 *
 * Fails loud: any problem (app unclaimed, kernel unreachable, rejected
 * signature) throws a value-free error; callers decide how to degrade.
 */
import { requestAppServiceToken } from '@ima-jin/auth-client';
import { kernelUrl } from '@/lib/env';
import { getSigningIdentity } from '@/lib/signing-identity';

/** Refresh at 80% of the kernel-reported TTL. */
const REFRESH_RATIO = 0.8;

interface CachedToken {
  token: string;
  refreshAtMs: number;
}

let cachedToken: CachedToken | null = null;
let inflightMint: Promise<string> | null = null;

function mintBaseUrl(): string {
  const base = kernelUrl();
  if (!base) throw new Error('app-token: IMAJIN_KERNEL_URL is not set');
  return base;
}

async function mintServiceToken(): Promise<string> {
  const base = mintBaseUrl();
  const { appDid, privateKey } = getSigningIdentity();
  const minted = await requestAppServiceToken({
    kernelUrl: base,
    appDid,
    privateKey,
    fetchOptions: { signal: AbortSignal.timeout(5000) },
  });
  cachedToken = { token: minted.token, refreshAtMs: Date.now() + minted.expiresIn * REFRESH_RATIO * 1000 };
  return minted.token;
}

/** The app-service token to send as `Authorization: Bearer`. Mints on first use and refreshes before expiry. */
export async function getAppServiceToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.refreshAtMs) return cachedToken.token;
  // Coalesce concurrent callers onto a single mint.
  inflightMint ??= mintServiceToken().finally(() => {
    inflightMint = null;
  });
  return inflightMint;
}

/** Drop the cached token after a 401; the next call mints again. Also used by tests. */
export function resetAppServiceTokenCache(): void {
  cachedToken = null;
  inflightMint = null;
}
