import { createVaultBoot, type VaultBoot } from '@ima-jin/auth-client';
import manifest from '../../imajin.app.json';

// Instrumentation and route bundles must share memory, not separate module slots.
const SELF_SECRETS_KEY = Symbol.for('imajin.market.selfSecrets');
export interface ServerConfig {
  DATABASE_URL: string;
  SESSION_SECRET: string;
}
interface SelfSecretsStore {
  [SELF_SECRETS_KEY]?: VaultBoot<ServerConfig> | null;
}
const store = globalThis as SelfSecretsStore;
/** Migration aid only: env material is never used as a credential. */
export function warnIgnoredSelfSecretEnv(): void {
  for (const { name } of manifest.secrets) {
    if (process.env[name]) {
      console.warn(`${name} is ignored; it is issued by the kernel vault. Delete it from the env file.`);
    }
  }
}

export class SelfSecretsUnavailableError extends Error {
  constructor() {
    super('Required vault configuration unavailable — on /jin select Sync manifest secrets, use App secrets set/rotate for DATABASE_URL with owner countersign, and restart market.');
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
    const boot = createVaultBoot<ServerConfig>({
      vault: {
        appDid: process.env.IMAJIN_APP_DID,
        kernelUrl: process.env.IMAJIN_KERNEL_URL,
        keystorePath: process.env.IMAJIN_APP_KEYSTORE,
        keys: manifest.secrets.map(({ name }) => ({ key: name, onMissing: 'fail' })),
        fetchOptions: { signal: AbortSignal.timeout(10_000) },
      },
      configure(credentials) {
        const values = credentials.values;
        for (const { name } of manifest.secrets) {
          if (typeof values[name] !== 'string' || values[name].length === 0) {
            throw new SelfSecretsUnavailableError();
          }
        }
        return { DATABASE_URL: values.DATABASE_URL, SESSION_SECRET: values.SESSION_SECRET };
      },
    });
    store[SELF_SECRETS_KEY] = boot;
    await boot.start(async () => {
      const { initializeServer } = await import('./server');
      initializeServer();
    });
  } catch {
    clearSelfSecrets();
    // Never retain or log provider errors: they may include untrusted plaintext.
    throw new SelfSecretsUnavailableError();
  }
}

/** No env fallback, including when a stale env session variable exists. */
export function getServerConfig(): Readonly<ServerConfig> {
  try {
    const boot = store[SELF_SECRETS_KEY];
    if (!boot) throw new SelfSecretsUnavailableError();
    return boot.getConfig();
  } catch {
    throw new SelfSecretsUnavailableError();
  }
}

export function getSessionSecret(): string {
  return getServerConfig().SESSION_SECRET;
}
