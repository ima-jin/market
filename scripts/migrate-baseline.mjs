#!/usr/bin/env node
/**
 * Idempotent migration baseline for an EXISTING `market` schema
 * (refs ima-jin/imajin-ai#2511). Run it once per database before the first
 * `pnpm db:migrate`; it is safe to re-run on every deploy.
 *
 *   node --env-file=.env.local scripts/migrate-baseline.mjs [--dry-run]
 *
 * Fetches DATABASE_URL from the vault into memory; only APP_DB_SCHEMA (default
 * `market`) and non-secret app/keystore configuration come from env. See docs/DEPLOY.md and
 * scripts/lib/migrate-baseline-core.mjs for the full safety contract.
 *
 * Exit codes:
 *   0  baselined, already baselined, or fresh database (nothing to baseline)
 *   1  REFUSED: live schema (or migration history) does not match what this
 *      app expects — nothing was changed; fix by hand, do not force
 *   2  usage / configuration / connection error
 */
import { fileURLToPath } from 'node:url';
import { BaselineMismatchError, runBaseline } from './lib/migrate-baseline-core.mjs';
import { MIGRATIONS_FOLDER, withMigrationDatabase } from './lib/migration-database.mjs';

const MESSAGES = {
  baselined: (tag) => `Baselined: recorded ${tag} as applied. Next: pnpm db:migrate`,
  'already-baselined': (tag) => `Already baselined (${tag} is recorded) — nothing to do.`,
  'fresh-database': () => 'Fresh database: the app schema does not exist yet — nothing to baseline. Next: pnpm db:migrate',
  'would-baseline': (tag) => `Dry run: live schema matches; would record ${tag} as applied. Nothing was written.`,
};

export async function main(argv) {
  const unknown = argv.filter((arg) => arg !== '--dry-run');
  if (unknown.length > 0) {
    console.error('Unknown argument(s). Usage: migrate-baseline.mjs [--dry-run]');
    return 2;
  }

  try {
    const { status, tag } = await withMigrationDatabase((sql, schema) => runBaseline(sql, {
      schema,
      migrationsFolder: MIGRATIONS_FOLDER,
      dryRun: argv.includes('--dry-run'),
    }));
    console.log(MESSAGES[status](tag));
    return 0;
  } catch (error) {
    if (error instanceof BaselineMismatchError) {
      console.error('Refusing to baseline: schema or migration history mismatch.');
      console.error('\nNothing was changed. Do NOT force this: reconcile the schema by hand, then re-run.');
      return 1;
    }
    console.error('Baseline failed: required vault credential, database or migration unavailable.');
    return 2;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
