#!/usr/bin/env node
/**
 * Idempotent migration baseline for an EXISTING `market` schema
 * (refs ima-jin/imajin-ai#2511). Run it once per database before the first
 * `pnpm db:migrate`; it is safe to re-run on every deploy.
 *
 *   node --env-file=.env.local scripts/migrate-baseline.mjs [--dry-run]
 *
 * Reads DATABASE_URL and APP_DB_SCHEMA (default `market`) from the environment
 * — it never reads or prints secrets itself. See docs/DEPLOY.md and
 * scripts/lib/migrate-baseline-core.mjs for the full safety contract.
 *
 * Exit codes:
 *   0  baselined, already baselined, or fresh database (nothing to baseline)
 *   1  REFUSED: live schema (or migration history) does not match what this
 *      app expects — nothing was changed; fix by hand, do not force
 *   2  usage / configuration / connection error
 */
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { BaselineMismatchError, runBaseline } from './lib/migrate-baseline-core.mjs';

const MIGRATIONS_FOLDER = fileURLToPath(new URL('../migrations', import.meta.url));

const MESSAGES = {
  baselined: (tag) => `Baselined: recorded ${tag} as applied. Next: pnpm db:migrate`,
  'already-baselined': (tag) => `Already baselined (${tag} is recorded) — nothing to do.`,
  'fresh-database': () => 'Fresh database: the app schema does not exist yet — nothing to baseline. Next: pnpm db:migrate',
  'would-baseline': (tag) => `Dry run: live schema matches; would record ${tag} as applied. Nothing was written.`,
};

async function main(argv) {
  const unknown = argv.filter((arg) => arg !== '--dry-run');
  if (unknown.length > 0) {
    console.error(`Unknown argument(s): ${unknown.join(' ')}\nUsage: migrate-baseline.mjs [--dry-run]`);
    return 2;
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is not set — run with `node --env-file=<env file> scripts/migrate-baseline.mjs`.');
    return 2;
  }

  const schema = process.env.APP_DB_SCHEMA || 'market';
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    const { status, tag } = await runBaseline(sql, {
      schema,
      migrationsFolder: MIGRATIONS_FOLDER,
      dryRun: argv.includes('--dry-run'),
    });
    console.log(MESSAGES[status](tag));
    return 0;
  } catch (error) {
    if (error instanceof BaselineMismatchError) {
      console.error(error.message);
      console.error('\nNothing was changed. Do NOT force this: reconcile the schema by hand, then re-run.');
      return 1;
    }
    console.error(`Baseline failed: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

process.exitCode = await main(process.argv.slice(2));
