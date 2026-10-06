import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import postgres from 'postgres';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertIdentifier,
  BaselineMismatchError,
  compareSchema,
  expectedSchema,
  readBaselineMigration,
  runBaseline,
} from '../lib/migrate-baseline-core.mjs';

const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../migrations', import.meta.url));
const CLI = fileURLToPath(new URL('../migrate-baseline.mjs', import.meta.url));
const BASELINE_SQL_FILE = `${MIGRATIONS_FOLDER}/0000_market_schema.sql`;
const SCHEMA = 'market';
// drizzle.config.ts keeps the tracking table inside the app schema.
const TRACKING = `${SCHEMA}.__drizzle_migrations`;

type RunnerSql = Parameters<typeof runBaseline>[0];
type Options = { dryRun?: boolean };

function run(sql: unknown, options: Options = {}) {
  return runBaseline(sql as RunnerSql, { schema: SCHEMA, migrationsFolder: MIGRATIONS_FOLDER, ...options });
}

/** Minimal child env — never inherits the caller's DATABASE_URL & friends. */
function childEnv(env: Record<string, string>): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? '', ...env } as unknown as NodeJS.ProcessEnv;
}

describe('assertIdentifier', () => {
  it('accepts plain lower-case identifiers', () => {
    expect(assertIdentifier('market', 'x')).toBe('market');
    expect(assertIdentifier('app_market_2', 'x')).toBe('app_market_2');
  });

  it.each(['', 'Market', 'market; DROP SCHEMA market', 'a"b', '1market', 'a-b'])('rejects %j', (value) => {
    expect(() => assertIdentifier(value, 'APP_DB_SCHEMA')).toThrow(/APP_DB_SCHEMA must match/);
  });
});

