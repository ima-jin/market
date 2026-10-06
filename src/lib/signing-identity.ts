import { loadAppSigningKey, type AppSigningKey } from '@ima-jin/auth-client';

/**
 * This app's own vault signing key (#7, mirrors `ima-jin/imajin-ai`'s
 * `loadAppSigningKey()` boot path — see `@ima-jin/auth-client`'s README,
 * "Fetch this app's own signing key at boot", and `docs/REGISTRATION.md`).
 *
 * Populated once by `bootstrapSigningIdentity()`, called from
 * `instrumentation.ts` before this app serves any request. Memory-only for
 * the life of this process — never written to disk, another env var, or a
 * log line. `@ima-jin/auth-client` itself only ever persists the narrow-
 * purpose bootstrap keypair on disk (`IMAJIN_APP_KEYSTORE`, `0600`), never
 * this signing key.
 */
let signingIdentity: AppSigningKey | null = null;

/**
 * Fetches this app's own signing key from the kernel — via the local
 * bootstrap keystore when one already exists, or via a one-time claim code
 * on first boot (see `@ima-jin/auth-client`'s `loadAppSigningKey()`). Throws
 * on any failure; let it crash boot rather than run unsigned.
 */
export async function bootstrapSigningIdentity(): Promise<void> {
  signingIdentity = await loadAppSigningKey();
}

/** Returns the signing identity bootstrapped by `bootstrapSigningIdentity()`. */
export function getSigningIdentity(): AppSigningKey {
  if (!signingIdentity) {
    throw new Error(
      'getSigningIdentity: signing identity not bootstrapped yet — instrumentation.ts must run first.'
    );
  }
  return signingIdentity;
}

/** Test-only: clears the in-memory signing identity between test cases. */
export function resetSigningIdentityForTests(): void {
  signingIdentity = null;
}
