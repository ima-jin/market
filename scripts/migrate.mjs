#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { MIGRATIONS_FOLDER, withMigrationDatabase } from './lib/migration-database.mjs';

/** Forward-only migration, with tracking confined to the app's own schema. */
export async function main(argv) {
  if (argv.length > 0) {
    console.error('Usage: migrate.mjs');
    return 2;
  }
  try {
    await withMigrationDatabase((sql, schema) => migrate(drizzle(sql), {
      migrationsFolder: MIGRATIONS_FOLDER,
      migrationsSchema: schema,
    }));
    console.log('Migrations applied; app schema is up to date.');
    return 0;
  } catch {
    // SDK, driver, SQL and cleanup errors may echo credential material.
    console.error('Migration failed: required vault credential, database or migration unavailable.');
    return 2;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
