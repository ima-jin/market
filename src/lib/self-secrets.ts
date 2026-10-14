import { loadFromVault } from '@ima-jin/auth-client';
import manifest from '../../imajin.app.json';

// Instrumentation and route bundles must share memory, not separate module slots.
const SELF_SECRETS_KEY = Symbol.for('imajin.market.selfSecrets');
interface SelfSecretsStore {
  [SELF_SECRETS_KEY]?: Readonly<Record<string, string>> | null;
}
const store = globalThis as SelfSecretsStore;

export class SelfSecretsUnavailableError extends Error {
  constructor() {
    super('SESSION_SECRET unavailable from vault — on /jin select Sync manifest secrets, countersign, and restart market.');
    this.name = 'SelfSecretsUnavailableError';
  }
}

/** Discard any previous generation before attempting a new boot/activation. */
export function clearSelfSecrets(): void {
  store[SELF_SECRETS_KEY] = null;
}

/** The SDK signs with this app's bound local keystore and opens values in memory only. */
export async function loadSelfSecrets(): Promise<void> {
  clearSelfSecrets();
  try {
    const credentials = await loadFromVault({
      appDid: process.env.IMAJIN_APP_DID,
      kernelUrl: process.env.IMAJIN_KERNEL_URL,
      keystorePath: process.env.IMAJIN_APP_KEYSTORE,
      keys: manifest.secrets.map(({ name }) => ({ key: name, onMissing: 'fail' })),
      fetchOptions: { signal: AbortSignal.timeout(10_000) },
    });
    const values: Record<string, string> = Object.create(null);
    for (const { name } of manifest.secrets) {
      const value = credentials.values[name];
      if (typeof value !== 'string' || value.length === 0) {
        throw new SelfSecretsUnavailableError();
      }
      values[name] = value;
    }
    store[SELF_SECRETS_KEY] = Object.freeze(values);
  } catch {
    // Never retain or log provider errors: they may include untrusted plaintext.
    throw new SelfSecretsUnavailableError();
  }
}

/** No env fallback, including when a stale env session variable exists. */
export function getSessionSecret(): string {
  const value = store[SELF_SECRETS_KEY]?.SESSION_SECRET;
  if (!value) throw new SelfSecretsUnavailableError();
  return value;
}
