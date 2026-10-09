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
 * `@ima-jin/auth-client` ships no helper for this mint (its `requestAppToken`
 * is the session-scoped user flow); the Ed25519 signature itself comes from the
 * SDK's `signBootstrapPayload`, no crypto is implemented here.
 *
 * Fails loud: any problem (app unclaimed, kernel unreachable, rejected
 * signature) throws a value-free error; callers decide how to degrade.
 */
import { randomBytes } from 'node:crypto';
import { signBootstrapPayload } from '@ima-jin/auth-client';
import { kernelUrl } from '@/lib/env';
import { getSigningIdentity } from '@/lib/signing-identity';

/** Refresh at 80% of the kernel-reported TTL. */
const REFRESH_RATIO = 0.8;
/** The kernel mints 10-minute tokens; used only if the response omits `expiresIn`. */
const DEFAULT_TTL_SECONDS = 600;
/** The kernel requires a nonce of at least 16 bytes of entropy (32 hex chars). */
const NONCE_BYTES = 16;

interface CachedToken {
  token: string;
  refreshAtMs: number;
}

interface MintResponse {
  token?: unknown;
  expiresIn?: unknown;
  error?: unknown;
}

let cachedToken: CachedToken | null = null;
let inflightMint: Promise<string> | null = null;

function mintUrl(): string {
  const base = kernelUrl();
  if (!base) throw new Error('app-token: IMAJIN_KERNEL_URL is not set');
  return `${base}/auth/api/apps/token/service`;
}

async function mintServiceToken(): Promise<string> {
  const { appDid, privateKey } = getSigningIdentity();
  const nonce = randomBytes(NONCE_BYTES).toString('hex');
  const timestamp = new Date().toISOString();
  const signature = signBootstrapPayload(`${appDid}:${nonce}:${timestamp}`, privateKey);

  let res: Response;
  try {
    res = await fetch(mintUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appDid, nonce, timestamp, signature }),
    });
  } catch (err) {
    throw new Error(`app-token: could not reach the auth service (${err instanceof Error ? err.message : String(err)})`);
  }

  const body = (await res.json().catch(() => null)) as MintResponse | null;
  if (!res.ok) {
    const reason = typeof body?.error === 'string' ? body.error : `status ${res.status}`;
    throw new Error(`app-token: service token mint failed (${reason})`);
  }
  if (typeof body?.token !== 'string' || body.token.length === 0) {
    throw new TypeError('app-token: service token mint response was malformed');
  }

  const ttlSeconds = typeof body.expiresIn === 'number' && body.expiresIn > 0 ? body.expiresIn : DEFAULT_TTL_SECONDS;
  cachedToken = { token: body.token, refreshAtMs: Date.now() + ttlSeconds * REFRESH_RATIO * 1000 };
  return body.token;
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

/** Drop the cached token. Used by tests. */
export function resetAppServiceTokenCache(): void {
  cachedToken = null;
  inflightMint = null;
}
