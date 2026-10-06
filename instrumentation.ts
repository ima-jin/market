import { bootstrapSigningIdentity } from '@/lib/signing-identity';

/**
 * Next.js instrumentation hook (stable since Next 15) — runs once when the
 * server process starts, before it serves any request. Not invoked by
 * `next build`, so CI builds are not gated on runtime secrets.
 *
 * This app is registered with the Imajin kernel (see docs/REGISTRATION.md)
 * and is identified by its own DID. It never reads a raw private key out of
 * an env file — its signing key comes from `@ima-jin/auth-client`'s
 * `loadAppSigningKey()` boot path (one-time claim code on first boot, local
 * bootstrap keystore on every later boot; see #7 and docs/REGISTRATION.md).
 * Refusing to boot on a misconfigured env catches the problem immediately
 * instead of serving requests no kernel call could ever authenticate.
 */
export function validateSigningKeyBootEnv(): void {
  if (process.env.IMAJIN_APP_PRIVATE_KEY) {
    throw new Error(
      'IMAJIN_APP_PRIVATE_KEY is set, but this app no longer reads a raw signing key from env. ' +
        "Remove it — loadAppSigningKey() now bootstraps this app's identity from a one-time claim " +
        'code and a local keystore instead. See docs/REGISTRATION.md and @ima-jin/auth-client\'s ' +
        'README ("Fetch this app\'s own signing key at boot").'
    );
  }

  if (!process.env.IMAJIN_APP_DID) {
    throw new Error(
      'IMAJIN_APP_DID is not set. Register this app with the kernel first — see docs/REGISTRATION.md.'
    );
  }
}

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') {
    return;
  }

  validateSigningKeyBootEnv();
  await bootstrapSigningIdentity();
}
