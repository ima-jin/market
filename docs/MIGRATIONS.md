# Migrations — ownership rule

This app manages its own database with `drizzle-orm` + `drizzle-kit`, entirely separate from
the Imajin kernel's own database.

## The rule (ima-jin/imajin-ai#1991)

> An app owns tables only in its own Postgres schema. Cross-schema access from an app is a
> contract violation — it goes through the kernel API instead.

Concretely, for this app:

- This app owns exactly **one** Postgres schema, named by the `APP_DB_SCHEMA` env var
  (see `.env.example`). `src/db/schema.ts` defines every table inside that schema via
  `pgSchema(process.env.APP_DB_SCHEMA)` — there is no path to creating a table outside it.
- This app **never** connects to, queries, or migrates a kernel-owned schema (`registry`,
  `auth`, `profile`, …) or another app's schema. Every interaction with kernel-owned data goes
  through the kernel's public HTTP API (`IMAJIN_AUTH_URL`), authenticated the same way any
  other caller would be — see `docs/REGISTRATION.md` and `AGENTS.md` §2.
- `DATABASE_URL` in this app's own `.env.local` points at this app's own Postgres database (or
  a database this app has been granted a role scoped to `APP_DB_SCHEMA` in) — never the
  kernel's database.
- `APP_DB_SCHEMA` is set once, at registration time, and never changed afterwards. Renaming it
  would orphan every existing migration's tracking state.

## Workflow

```bash
pnpm db:generate   # diff src/db/schema.ts against migrations/ and write new SQL
pnpm db:migrate     # apply pending migrations in migrations/ to DATABASE_URL
pnpm db:studio      # browse this app's own schema
```

`migrations/` is committed. `drizzle.config.ts` scopes `drizzle-kit` to `APP_DB_SCHEMA` only
(`schemaFilter`), so `pnpm db:generate` can never emit a migration for a table outside this
app's own schema.

## This app's tables (`APP_DB_SCHEMA=market`)

`migrations/0000_market_schema.sql` creates the `market` schema and the tables ported from the
kernel's shared `migrations/0001_seed.sql` (ima-jin/imajin-ai#2509): `market.listings`,
`market.disputes` (FK to `market.listings`) and `market.seller_settings`, plus the three
`idx_market_listings_*` indexes. The DDL is column-for-column the same as the kernel's.

- The migration begins with `CREATE SCHEMA IF NOT EXISTS` (hand-edited from drizzle-kit's plain
  `CREATE SCHEMA`) because `drizzle.config.ts` keeps drizzle's own tracking table
  (`market.__drizzle_migrations`) inside the app schema too — drizzle creates that schema before
  it runs the first migration. Keep the `IF NOT EXISTS` if you ever regenerate `0000`.
- Nothing is written to `public`, `drizzle`, or any kernel schema. `scripts/verify-migrations.mjs`
  (run in CI against a real Postgres) asserts exactly that.
- Existing data is not moved by this repo: this step only defines the schema. Cut-over of live
  rows is a separate step of ima-jin/imajin-ai#1989.

## What this app does not do

- It does not squash, rewrite, or otherwise manage the kernel's own migration history — that is
  the kernel repo's concern (imajin-ai#1991's baseline-squash work), not this app's.
- It does not read another app's schema directly, even for apps that happen to share a Postgres
  instance in some deployments. If you need data another app owns, that app's owner exposes it
  through a kernel-consumed API — ask for that API, don't reach for its tables.
