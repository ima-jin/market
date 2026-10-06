/**
 * Core of `scripts/migrate-baseline.mjs` (refs ima-jin/imajin-ai#2511).
 *
 * Problem: prod/dev already have a `market` schema, created long ago by the
 * monorepo's shared root migrations (`imajin-ai/migrations/0001_seed.sql`,
 * `CREATE TABLE IF NOT EXISTS market.*`). This repo's own drizzle history
 * (`migrations/0000_market_schema.sql`) creates those tables with plain
 * `CREATE TABLE`, so running `pnpm db:migrate` against an existing database
 * would fail on the first table.
 *
 * The fix is a *baseline*: prove the live schema is what migration 0000 would
 * have produced, then record 0000 as already applied in drizzle's own tracking
 * table so `drizzle-kit migrate` only runs what comes after it.
 *
 * Safety contract (enforced by tests in scripts/__tests__/):
 *   - Read-only against the app tables: only `pg_catalog` introspection
 *     SELECTs ever touch them. Nothing is dropped, truncated, or altered.
 *   - The only writes are `CREATE SCHEMA/TABLE IF NOT EXISTS` for drizzle's
 *     tracking table and one INSERT into it, in a single transaction guarded
 *     by an advisory lock.
 *   - Idempotent: a second run finds the recorded hash and does nothing.
 *   - Refuses (throws BaselineMismatchError) on any mismatch or ambiguous
 *     state instead of guessing.
 *
 * Tracking format mirrors drizzle-orm's pg migrator exactly: row
 * `(hash = sha256(sql file contents), created_at = journal entry "when")` in
 * the tracking table; the migrator applies only journal entries whose `when`
 * is greater than the newest recorded `created_at`. Unlike a default drizzle
 * setup, `drizzle.config.ts` keeps that table INSIDE the app schema
 * (`migrations: { schema: APP_DB_SCHEMA }`) so the app never writes outside
 * the schema it owns — the baseline therefore defaults to the app schema too,
 * and introspection ignores the tracking table itself.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const DEFAULT_MIGRATIONS_TABLE = '__drizzle_migrations';

// Arbitrary constant namespace for pg_advisory_xact_lock — serialises two
// concurrent baseline runs (e.g. a deploy retried while the first still runs).
const ADVISORY_LOCK_KEY = 2_511_001;

const IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_]*$/;

export class BaselineMismatchError extends Error {
  /** @param {string[]} problems */
  constructor(problems) {
    super(`Refusing to baseline — ${problems.length} problem(s):\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'BaselineMismatchError';
    this.problems = problems;
  }
}

/**
 * Validates a Postgres identifier supplied via env/CLI before it is ever
 * interpolated into SQL (schema names cannot be bound as parameters).
 * @param {string} value
 * @param {string} label
 */
export function assertIdentifier(value, label) {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    throw new Error(`${label} must match ${IDENTIFIER_PATTERN} (got ${JSON.stringify(value)}).`);
  }
  return value;
}

/**
 * The schema shape migration `0000_market_schema.sql` produces, in the same
 * normalised form `introspectSchema()` returns. Constraint *names* are
 * deliberately not compared (a name-only difference does not make the live
 * schema unsafe to adopt). Column sets, types, nullability, defaults, keys, FK
 * targets/actions and required indexes are all compared. Column ORDER is not:
 * the monorepo seed created the columns in a different order than drizzle.
 *
 * Pinned to migration 0000 — it does NOT track later `src/db/schema.ts`
 * changes. The test suite applies the real 0000 file and asserts this
 * expectation accepts it, so the two cannot drift apart silently.
 * @param {string} schema
 */
export function expectedSchema(schema) {
  const col = (type, { notNull = false, def = null } = {}) => ({ type, notNull, default: def });
  const tsz = 'timestamp with time zone';
  return {
    listings: {
      columns: {
        id: col('text', { notNull: true }),
        seller_did: col('text', { notNull: true }),
        title: col('text', { notNull: true }),
        description: col('text'),
        price: col('integer', { notNull: true }),
        currency: col('text', { def: "'CAD'::text" }),
        category: col('text'),
        images: col('jsonb', { def: "'[]'::jsonb" }),
        image_asset_ids: col('jsonb', { def: "'[]'::jsonb" }),
        quantity: col('integer', { def: '1' }),
        type: col('text', { notNull: true, def: "'sale'::text" }),
        status: col('text', { def: "'active'::text" }),
        seller_tier: col('text', { notNull: true, def: "'public_offplatform'::text" }),
        show_contact_info: col('boolean', { def: 'false' }),
        expires_at: col(tsz),
        contact_info: col('jsonb'),
        trust_threshold: col('jsonb'),
        range_km: col('integer', { def: '50' }),
        metadata: col('jsonb', { def: "'{}'::jsonb" }),
        fair_manifest: col('jsonb'),
        created_at: col(tsz, { def: 'now()' }),
        updated_at: col(tsz, { def: 'now()' }),
      },
      primaryKey: ['id'],
      unique: [],
      foreignKeys: [],
      indexes: [
        { name: 'idx_market_listings_seller_did', columns: ['seller_did'], method: 'btree' },
        { name: 'idx_market_listings_category_status', columns: ['category', 'status'], method: 'btree' },
        { name: 'idx_market_listings_status_created', columns: ['status', 'created_at'], method: 'btree' },
      ],
    },
    disputes: {
      columns: {
        id: col('text', { notNull: true }),
        listing_id: col('text', { notNull: true }),
        transaction_id: col('text', { notNull: true }),
        buyer_did: col('text', { notNull: true }),
        seller_did: col('text', { notNull: true }),
        type: col('text', { notNull: true }),
        status: col('text', { notNull: true, def: "'open'::text" }),
        resolution: col('text'),
        buyer_evidence: col('jsonb', { def: "'[]'::jsonb" }),
        seller_evidence: col('jsonb', { def: "'[]'::jsonb" }),
        evidence_deadline: col(tsz),
        resolved_at: col(tsz),
        created_at: col(tsz, { def: 'now()' }),
      },
      primaryKey: ['id'],
      unique: [],
      foreignKeys: [
        {
          columns: ['listing_id'],
          refSchema: schema,
          refTable: 'listings',
          refColumns: ['id'],
          onDelete: 'no action',
          onUpdate: 'no action',
        },
      ],
      indexes: [],
    },
    seller_settings: {
      columns: {
        did: col('text', { notNull: true }),
        show_market_items: col('boolean', { def: 'false' }),
        created_at: col(tsz, { def: 'now()' }),
        updated_at: col(tsz, { def: 'now()' }),
      },
      primaryKey: ['did'],
      unique: [],
      foreignKeys: [],
      indexes: [],
    },
  };
}

const FK_ACTIONS = {
  a: 'no action',
  r: 'restrict',
  c: 'cascade',
  n: 'set null',
  d: 'set default',
};

/**
 * @param {{ unsafe: (text: string, params?: unknown[]) => Promise<any[]> }} q
 * @param {string} text
 * @param {unknown[]} [params]
 */
function query(q, text, params = []) {
  return q.unsafe(text, params);
}

// $2 = drizzle's tracking table name: it lives inside the app schema (see the
// header) but is bookkeeping, not app data, so it is excluded from every query.
const SQL_TABLES = `
  SELECT c.relname AS table_name
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = $1 AND c.relname <> $2 AND c.relkind IN ('r', 'p', 'v', 'm', 'f')`;

const SQL_COLUMNS = `
  SELECT c.relname AS table_name, a.attname::text AS column_name,
         format_type(a.atttypid, a.atttypmod) AS data_type,
         a.attnotnull AS not_null,
         pg_get_expr(d.adbin, d.adrelid) AS default_expr
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  WHERE n.nspname = $1 AND c.relname <> $2 AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped`;

const SQL_CONSTRAINTS = `
  SELECT c.relname AS table_name, con.contype::text AS kind,
         (SELECT array_agg(att.attname::text ORDER BY k.ord)
            FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
            JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = k.attnum) AS columns,
         rn.nspname AS ref_schema, rc.relname AS ref_table,
         (SELECT array_agg(att.attname::text ORDER BY k.ord)
            FROM unnest(con.confkey) WITH ORDINALITY AS k(attnum, ord)
            JOIN pg_attribute att ON att.attrelid = con.confrelid AND att.attnum = k.attnum) AS ref_columns,
         con.confdeltype::text AS on_delete, con.confupdtype::text AS on_update
  FROM pg_constraint con
  JOIN pg_class c ON c.oid = con.conrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_class rc ON rc.oid = con.confrelid
  LEFT JOIN pg_namespace rn ON rn.oid = rc.relnamespace
  WHERE n.nspname = $1 AND c.relname <> $2 AND con.contype IN ('p', 'u', 'f')`;

// Plain indexes only — those backing a PK/UNIQUE constraint are covered above.
const SQL_INDEXES = `
  SELECT t.relname AS table_name, i.relname AS index_name, am.amname AS method,
         (SELECT array_agg(coalesce(att.attname::text, '<expression>') ORDER BY k.ord)
            FROM unnest(ix.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
            LEFT JOIN pg_attribute att ON att.attrelid = ix.indrelid AND att.attnum = k.attnum) AS columns
  FROM pg_index ix
  JOIN pg_class i ON i.oid = ix.indexrelid
  JOIN pg_class t ON t.oid = ix.indrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  JOIN pg_am am ON am.oid = i.relam
  WHERE n.nspname = $1 AND t.relname <> $2
    AND NOT EXISTS (SELECT 1 FROM pg_constraint pc WHERE pc.conindid = ix.indexrelid)`;

/**
 * Reads the live shape of `schema` using catalog SELECTs only.
 * @param {{ unsafe: (text: string, params?: unknown[]) => Promise<any[]> }} q
 * @param {string} schema
 * @param {string} [trackingTable] drizzle's tracking table, ignored if present in `schema`
 */
export async function introspectSchema(q, schema, trackingTable = DEFAULT_MIGRATIONS_TABLE) {
  const actual = {};
  const ensure = (name) => {
    actual[name] ??= { columns: {}, primaryKey: [], unique: [], foreignKeys: [], indexes: [] };
    return actual[name];
  };

  for (const row of await query(q, SQL_TABLES, [schema, trackingTable])) {
    ensure(row.table_name);
  }
  for (const row of await query(q, SQL_COLUMNS, [schema, trackingTable])) {
    ensure(row.table_name).columns[row.column_name] = {
      type: row.data_type,
      notNull: row.not_null,
      default: row.default_expr ?? null,
    };
  }
  for (const row of await query(q, SQL_CONSTRAINTS, [schema, trackingTable])) {
    const table = ensure(row.table_name);
    if (row.kind === 'p') {
      table.primaryKey = row.columns;
    } else if (row.kind === 'u') {
      table.unique.push(row.columns);
    } else {
      table.foreignKeys.push({
        columns: row.columns,
        refSchema: row.ref_schema,
        refTable: row.ref_table,
        refColumns: row.ref_columns,
        onDelete: FK_ACTIONS[row.on_delete] ?? row.on_delete,
        onUpdate: FK_ACTIONS[row.on_update] ?? row.on_update,
      });
    }
  }
  for (const row of await query(q, SQL_INDEXES, [schema, trackingTable])) {
    ensure(row.table_name).indexes.push({ name: row.index_name, columns: row.columns, method: row.method });
  }
  return actual;
}

const list = (value) => `(${value.join(', ')})`;
const byText = (a, b) => a.localeCompare(b);

function compareColumns(table, actualTable, expectedTable, problems) {
  for (const [name, want] of Object.entries(expectedTable.columns)) {
    const have = actualTable.columns[name];
    if (have === undefined) {
      problems.push(`${table}.${name}: column is missing`);
      continue;
    }
    if (have.type !== want.type) {
      problems.push(`${table}.${name}: type is ${have.type}, expected ${want.type}`);
    }
    if (have.notNull !== want.notNull) {
      problems.push(`${table}.${name}: NOT NULL is ${have.notNull}, expected ${want.notNull}`);
    }
    if (have.default !== want.default) {
      problems.push(`${table}.${name}: default is ${have.default ?? 'none'}, expected ${want.default ?? 'none'}`);
    }
  }
  for (const name of Object.keys(actualTable.columns).sort(byText)) {
    if (!(name in expectedTable.columns)) {
      problems.push(`${table}.${name}: unexpected column`);
    }
  }
}

function compareKeys(table, actualTable, expectedTable, problems) {
  if (JSON.stringify(actualTable.primaryKey) !== JSON.stringify(expectedTable.primaryKey)) {
    problems.push(
      `${table}: primary key is ${list(actualTable.primaryKey)}, expected ${list(expectedTable.primaryKey)}`,
    );
  }
  const haveUnique = actualTable.unique.map((c) => JSON.stringify(c)).sort(byText);
  const wantUnique = expectedTable.unique.map((c) => JSON.stringify(c)).sort(byText);
  if (JSON.stringify(haveUnique) !== JSON.stringify(wantUnique)) {
    problems.push(`${table}: unique constraints are ${haveUnique.join(' ') || 'none'}, expected ${wantUnique.join(' ') || 'none'}`);
  }
  const haveFks = actualTable.foreignKeys.map((f) => JSON.stringify(f)).sort(byText);
  const wantFks = expectedTable.foreignKeys.map((f) => JSON.stringify(f)).sort(byText);
  if (JSON.stringify(haveFks) !== JSON.stringify(wantFks)) {
    problems.push(`${table}: foreign keys are ${haveFks.join(' ') || 'none'}, expected ${wantFks.join(' ') || 'none'}`);
  }
}

function compareIndexes(table, actualTable, expectedTable, problems) {
  // Extra indexes are tolerated (harmless); missing or reshaped ones are not.
  for (const want of expectedTable.indexes) {
    const have = actualTable.indexes.find((i) => i.name === want.name);
    if (have === undefined) {
      problems.push(`${table}: index ${want.name} is missing`);
    } else if (JSON.stringify(have.columns) !== JSON.stringify(want.columns) || have.method !== want.method) {
      problems.push(`${table}: index ${want.name} is ${have.method}${list(have.columns)}, expected ${want.method}${list(want.columns)}`);
    }
  }
}

/**
 * Pure comparison. Returns a list of human-readable problems (empty = match).
 * @param {ReturnType<typeof expectedSchema>} actual
 * @param {ReturnType<typeof expectedSchema>} expected
 * @returns {string[]}
 */
export function compareSchema(actual, expected) {
  const problems = [];
  for (const [table, expectedTable] of Object.entries(expected)) {
    const actualTable = actual[table];
    if (actualTable === undefined) {
      problems.push(`${table}: table is missing`);
      continue;
    }
    compareColumns(table, actualTable, expectedTable, problems);
    compareKeys(table, actualTable, expectedTable, problems);
    compareIndexes(table, actualTable, expectedTable, problems);
  }
  for (const table of Object.keys(actual).sort(byText)) {
    if (!(table in expected)) {
      problems.push(`${table}: unexpected table in the app schema`);
    }
  }
  return problems;
}

/**
 * Reads the baseline migration (the first journal entry) exactly the way
 * drizzle-orm's `readMigrationFiles` does, so the recorded hash matches.
 * @param {string} migrationsFolder
 */
export async function readBaselineMigration(migrationsFolder) {
  const journal = JSON.parse(await readFile(join(migrationsFolder, 'meta', '_journal.json'), 'utf8'));
  const entry = journal.entries?.[0];
  if (entry === undefined) {
    throw new Error(`No entries in ${migrationsFolder}/meta/_journal.json — nothing to baseline.`);
  }
  const contents = await readFile(join(migrationsFolder, `${entry.tag}.sql`), 'utf8');
  return {
    tag: entry.tag,
    when: entry.when,
    hash: createHash('sha256').update(contents).digest('hex'),
  };
}

/**
 * Idempotently baselines the existing app schema.
 *
 * Returns `{ status, tag }` where status is one of:
 *   - `baselined`          schema matched; migration 0000 recorded as applied
 *   - `already-baselined`  0000 was already recorded; nothing changed
 *   - `fresh-database`     the app schema does not exist yet; nothing to
 *                          baseline — `pnpm db:migrate` will create it
 *   - `would-baseline`     (dryRun only) schema matched; nothing was written
 * Throws BaselineMismatchError on any mismatch/ambiguity.
 *
 * @param {{ begin: (fn: (tx: any) => Promise<any>) => Promise<any> }} sql postgres.js client
 * @param {{ schema: string, migrationsFolder: string, dryRun?: boolean,
 *           migrationsSchema?: string, migrationsTable?: string }} options
 */
export function runBaseline(sql, options) {
  const schema = assertIdentifier(options.schema, 'APP_DB_SCHEMA');
  const trackingSchema = assertIdentifier(options.migrationsSchema ?? schema, 'migrations schema');
  const trackingTable = assertIdentifier(options.migrationsTable ?? DEFAULT_MIGRATIONS_TABLE, 'migrations table');
  const dryRun = options.dryRun === true;
  const tracking = `"${trackingSchema}"."${trackingTable}"`;

  return sql.begin(async (tx) => {
    const baseline = await readBaselineMigration(options.migrationsFolder);
    await query(tx, 'SELECT pg_advisory_xact_lock($1)', [ADVISORY_LOCK_KEY]);

    const [{ exists: trackingExists }] = await query(tx, 'SELECT to_regclass($1) IS NOT NULL AS exists', [tracking]);
    const recorded = trackingExists
      ? await query(tx, `SELECT hash, created_at FROM ${tracking} ORDER BY created_at`)
      : [];

    if (recorded.some((row) => row.hash === baseline.hash)) {
      return { status: 'already-baselined', tag: baseline.tag };
    }
    if (recorded.length > 0) {
      throw new BaselineMismatchError([
        `${tracking} already holds ${recorded.length} row(s) but none match ${baseline.tag} — ` +
          'unrecognised migration history; resolve by hand before baselining.',
      ]);
    }

    const [{ exists: schemaExists }] = await query(
      tx,
      'SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = $1) AS exists',
      [schema],
    );
    if (!schemaExists) {
      return { status: 'fresh-database', tag: baseline.tag };
    }

    const problems = compareSchema(await introspectSchema(tx, schema, trackingTable), expectedSchema(schema));
    if (problems.length > 0) {
      throw new BaselineMismatchError(problems);
    }
    if (dryRun) {
      return { status: 'would-baseline', tag: baseline.tag };
    }

    // Create-only DDL for drizzle's own bookkeeping — same statements the
    // drizzle migrator itself issues. Never touches the app schema.
    await query(tx, `CREATE SCHEMA IF NOT EXISTS "${trackingSchema}"`);
    await query(
      tx,
      `CREATE TABLE IF NOT EXISTS ${tracking} (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`,
    );
    await query(tx, `INSERT INTO ${tracking} (hash, created_at) VALUES ($1, $2)`, [baseline.hash, baseline.when]);
    return { status: 'baselined', tag: baseline.tag };
  });
}
