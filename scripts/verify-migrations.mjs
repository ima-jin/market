// Verifies, against a real Postgres, that `pnpm db:migrate` created
// APP_DB_SCHEMA with exactly this app's tables and wrote nothing to any other schema.
// Run after `pnpm db:migrate` — CI does this in the `migrations` job.
import { withMigrationDatabase } from './lib/migration-database.mjs';


const expected = ['__drizzle_migrations', 'checkouts', 'disputes', 'listings', 'seller_settings'];
try {
  await withMigrationDatabase(async (sql, schema) => {
    const rows = await sql`
    SELECT table_schema, table_name
    FROM information_schema.tables
    WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
    ORDER BY table_schema, table_name`;

    const outside = rows.filter((row) => row.table_schema !== schema);
    if (outside.length > 0) {
      throw new Error('Tables found outside the app schema.');
    }

    const actual = rows.map((row) => row.table_name);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error('App schema tables do not match expected migrations.');
    }

    console.log('OK: app schema contains exactly the expected tables.');
  });
} catch {
  console.error('Migration verification failed; check vault access and app schema.');
  process.exitCode = 2;
}