describe('readBaselineMigration', () => {
  it('hashes the first journal entry exactly like drizzle-orm does', async () => {
    const baseline = await readBaselineMigration(MIGRATIONS_FOLDER);
    const [drizzleFirst] = readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER });

    expect(baseline.tag).toBe('0000_market_schema');
    expect(baseline.hash).toBe(drizzleFirst.hash);
    expect(baseline.when).toBe(drizzleFirst.folderMillis);
    expect(baseline.hash).toBe(createHash('sha256').update(readFileSync(BASELINE_SQL_FILE, 'utf8')).digest('hex'));
  });

  it('fails when the journal has no entries', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'market-empty-journal-'));
    try {
      mkdirSync(join(dir, 'meta'));
      writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify({ entries: [] }));
      await expect(readBaselineMigration(dir)).rejects.toThrow(/nothing to baseline/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('compareSchema', () => {
  const fresh = () => structuredClone(expectedSchema(SCHEMA));

  it('accepts an identical schema', () => {
    expect(compareSchema(fresh(), expectedSchema(SCHEMA))).toEqual([]);
  });

  it('tolerates extra indexes (harmless)', () => {
    const actual = fresh();
    actual.listings.indexes.push({ name: 'idx_extra', columns: ['title'], method: 'btree' });
    expect(compareSchema(actual, expectedSchema(SCHEMA))).toEqual([]);
  });

  it('reports a missing table', () => {
    const actual = fresh() as Record<string, unknown>;
    delete actual.disputes;
    expect(compareSchema(actual as ReturnType<typeof expectedSchema>, expectedSchema(SCHEMA))).toEqual([
      'disputes: table is missing',
    ]);
  });

  it('reports an unexpected table', () => {
    const actual = { ...fresh(), stray: structuredClone(fresh().seller_settings) };
    expect(compareSchema(actual, expectedSchema(SCHEMA))).toEqual(['stray: unexpected table in the app schema']);
  });

  it('reports missing, extra, retyped, nullability and default drift on columns', () => {
    const actual = fresh();
    delete (actual.listings.columns as Record<string, unknown>).description;
    (actual.listings.columns as Record<string, unknown>).surprise = { type: 'text', notNull: false, default: null };
    actual.listings.columns.title.type = 'character varying(255)';
    actual.listings.columns.price.notNull = false;
    actual.listings.columns.quantity.default = null;

    expect(compareSchema(actual, expectedSchema(SCHEMA))).toEqual([
      'listings.title: type is character varying(255), expected text',
      'listings.description: column is missing',
      'listings.price: NOT NULL is false, expected true',
      "listings.quantity: default is none, expected 1",
      'listings.surprise: unexpected column',
    ]);
  });

  it('reports key, FK and index drift', () => {
    const actual = fresh();
    actual.listings.primaryKey = ['seller_did'];
    (actual.listings as { unique: string[][] }).unique = [['title']];
    actual.disputes.foreignKeys[0].onDelete = 'cascade';
    actual.listings.indexes = [];

    const problems = compareSchema(actual, expectedSchema(SCHEMA));
    const text = problems.join('\n');
    expect(problems).toHaveLength(6);
    expect(text).toMatch(/listings: primary key is \(seller_did\), expected \(id\)/);
    expect(text).toMatch(/listings: unique constraints/);
    expect(text).toMatch(/disputes: foreign keys/);
    expect(text).toMatch(/listings: index idx_market_listings_seller_did is missing/);
    expect(text).toMatch(/listings: index idx_market_listings_category_status is missing/);
    expect(text).toMatch(/listings: index idx_market_listings_status_created is missing/);
  });

  it('reports a reshaped index', () => {
    const actual = fresh();
    actual.listings.indexes[1].columns = ['category'];
    expect(compareSchema(actual, expectedSchema(SCHEMA))).toEqual([
      'listings: index idx_market_listings_category_status is btree(category), expected btree(category, status)',
    ]);
  });
});

describe('migrate-baseline CLI (no database needed)', () => {
  const cli = (args: string[], env: Record<string, string> = {}) =>
    spawnSync(process.execPath, [CLI, ...args], { env: childEnv(env), encoding: 'utf8' });

  it('exits 2 with usage on an unknown argument', () => {
    const result = cli(['--force']);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/Unknown argument\(s\): --force/);
  });

  it('exits 2 when DATABASE_URL is not set', () => {
    const result = cli([]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/DATABASE_URL is not set/);
  });

  it('exits 2 on an unsafe APP_DB_SCHEMA without echoing the connection string', () => {
    const result = cli([], {
      DATABASE_URL: 'postgres://u:supersecretvalue@127.0.0.1:1/db',
      APP_DB_SCHEMA: 'market; DROP SCHEMA market',
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/APP_DB_SCHEMA must match/);
    expect(result.stdout + result.stderr).not.toContain('supersecretvalue');
  });
});

/**
 * The shape the monorepo's shared seed (imajin-ai migrations/0001_seed.sql)
 * left in prod/dev: same tables and constraints as this repo's migration
 * 0000, but with the seed's own column order.
 */
const PROD_LIKE_SCHEMA_SQL = [
  'CREATE SCHEMA IF NOT EXISTS market',
  `CREATE TABLE market.listings (
    id text NOT NULL, seller_did text NOT NULL, title text NOT NULL, description text,
    price integer NOT NULL, currency text DEFAULT 'CAD'::text, category text,
    images jsonb DEFAULT '[]'::jsonb, quantity integer DEFAULT 1,
    status text DEFAULT 'active'::text,
    seller_tier text DEFAULT 'public_offplatform'::text NOT NULL,
    contact_info jsonb, trust_threshold jsonb, range_km integer DEFAULT 50,
    metadata jsonb DEFAULT '{}'::jsonb, fair_manifest jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    image_asset_ids jsonb DEFAULT '[]'::jsonb,
    type text DEFAULT 'sale'::text NOT NULL,
    show_contact_info boolean DEFAULT false,
    expires_at timestamp with time zone)`,
  `CREATE TABLE market.disputes (
    id text NOT NULL, listing_id text NOT NULL, transaction_id text NOT NULL,
    buyer_did text NOT NULL, seller_did text NOT NULL, type text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL, resolution text,
    buyer_evidence jsonb DEFAULT '[]'::jsonb, seller_evidence jsonb DEFAULT '[]'::jsonb,
    evidence_deadline timestamp with time zone, resolved_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now())`,
  `CREATE TABLE market.seller_settings (
    did text NOT NULL, show_market_items boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now())`,
  'ALTER TABLE ONLY market.disputes ADD CONSTRAINT disputes_pkey PRIMARY KEY (id)',
  'ALTER TABLE ONLY market.listings ADD CONSTRAINT listings_pkey PRIMARY KEY (id)',
  'ALTER TABLE ONLY market.seller_settings ADD CONSTRAINT seller_settings_pkey PRIMARY KEY (did)',
  'CREATE INDEX idx_market_listings_category_status ON market.listings USING btree (category, status)',
  'CREATE INDEX idx_market_listings_seller_did ON market.listings USING btree (seller_did)',
  'CREATE INDEX idx_market_listings_status_created ON market.listings USING btree (status, created_at)',
  `ALTER TABLE ONLY market.disputes ADD CONSTRAINT disputes_listing_id_listings_id_fk
     FOREIGN KEY (listing_id) REFERENCES market.listings(id)`,
];

const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)('migrate-baseline against a real Postgres', () => {
  let admin: postgres.Sql;
  let dbName: string;
  let url: string;
  let sql: postgres.Sql;

  beforeEach(async () => {
    admin = postgres(databaseUrl as string, { max: 1, onnotice: () => {} });
    dbName = `market_baseline_${randomBytes(6).toString('hex')}`;
    await admin.unsafe(`CREATE DATABASE ${dbName}`);
    const parsed = new URL(databaseUrl as string);
    parsed.pathname = `/${dbName}`;
    url = parsed.toString();
    sql = postgres(url, { max: 1, onnotice: () => {} });
  });

  afterEach(async () => {
    await sql.end({ timeout: 5 });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end({ timeout: 5 });
  });

  async function seedProdLike() {
    for (const statement of PROD_LIKE_SCHEMA_SQL) {
      await sql.unsafe(statement);
    }
    await sql.unsafe(
      `INSERT INTO market.listings (id, seller_did, title, price) VALUES ('l1', 'did:imajin:a', 'Bike', 5000)`,
    );
    await sql.unsafe(
      `INSERT INTO market.disputes (id, listing_id, transaction_id, buyer_did, seller_did, type)
       VALUES ('d1', 'l1', 'tx1', 'did:imajin:b', 'did:imajin:a', 'not_as_described')`,
    );
    await sql.unsafe(`INSERT INTO market.seller_settings (did) VALUES ('did:imajin:a')`);
  }

  async function rowCounts() {
    const [row] = await sql.unsafe(
      `SELECT (SELECT count(*) FROM market.listings)::int AS listings,
              (SELECT count(*) FROM market.disputes)::int AS disputes,
              (SELECT count(*) FROM market.seller_settings)::int AS seller_settings`,
    );
    return row;
  }

  const SEEDED_COUNTS = { listings: 1, disputes: 1, seller_settings: 1 };

  async function trackingRows() {
    return sql.unsafe(`SELECT hash, created_at FROM ${TRACKING} ORDER BY id`);
  }

  async function trackingExists() {
    const [row] = await sql.unsafe(`SELECT to_regclass('${TRACKING}') IS NOT NULL AS present`);
    return row.present as boolean;
  }

  /** Wraps the client so every statement the baseline issues can be audited. */
  function recording(statements: string[]) {
    return {
      begin: (fn: (tx: unknown) => Promise<unknown>) =>
        sql.begin((tx) =>
          fn({
            unsafe: (text: string, params?: unknown[]) => {
              statements.push(text);
              return tx.unsafe(text, params as never);
            },
          }),
        ),
    };
  }

  describe('baselining an existing, prod-shaped schema', () => {
    it('records migration 0000 and leaves every table and row untouched', async () => {
      await seedProdLike();
      const before = await rowCounts();
      const expected = await readBaselineMigration(MIGRATIONS_FOLDER);

      const result = await run(sql);

      expect(result).toEqual({ status: 'baselined', tag: expected.tag });
      expect(await rowCounts()).toEqual(before);
      const rows = await trackingRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].hash).toBe(expected.hash);
      expect(Number(rows[0].created_at)).toBe(expected.when);
    });

    it('is idempotent — a second and third run change nothing', async () => {
      await seedProdLike();
      await run(sql);

      const second = await run(sql);
      const third = await run(sql);

      expect(second.status).toBe('already-baselined');
      expect(third.status).toBe('already-baselined');
      expect(await trackingRows()).toHaveLength(1);
      expect(await rowCounts()).toEqual(SEEDED_COUNTS);
    });

    it('leaves drizzle migrate a clean no-op afterwards (no CREATE TABLE collision)', async () => {
      await seedProdLike();
      await run(sql);

      await migrate(drizzle(sql), { migrationsFolder: MIGRATIONS_FOLDER, migrationsSchema: SCHEMA });

      expect(await rowCounts()).toEqual(SEEDED_COUNTS);
      expect(await trackingRows()).toHaveLength(1);
    });

    it('without the baseline, migrate fails on the existing schema (why this script exists)', async () => {
      await seedProdLike();
      await expect(
        migrate(drizzle(sql), { migrationsFolder: MIGRATIONS_FOLDER, migrationsSchema: SCHEMA }),
      ).rejects.toThrow();
    });

    it('accepts a schema produced by migration 0000 itself (expectation cannot drift from the SQL)', async () => {
      await migrate(drizzle(sql), { migrationsFolder: MIGRATIONS_FOLDER, migrationsSchema: SCHEMA });
      expect((await run(sql)).status).toBe('already-baselined');

      // Same schema, but without drizzle's record of it: must validate and baseline.
      await sql.unsafe(`DROP TABLE ${TRACKING}`);
      expect((await run(sql)).status).toBe('baselined');
    });

    it('dry run validates but writes nothing', async () => {
      await seedProdLike();

      const result = await run(sql, { dryRun: true });

      expect(result.status).toBe('would-baseline');
      expect(await trackingExists()).toBe(false);
    });

    it('ignores an empty tracking table that already lives in the app schema', async () => {
      await seedProdLike();
      await sql.unsafe(
        `CREATE TABLE ${TRACKING} (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`,
      );

      expect((await run(sql)).status).toBe('baselined');
      expect((await run(sql)).status).toBe('already-baselined');
    });
  });

  describe('fresh database', () => {
    it('does nothing and creates nothing, leaving the schema to db:migrate', async () => {
      const statements: string[] = [];

      const result = await run(recording(statements));

      expect(result.status).toBe('fresh-database');
      expect(statements.filter((s) => !/^\s*SELECT\b/i.test(s))).toEqual([]);
      const [schemas] = await sql.unsafe(`SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = 'market'`);
      expect(schemas.n).toBe(0);
      await migrate(drizzle(sql), { migrationsFolder: MIGRATIONS_FOLDER, migrationsSchema: SCHEMA });
      expect((await run(sql)).status).toBe('already-baselined');
    });
  });

  describe('refuses on mismatch', () => {
    async function expectRefusal(pattern: RegExp) {
      const before = await rowCounts();
      await expect(run(sql)).rejects.toBeInstanceOf(BaselineMismatchError);
      await expect(run(sql)).rejects.toThrow(pattern);
      expect(await trackingExists()).toBe(false);
      expect(await rowCounts()).toEqual(before);
    }

    it('when a column is missing', async () => {
      await seedProdLike();
      await sql.unsafe('ALTER TABLE market.listings DROP COLUMN image_asset_ids');
      await expectRefusal(/listings\.image_asset_ids: column is missing/);
    });

    it('when a column has an unexpected type', async () => {
      await seedProdLike();
      await sql.unsafe('ALTER TABLE market.listings ALTER COLUMN title TYPE varchar(100)');
      await expectRefusal(/listings\.title: type is character varying\(100\), expected text/);
    });

    it('when an unknown table lives in the app schema', async () => {
      await seedProdLike();
      await sql.unsafe('CREATE TABLE market.stray (id text)');
      await expectRefusal(/stray: unexpected table/);
    });

    it('when the foreign key is missing', async () => {
      await seedProdLike();
      await sql.unsafe('ALTER TABLE market.disputes DROP CONSTRAINT disputes_listing_id_listings_id_fk');
      await expectRefusal(/disputes: foreign keys/);
    });

    it('when a required index is missing', async () => {
      await seedProdLike();
      await sql.unsafe('DROP INDEX market.idx_market_listings_status_created');
      await expectRefusal(/idx_market_listings_status_created is missing/);
    });

    it('when the schema exists but is empty', async () => {
      await sql.unsafe('CREATE SCHEMA market');
      await expect(run(sql)).rejects.toThrow(/listings: table is missing/);
      expect(await trackingExists()).toBe(false);
    });

    it('when the tracking table holds history that does not include migration 0000', async () => {
      await seedProdLike();
      await sql.unsafe(
        `CREATE TABLE ${TRACKING} (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`,
      );
      await sql.unsafe(`INSERT INTO ${TRACKING} (hash, created_at) VALUES ('someone-elses-hash', 1)`);

      await expect(run(sql)).rejects.toThrow(/unrecognised migration history/);
      expect(await trackingRows()).toHaveLength(1);
    });

    it('when APP_DB_SCHEMA is not a safe identifier', () => {
      expect(() =>
        runBaseline(sql as unknown as RunnerSql, {
          schema: 'market; DROP SCHEMA market',
          migrationsFolder: MIGRATIONS_FOLDER,
        }),
      ).toThrow(/APP_DB_SCHEMA must match/);
    });
  });

  describe('never drops, truncates, or alters anything', () => {
    const DESTRUCTIVE = /\b(DROP|TRUNCATE|ALTER|DELETE|UPDATE|GRANT|REVOKE|RENAME)\b/i;
    const APP_TABLE = /\bmarket\s*\.\s*"?(listings|disputes|seller_settings)\b/i;

    it('only ever issues SELECTs plus create-only bookkeeping DDL (successful run)', async () => {
      await seedProdLike();
      const statements: string[] = [];

      await run(recording(statements));

      expect(statements.length).toBeGreaterThan(0);
      for (const statement of statements) {
        expect(statement).not.toMatch(DESTRUCTIVE);
        expect(statement).not.toMatch(APP_TABLE);
      }
      const writes = statements.filter((s) => !/^\s*(SELECT|WITH)\b/i.test(s));
      expect(writes).toHaveLength(3);
      expect(writes[0]).toMatch(/^CREATE SCHEMA IF NOT EXISTS "market"$/);
      expect(writes[1]).toMatch(/^CREATE TABLE IF NOT EXISTS "market"\."__drizzle_migrations"/);
      expect(writes[2]).toMatch(/^INSERT INTO "market"\."__drizzle_migrations"/);
    });

    it('issues no write at all when it refuses', async () => {
      await seedProdLike();
      await sql.unsafe('ALTER TABLE market.listings DROP COLUMN description');
      const statements: string[] = [];

      await expect(run(recording(statements))).rejects.toBeInstanceOf(BaselineMismatchError);

      expect(statements.filter((s) => !/^\s*(SELECT|WITH)\b/i.test(s))).toEqual([]);
    });

    it('issues no write at all when already baselined', async () => {
      await seedProdLike();
      await run(sql);
      const statements: string[] = [];

      await run(recording(statements));

      expect(statements.filter((s) => !/^\s*(SELECT|WITH)\b/i.test(s))).toEqual([]);
    });
  });

  describe('CLI end to end', () => {
    const cli = (args: string[] = []) =>
      spawnSync(process.execPath, [CLI, ...args], {
        env: childEnv({ DATABASE_URL: url, APP_DB_SCHEMA: SCHEMA }),
        encoding: 'utf8',
      });

    it('exit 0 and a no-op on the second run; exit 1 and no change on a mismatch', async () => {
      await seedProdLike();

      const first = cli();
      expect(first.status).toBe(0);
      expect(first.stdout).toMatch(/Baselined: recorded 0000_market_schema/);

      const second = cli();
      expect(second.status).toBe(0);
      expect(second.stdout).toMatch(/Already baselined/);
      expect(await trackingRows()).toHaveLength(1);

      await sql.unsafe(`DELETE FROM ${TRACKING}`);
      await sql.unsafe('ALTER TABLE market.listings DROP COLUMN description');
      const refused = cli();
      expect(refused.status).toBe(1);
      expect(refused.stderr).toMatch(/listings\.description: column is missing/);
      expect(refused.stderr).toMatch(/Nothing was changed/);
      expect(await trackingRows()).toHaveLength(0);
      expect(refused.stdout + refused.stderr).not.toContain(url);
    });

    it('--dry-run reports and writes nothing', async () => {
      await seedProdLike();
      const result = cli(['--dry-run']);
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/Dry run: live schema matches/);
      expect(await trackingExists()).toBe(false);
    });

    it('exit 2 on a connection failure, without leaking the URL', () => {
      const result = spawnSync(process.execPath, [CLI], {
        env: childEnv({ DATABASE_URL: 'postgres://u:supersecretvalue@127.0.0.1:1/db', APP_DB_SCHEMA: SCHEMA }),
        encoding: 'utf8',
      });
      expect(result.status).toBe(2);
      expect(result.stdout + result.stderr).not.toContain('supersecretvalue');
    });
  });
});
