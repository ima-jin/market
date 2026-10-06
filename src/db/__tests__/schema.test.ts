import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { disputes, listings, sellerSettings } from '../schema';

const migrationsDir = join(process.cwd(), 'migrations');
const migrationSql = readdirSync(migrationsDir)
  .filter((name) => name.endsWith('.sql'))
  .map((name) => readFileSync(join(migrationsDir, name), 'utf-8'))
  .join('\n');

describe('market schema', () => {
  it('defines every table in the APP_DB_SCHEMA schema', () => {
    for (const table of [listings, disputes, sellerSettings]) {
      expect(getTableConfig(table).schema).toBe('market');
    }
  });

  it('defines the ported table names', () => {
    expect(getTableConfig(listings).name).toBe('listings');
    expect(getTableConfig(disputes).name).toBe('disputes');
    expect(getTableConfig(sellerSettings).name).toBe('seller_settings');
  });

  it('keeps the listing indexes from the kernel schema', () => {
    const names = getTableConfig(listings).indexes.map((index) => index.config.name);
    expect(names.sort()).toEqual([
      'idx_market_listings_category_status',
      'idx_market_listings_seller_did',
      'idx_market_listings_status_created',
    ]);
  });

  it('links disputes to listings', () => {
    const foreignKeys = getTableConfig(disputes).foreignKeys;
    expect(foreignKeys).toHaveLength(1);
    expect(getTableConfig(foreignKeys[0].reference().foreignTable).name).toBe('listings');
  });
});

describe('market migrations', () => {
  it('creates the market schema idempotently', () => {
    expect(migrationSql).toContain('CREATE SCHEMA IF NOT EXISTS "market";');
  });

  it('creates all three tables', () => {
    for (const table of ['listings', 'disputes', 'seller_settings']) {
      expect(migrationSql).toContain(`CREATE TABLE "market"."${table}"`);
    }
  });

  it('never references another schema', () => {
    const qualified = migrationSql.match(/"([a-z_]+)"\."[a-z_]+"/g) ?? [];
    expect(qualified.length).toBeGreaterThan(0);
    for (const ref of qualified) {
      expect(ref.startsWith('"market".')).toBe(true);
    }
    expect(migrationSql).not.toMatch(/\bpublic\./);
  });
});
