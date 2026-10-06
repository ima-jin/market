import { rmSync } from 'node:fs';
import {
  loadAppSigningKey,
  readKeystore,
  resolveKeystorePath,
  type AppSigningKey,
} from '@ima-jin/auth-client';

/**
 * This app's own vault signing key (#7, #2427, mirrors `ima-jin/imajin-ai`'s
 * `loadAppSigningKey()` boot path — see `@ima-jin/auth-client`'s README,
 * "Fetch this app's own signing key at boot", and `docs/REGISTRATION.md`).
 *
 * Populated once by `bootstrapSigningIdentity()`, called from
 * `instrumentation.ts` before this app serves any request — or later, by
 * `claimWithCode()`, called from the operator-facing `/claim` page's server
 * route (`app/api/claim/route.ts`) once an operator pastes a claim code in
 * the browser instead of an env file. Memory-only for the life of this
 * process (held on `globalThis`, see `SIGNING_IDENTITY_KEY` below) — never written to disk, another env var, or a log line.
 * `@ima-jin/auth-client` itself only ever persists the narrow-purpose
 * bootstrap keypair on disk (`IMAJIN_APP_KEYSTORE`, `0600`), never this
 * signing key.
 */
/**
 * The identity lives on `globalThis` under a `Symbol.for(...)` key — NOT in a
 * module-level variable. Next.js bundles `instrumentation.ts` (which calls
 * `bootstrapSigningIdentity()` at boot) separately from the app-route
 * bundles, so each gets its own copy of this module; a plain module
 * variable set at boot would never be seen by routes after a restart.
 * `Symbol.for` returns the same symbol across every bundle copy, so all of
 * them share one slot. The symbol-keyed slot is not enumerable by string
 * key and is never serialised.
 */
const SIGNING_IDENTITY_KEY = Symbol.for('imajin.app.signingIdentity');

interface SigningIdentityStore {
  [SIGNING_IDENTITY_KEY]?: AppSigningKey | null;
}

function readSigningIdentity(): AppSigningKey | null {
  return (globalThis as SigningIdentityStore)[SIGNING_IDENTITY_KEY] ?? null;
}

function writeSigningIdentity(identity: AppSigningKey | null): void {
  (globalThis as SigningIdentityStore)[SIGNING_IDENTITY_KEY] = identity;
}

/**
 * True once this app has a real, vault-minted signing identity in memory —
 * either from this boot's `bootstrapSigningIdentity()` or from a later
 * `claimWithCode()` hot-swap. False in "unclaimed boot mode" (#2427): the
 * app booted without throwing because neither a bootstrap keystore nor an
 * `IMAJIN_APP_CLAIM_CODE` was present yet.
 */
export function isAppClaimed(): boolean {
  return readSigningIdentity() !== null;
}

/**
 * True when `loadAppSigningKey()` has real material to exchange this boot —
 * an existing bootstrap keystore (every later boot) or a one-time claim
 * code (first boot only). Mirrors the SDK's own precondition check so this
 * module can decide to boot unclaimed *without* calling it at all, rather
 * than parsing its thrown error message.
 */
function hasClaimMaterial(): boolean {
  const keystorePath = resolveKeystorePath(process.env.IMAJIN_APP_KEYSTORE);
  return readKeystore(keystorePath) !== null || Boolean(process.env.IMAJIN_APP_CLAIM_CODE);
}

/**
 * Fetches this app's own signing key from the kernel — via the local
 * bootstrap keystore when one already exists, or via a one-time claim code
 * on first boot (see `@ima-jin/auth-client`'s `loadAppSigningKey()`).
 *
 * Unclaimed boot mode (#2427): when neither a keystore nor
 * `IMAJIN_APP_CLAIM_CODE` is present, this returns without throwing instead
 * of crashing boot — the app serves the "not claimed yet" page
 * (`middleware.ts`) until an operator pastes a code at `/claim`. Any *real*
 * failure (kernel refused a code that was actually provided, network error,
 * …) still throws — a misconfigured deploy should fail loud, not run
 * silently unsigned.
 */
export async function bootstrapSigningIdentity(): Promise<void> {
  if (!hasClaimMaterial()) {
    return;
  }
  writeSigningIdentity(await loadAppSigningKey());
}

/** Returns the signing identity bootstrapped by `bootstrapSigningIdentity()` or `claimWithCode()`. */
export function getSigningIdentity(): AppSigningKey {
  const signingIdentity = readSigningIdentity();
  if (!signingIdentity) {
    throw new Error(
      'getSigningIdentity: signing identity not bootstrapped yet — instrumentation.ts must run first, ' +
        'or this app has not been claimed yet (see /claim).'
    );
  }
  return signingIdentity;
}

export interface ClaimWithCodeParams {
  /** The one-time claim code the operator pasted into `/claim`. */
  claimCode: string;
  /** Best-effort label (e.g. request origin) recorded on the kernel's /jin timeline only. */
  hostHint?: string;
}

/**
 * Thrown by `claimWithCode()` when the kernel redeemed the code for a
 * DIFFERENT app than this one (`IMAJIN_APP_DID`) — e.g. an operator pasted
 * a code copied from a sibling app's `/jin` card. Never carries key
 * material: both fields are public DIDs, safe to log or return to a caller.
 */
export class AppDidMismatchError extends Error {
  constructor(
    public readonly expectedAppDid: string,
    public readonly claimedAppDid: string
  ) {
    super(
      `claimWithCode: kernel redeemed this code for '${claimedAppDid}', but this app is '${expectedAppDid}' — refusing to adopt a foreign identity`
    );
    this.name = 'AppDidMismatchError';
  }
}

/**
 * Redeems a one-time claim code submitted through the operator `/claim`
 * page (`app/api/claim/route.ts`) — the browser-paste path #2427 adds
 * alongside the existing `IMAJIN_APP_CLAIM_CODE` env-var path. Delegates to
 * the same `@ima-jin/auth-client`'s `loadAppSigningKey()` first-boot
 * exchange, so the bootstrap keypair is persisted to the same `0600`
 * keystore either way. Hot-swaps this process's in-memory signing identity
 * immediately — no restart required, though a restart also works (it just
 * re-reads the now-present keystore).
 *
 * Verifies the kernel's returned `appDid` against this app's own
 * `IMAJIN_APP_DID` (when set) before adopting it — a claim code pasted from
 * a DIFFERENT app's `/jin` card would otherwise hot-swap this process to a
 * foreign identity that the next restart's bootstrap-key fetch can never
 * re-authenticate as. `loadAppSigningKey()` itself already persisted the
 * bootstrap keystore as a side effect of the successful kernel exchange by
 * the time we see the mismatch here (see its own docblock: written right
 * after a successful redemption, before returning) — that write is undone
 * below so a foreign-app claim never leaves a keystore behind, and the
 * in-memory identity is never swapped.
 */
export async function claimWithCode(params: ClaimWithCodeParams): Promise<AppSigningKey> {
  const identity = await loadAppSigningKey({ claimCode: params.claimCode, hostHint: params.hostHint });

  const expectedAppDid = process.env.IMAJIN_APP_DID;
  if (expectedAppDid && identity.appDid !== expectedAppDid) {
    rmSync(resolveKeystorePath(process.env.IMAJIN_APP_KEYSTORE), { force: true });
    throw new AppDidMismatchError(expectedAppDid, identity.appDid);
  }

  writeSigningIdentity(identity);
  return identity;
}

/** Test-only: clears the in-memory signing identity between test cases. */
export function resetSigningIdentityForTests(): void {
  writeSigningIdentity(null);
}
