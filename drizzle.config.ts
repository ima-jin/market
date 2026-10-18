import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { defineConfig } from 'drizzle-kit';

// Offline db:generate only. Load only the non-secret schema name, never a
// credential or arbitrary env entries. Deployment uses scripts/migrate.mjs.
const envPath = '.env.local';
if (!process.env.APP_DB_SCHEMA && existsSync(envPath)) {
  const schema = parseEnv(readFileSync(envPath, 'utf-8')).APP_DB_SCHEMA;
  if (schema) process.env.APP_DB_SCHEMA = schema;
}

const appSchemaName = process.env.APP_DB_SCHEMA;
if (!appSchemaName) {
  throw new Error('APP_DB_SCHEMA is not set — see .env.example and docs/MIGRATIONS.md.');
}

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './migrations',
  dialect: 'postgresql',
  schemaFilter: [appSchemaName],
  // Keep drizzle's own tracking table inside this app's schema too, so the
  // app never writes outside the schema it owns (docs/MIGRATIONS.md).
  migrations: { schema: appSchemaName },
});
