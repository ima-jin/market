// Verifies, against a real Postgres (DATABASE_URL), that `pnpm db:migrate` created
// APP_DB_SCHEMA with exactly this app's tables and wrote nothing to any other schema.
// Run after `pnpm db:migrate` — CI does this in the `migrations` job.
import postgres from 'postgres';

const schema = process.env.APP_DB_SCHEMA;
const url = process.env.DATABASE_URL;
if (!schema || !url) {
  throw new Error('APP_DB_SCHEMA and DATABASE_URL must be set.');
}

const expected = ['__drizzle_migrations', 'disputes', 'listings', 'seller_settings'];

const sql = postgres(url, { max: 1 });
try {
  const rows = await sql`
    SELECT table_schema, table_name
    FROM information_schema.tables
    WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
    ORDER BY table_schema, table_name`;

  const outside = rows.filter((row) => row.table_schema !== schema);
  if (outside.length > 0) {
    throw new Error(
      `Tables found outside "${schema}": ${outside.map((r) => `${r.table_schema}.${r.table_name}`).join(', ')}`,
    );
  }

  const actual = rows.map((row) => row.table_name);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Expected ${schema} tables ${expected.join(', ')} but found ${actual.join(', ')}`);
  }

  console.log(`OK: schema "${schema}" contains exactly ${expected.join(', ')}.`);
} finally {
  await sql.end();
}
