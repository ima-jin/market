# Deploying market (prod + dev)

market is deployed from **this repo**, as its own pm2 process behind the kernel host's Caddy. Nothing in
`ima-jin/imajin-ai` builds, migrates, or restarts it any more (imajin-ai#1989). Everything here goes through the
registered-app contract: a kernel-minted app identity, the published `@ima-jin/*` SDK, and the kernel's public HTTP
API. This repo never imports kernel internals and never touches a kernel schema.

| | dev | prod |
|---|---|---|
| pm2 process | `dev-market` | `prod-market` |
| Checkout on the server | `~/dev/market` | `~/prod/market` |
| Local port | `3104` | `7104` |
| Public URL | `https://dev-jin.imajin.ai/market` | `https://jin.imajin.ai/market` |
| Health | `http://127.0.0.1:3104/market/api/health` | `http://127.0.0.1:7104/market/api/health` |
| Env file | `~/dev/market/.env.local` (from `.env.dev.example`) | `~/prod/market/.env.local` (from `.env.prod.example`) |

The ports and the Caddy route are the ones the monorepo's `apps/market` already used (`dev-market` 3104,
`prod-market` 7104), so no proxy change is needed.

## The one command

From the target's checkout on the server:

```bash
scripts/deploy.sh dev     # or: scripts/deploy.sh prod
scripts/deploy.sh prod --ref v0.2.0   # a specific tag / sha (this is also the rollback)
scripts/deploy.sh prod --dry-run      # print the plan, execute nothing
```

It is fail-fast: any failure before step 7 stops the deploy and the running process keeps serving the previous
build. The env file is the single source of truth: contract variables exported in the calling shell are ignored
(and listed by name), because `node --env-file` and `pm2 --update-env` would otherwise let a stray `DATABASE_URL`
win. Note that step 2 swaps in the new ref's `deploy.sh`, so a change to the script itself takes effect from the
*next* run.

