import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { assertIdentifier } from './migrate-baseline-core.mjs';

const require = createRequire(import.meta.url);
export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../migrations', import.meta.url));

/** No legacy env fallback, including on failed vault fetches. */
export async function loadMigrationDatabaseUrl() {
  try {
    const testUrl = process.env.MIGRATIONS_TEST_DATABASE_URL;
    if (testUrl !== undefined) {
      const testContext = process.env.NODE_ENV === 'test' || process.env.CI === 'true';
      if (!testContext || process.env.NODE_ENV === 'production' || testUrl.length === 0) {
        throw new Error('Test database override refused.');
      }
      return testUrl;
    }
    // The CJS SDK entry resolves Next's optional headers dependency in plain Node.
    const { loadFromVault } = require('@ima-jin/auth-client');
    const credentials = await loadFromVault({
      appDid: process.env.IMAJIN_APP_DID,
      kernelUrl: process.env.IMAJIN_KERNEL_URL,
      keystorePath: process.env.IMAJIN_APP_KEYSTORE,
      keys: [{ key: 'DATABASE_URL', onMissing: 'fail' }],
      fetchOptions: { signal: AbortSignal.timeout(10_000) },
    });
    const value = credentials.values.DATABASE_URL;
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error('Required migration credential missing.');
    }
    return value;
  } catch {
    throw new Error('Migration DATABASE_URL unavailable; check the app keystore and /jin App secrets approvals.');
  }
}

/** Keep the credential in this process, close clients even on refused migrations. */
export async function withMigrationDatabase(operation) {
  const schema = assertIdentifier(process.env.APP_DB_SCHEMA || 'market', 'APP_DB_SCHEMA');
  const url = await loadMigrationDatabaseUrl();
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    return await operation(sql, schema);
  } finally {
    await sql.end({ timeout: 5 });
  }
}