1. **preflight** — `git`, `node` (>= `.nvmrc`), `pnpm`, `pm2`, `curl` on `PATH`; no local changes to tracked files;
   `.env.local` exists; no stale `pm2` entry of the same name pointing at a different path (see
   [cutover](#one-time-cutover-checklist)).
2. **checkout** — `git fetch --tags --prune`, then `git checkout --detach` the ref (default `origin/main`). Never
   `git pull`.
3. **env check** — `scripts/check-env.mjs <target>` validates `.env.local` for the target (names only, never values).
   See [ENVIRONMENTS.md](./ENVIRONMENTS.md).
4. **install** — `pnpm install --frozen-lockfile`.
5. **build** — `next build` with `.env.local` loaded, so `NEXT_PUBLIC_*` values are baked in.
6. **baseline + migrate** — `scripts/migrate-baseline.mjs` (idempotent; refuses on mismatch), then
   `drizzle-kit migrate` (forward-only). See [Migration baseline](#migration-baseline).
7. **restart** — `pm2 startOrReload ecosystem.config.cjs --only <prod|dev>-market --update-env`, then `pm2 save`.
8. **health** — polls `/market/api/health` for up to 60 s and requires `"status":"ok"`. A non-healthy result exits
   non-zero. (The endpoint proves the process booted — `instrumentation.ts` refuses to start without a valid
   identity — but does not query the database.)

## First deploy of an environment (fresh checkout)

There is no checkout of this repo on the server yet. After the operator steps below are done, it is still one
command per environment:

```bash
git clone https://github.com/ima-jin/market.git ~/prod/market && cd ~/prod/market
cp .env.prod.example .env.local && chmod 600 .env.local   # then fill in the placeholders
scripts/deploy.sh prod
```

Use `~/dev/market` and `.env.dev.example` / `scripts/deploy.sh dev` for dev. Deploy **dev first** and confirm
`https://dev-jin.imajin.ai/market/api/health` before touching prod.

### Operator steps this repo cannot do

- **Mint the app identity** — separately for dev and prod, through the kernel's claim flow. See
  [Identity](#identity-the-claim-flow) below and [REGISTRATION.md](./REGISTRATION.md). Minting happens on the kernel
  side (the operator's `/jin` approval card); this repo only redeems the resulting one-time code.
- **Create the databases/roles** and put the connection strings in each `.env.local`. Prod/dev already contain the
  `market` schema; the baseline adopts it in place.
- **Generate the secrets** (`SESSION_SECRET`, `WEBHOOK_SECRET`: `openssl rand -hex 32`, distinct per environment) and
  configure the same `WEBHOOK_SECRET` on the kernel pay service's webhook for that environment.
- **Caddy** — the route already exists; verify it against the [snippet below](#caddy).

### One-time cutover checklist

1. Back up the `market` schema (`pg_dump --schema=market …`) before the first prod run.
2. `pm2 delete prod-market && pm2 save` (and `dev-market`) if an old entry still points at the monorepo's
   `~/prod/imajin-ai/apps/market` path. `deploy.sh` refuses to run while a same-named entry points elsewhere, because
   pm2 would "reload" it with the old script and cwd. Removing old entries is deliberately never automatic.
3. Dry-run the baseline against the real database first:
   `node --env-file=.env.local scripts/migrate-baseline.mjs --dry-run`.
4. `scripts/deploy.sh dev`, verify, then `scripts/deploy.sh prod`.

## Identity (the claim flow)

Each environment is a **separate registered app** with its own DID, claim code and keystore. No key is hand-made and
no key material is ever put in `.env.local` (the app refuses to boot if `IMAJIN_APP_PRIVATE_KEY` is set).

1. The operator approves the app on the kernel's `/jin` card (`apps.provision`) for that environment's kernel
   (`https://dev-jin.imajin.ai` / `https://jin.imajin.ai`). The kernel returns the app's `did:imajin:…` and a
   **one-time claim code**.
2. Put the DID in `IMAJIN_APP_DID` and the claim code in `IMAJIN_APP_CLAIM_CODE` in that environment's `.env.local`,
   then deploy. On first boot `instrumentation.ts` calls `loadAppSigningKey()`, which spends the code and writes a
   `0600` bootstrap keystore at `IMAJIN_APP_KEYSTORE` (persistent, separate per environment).
3. **Delete `IMAJIN_APP_CLAIM_CODE`** from `.env.local` once the app is healthy — it is spent. Every later boot
   re-authenticates with the keystore alone. `check-env.mjs` warns while the code is still set.
4. A lost keystore (disk wipe, fresh host) needs a fresh code: ask the operator to re-approve with
   `reissueClaim: true`.

`check-env.mjs` fails while `IMAJIN_APP_DID` is still the `REPLACE_ME` placeholder, and no script in this repo prints
the claim code or any key material.

## Migration baseline

The existing `market` schema was created by the monorepo's shared root migrations (`migrations/0001_seed.sql`),
long before this repo had its own drizzle history. This repo's `migrations/0000_market_schema.sql` uses plain
`CREATE TABLE`, so a bare `pnpm db:migrate` against prod/dev would fail immediately.
`scripts/migrate-baseline.mjs` bridges that:

```bash
node --env-file=.env.local scripts/migrate-baseline.mjs            # baseline (what deploy.sh runs)
node --env-file=.env.local scripts/migrate-baseline.mjs --dry-run  # validate only, write nothing
```

- **Uses the repo's own migrations.** It reads `migrations/meta/_journal.json` and records the first entry
  (`0000_market_schema`) exactly the way drizzle's migrator does (sha256 of the SQL file + the journal `when`), in
  drizzle's own tracking table `"market"."__drizzle_migrations"` (`drizzle.config.ts` keeps it inside the app
  schema). `drizzle-kit migrate` then applies only what is newer.
- **Idempotent.** If migration 0000 is already recorded it does nothing and exits 0, so `deploy.sh` runs it every
  time.
- **Refuses on mismatch.** It introspects the live `market` schema (tables, columns, types, nullability, defaults,
  primary/unique keys, the `disputes → listings` foreign key and its actions, required indexes) and compares it with
  what migration 0000 produces. Any difference — missing/extra table or column, wrong type, missing FK or index, or
  unrecognised rows already in the tracking table — exits **1** with a list of the problems and changes nothing.
  Column order and extra indexes are tolerated. Reconcile the schema by hand; never force it.
- **Never drops, truncates, or alters.** The app tables are only ever read (`pg_catalog` SELECTs). The only writes
  are `CREATE SCHEMA/TABLE IF NOT EXISTS` for drizzle's tracking table and one `INSERT` of the 0000 hash, in one
  transaction under an advisory lock. The test suite asserts this by auditing every statement issued.
- **Fresh databases** (no `market` schema) are left alone: it reports "nothing to baseline" and exits 0, and
  `drizzle-kit migrate` then creates everything.
- Exit codes: `0` ok · `1` refused (mismatch) · `2` usage/config/connection error. The connection string is never
  printed.

After the baseline, `drizzle-kit migrate` applies only migrations newer than 0000. Migrations are forward-only;
there is no down-migration. New migrations must be additive/guarded (`IF NOT EXISTS`) — see
[MIGRATIONS.md](./MIGRATIONS.md).

## pm2

`ecosystem.config.cjs` defines `prod-market` (7104) and `dev-market` (3104). Each entry execs
`node_modules/next/dist/bin/next start -p <port>` directly (never `npm start` — imajin-ai#2447: pm2 would track the
npm wrapper and orphan `next-server` on restart), loads `.env.local` with `node --env-file` (Node exits if the
file is missing, so a market with no env crashes loudly instead of booting without its identity), uses this
checkout as `cwd`, and logs to `~/.pm2/logs/<name>-out.log` / `<name>-error.log`. A checkout only ever starts its
own entry (`--only`).

```bash
pm2 logs prod-market --lines 100     # stdout (the app logs to stdout only)
pm2 describe prod-market
```

## Caddy

The route is unchanged from the monorepo era. The app is mounted under the `/market` basePath
(`NEXT_PUBLIC_BASE_PATH=/market`) and Caddy must forward the prefix **intact** — use `handle`, not `handle_path`
(which strips it):

```caddy
# prod — inside the existing jin.imajin.ai site block
jin.imajin.ai {
    @market path /market /market/*
    handle @market {
        reverse_proxy localhost:7104
    }
    # ...the rest of the site (kernel and other apps) unchanged
}

# dev — inside the existing dev-jin.imajin.ai site block
dev-jin.imajin.ai {
    @market path /market /market/*
    handle @market {
        reverse_proxy localhost:3104
    }
}
```

Verify: `curl -fsS https://jin.imajin.ai/market/api/health` → `{"status":"ok","service":"market",…}`.

The kernel delivers payment webhooks to `POST <public URL>/market/api/webhook` with
`Authorization: Bearer <WEBHOOK_SECRET>` (the only accepted scheme; the value must equal the kernel's
`MARKET_WEBHOOK_SECRET`); make sure the kernel side for each environment points at that environment's market URL.

### Settlement (`.fair` payouts)

Market settles purchases with its **own app-service token** — there is no shared pay key in the env. Operator
prerequisites per environment: the app is claimed (signing key bootstrapped, see above), and the operator has
**approved the `pay:settle` service scope for this app's DID** (propose it via `POST /api/apps/service-scopes`,
countersign on the `apps:service-scopes` card on `/jin`). Until then the token mint drops the scope, pay refuses
checkout/settle, and a purchase of a listing with a `.fair` chain fails closed with 503 rather than taking money that
could never settle. Set `NODE_DID` so the node fee resolves to this node.

## Rollback

Redeploy the previous tag or sha: `scripts/deploy.sh prod --ref <previous-tag>`. Migrations are forward-only, so a
rollback is only safe while migrations stay additive.

## Troubleshooting

- **`baseline` exits 1** — the message lists exactly what differs. Do not edit the script to force it; fix the schema
  (or tell the app owner the schema drifted), then re-run.
- **`env check` fails** — each line names a variable; see [ENVIRONMENTS.md](./ENVIRONMENTS.md).
- **Health never goes green on a first boot** — `pm2 logs <name>`: a used/rejected `IMAJIN_APP_CLAIM_CODE` or wrong
  `IMAJIN_APP_DID` fails at `instrumentation.ts`. The dev and prod instances must each have their own DID, claim
  code and keystore.
- **Login loops on dev only** — `IMAJIN_ENV=dev` is missing (wrong session cookie name).
- **`/dashboard` redirects to the prod kernel from dev** — `NEXT_PUBLIC_SERVICE_PREFIX=dev-` was not set at build
  time; set it and redeploy.
- **Purchases return 500** — `PAY_SERVICE_URL` is unset; **payment webhooks are rejected (401)** — `WEBHOOK_SECRET` is
  unset or differs from the kernel's `MARKET_WEBHOOK_SECRET`, or the caller is not sending it as `Authorization: Bearer`.
- **Purchases of `.fair` listings return 503** — market's app-service token cannot be minted: the app is unclaimed, or
  `IMAJIN_KERNEL_URL` is unset/wrong. **Purchases are paid but never settle** — the operator has not approved
  `pay:settle` for this app's DID.
