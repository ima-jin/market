# Environments — market

Every environment variable the market app reads — directly, through its `@ima-jin/*` dependencies, or in its
scripts — with what it does, when it is read, and its dev and prod values. This file, `.env.example`, and
`scripts/lib/env-manifest.mjs` are kept in lock-step by `scripts/__tests__/env-docs.test.ts`: CI fails if code
(or an installed `@ima-jin/*` package) starts reading a variable that is not documented here, or if this file is
not the output of `node scripts/gen-env-docs.mjs`.

No secret values live in this repo. Examples are shape-only placeholders; real values live in the untracked
`.env.local` on each host. Key material is never an env var: this app's signing key is fetched at boot through the
kernel claim flow ([REGISTRATION.md](./REGISTRATION.md)).

## The env files

| File | Used for | Lands at |
|---|---|---|
| `.env.example` | local development (`pnpm dev`) | `.env.local` in your working copy |
| `.env.dev.example` | the dev deployment (`dev-market`, port 3104, `https://dev-jin.imajin.ai/market`) | `~/dev/market/.env.local` |
| `.env.prod.example` | the prod deployment (`prod-market`, port 7104, `https://jin.imajin.ai/market`) | `~/prod/market/.env.local` |

On a server: `cp .env.<env>.example .env.local && chmod 600 .env.local`, fill the placeholders, then
`node scripts/check-env.mjs <prod|dev>`. `scripts/deploy.sh` runs that check for you on every deploy, and pm2 loads
the same file with `node --env-file` (see `ecosystem.config.cjs`). The check prints variable names only, never values.

## Build-time vs runtime

`next build` bakes every `NEXT_PUBLIC_*` value into the build (including `next.config.js`'s `basePath` and the
`/dashboard` redirect). **Changing one means rebuilding** — `scripts/deploy.sh` loads the env file for the build, so
a normal deploy handles it. Variables marked *runtime* are read when the process starts or per request; a
`pm2 restart --update-env` is enough.

## Dev vs prod at a glance

- **Kernel host.** Dev talks only to `https://dev-jin.imajin.ai`; prod only to `https://jin.imajin.ai`.
  `check-env.mjs` rejects a dev file pointing at a non-`dev-` host and a prod file pointing at a `dev-` host.
- **`IMAJIN_ENV` and `NEXT_PUBLIC_SERVICE_PREFIX`.** `dev` / `dev-` on dev, **unset** on prod. A production build is
  `NODE_ENV=production` on both, so these are what tell dev from prod.
- **Database.** Separate Postgres database per environment; the schema name is `market` in both.
- **Identity.** Each environment has its own app DID, claim code and keystore file (`IMAJIN_APP_KEYSTORE`).
- **Secrets.** `SESSION_SECRET` and `WEBHOOK_SECRET` differ per environment.
- **Port.** dev 3104, prod 7104 (from `ecosystem.config.cjs`, not the env file).

## Required on every deployed instance

| Variable | When | Dev | Prod | Notes |
|---|---|---|---|---|
| `DATABASE_URL` (secret) | runtime | `postgres://<role>:<password>@localhost:5432/<dev_db>` | `postgres://<role>:<password>@localhost:5432/<prod_db>` | Postgres connection string for this app's own database (also read by drizzle-kit and scripts/migrate-baseline.mjs). Never a kernel database. |
| `APP_DB_SCHEMA` | runtime | `market` | `market` | The one Postgres schema this app owns. Fixed to `market` — the existing prod/dev schema; never change it (it would orphan migration state). |
| `AUTH_SERVICE_URL` | runtime | `https://dev-jin.imajin.ai/auth` | `https://jin.imajin.ai/auth` | Kernel auth service base URL, including the /auth prefix. Read by @ima-jin/auth for session and app-token verification. |
| `IMAJIN_AUTH_URL` | runtime | `https://dev-jin.imajin.ai` | `https://jin.imajin.ai` | Kernel base URL for the Sign-in-with-Imajin flow (src/lib/auth-config.ts). Same host as IMAJIN_KERNEL_URL. |
| `IMAJIN_KERNEL_URL` | runtime | `https://dev-jin.imajin.ai` | `https://jin.imajin.ai` | Kernel base URL (no path). Used by loadAppSigningKey() to fetch this app's signing key at boot, and by the kernel client. |
| `PAY_SERVICE_URL` | runtime | `https://dev-jin.imajin.ai/pay` | `https://jin.imajin.ai/pay` | Kernel pay service base URL, including the /pay prefix. Checkout sessions are created with POST {PAY_SERVICE_URL}/api/checkout; purchases fail with a 500 while it is unset. |
| `WEBHOOK_SECRET` (secret) | runtime | (32+ random bytes — openssl rand -hex 32) | (32+ random bytes — openssl rand -hex 32) | Shared secret the pay service sends with payment webhooks (POST /api/webhook). The webhook rejects every request while it is unset. 32+ random bytes; set the same value on the pay side. Never the dev value on prod. |
| `SESSION_SECRET` (secret) | runtime | (32+ random bytes — openssl rand -hex 32) | (32+ random bytes — openssl rand -hex 32) | Signs this app's session cookie (HS256, @ima-jin/auth-client). 32+ random bytes; distinct per environment. |
| `NEXT_PUBLIC_BASE_PATH` | build | `/market` | `/market` | Reverse-proxy path prefix the app is mounted under. Must be `/market`. Baked at build time; rebuild after changing. |
| `NEXT_PUBLIC_APP_URL` | runtime | `https://dev-jin.imajin.ai/market` | `https://jin.imajin.ai/market` | This app's public URL. Its HOST is the `aud` used to verify scoped app tokens — it must match a host in this app's registered tokenAudiences (operator-confirmed at registration). |
| `NEXT_PUBLIC_AUTH_URL` | build | `https://dev-jin.imajin.ai/auth` | `https://jin.imajin.ai/auth` | Public URL of the kernel auth service the browser talks to (the "enter your email to buy" gate: GET /api/session, POST /api/onboard). Includes the /auth prefix. Baked at build time. |
| `IMAJIN_APP_DID` | runtime | `did:imajin:<dev app DID>` | `did:imajin:<prod app DID>` | This app's own did:imajin:… from registration (docs/REGISTRATION.md). instrumentation.ts refuses to boot without it. Not a secret. Separate DID for dev and prod. |

## First boot only

| Variable | When | Dev | Prod | Notes |
|---|---|---|---|---|
| `IMAJIN_APP_CLAIM_CODE` (secret) | runtime | (only on first boot) | (only on first boot) | One-time code from the kernel operator's /jin approval card. Needed only on the very first boot (no keystore yet) or a lost-keystore rebind; delete it after the first successful boot. |

## Optional

| Variable | When | Dev | Prod | Notes |
|---|---|---|---|---|
| `NEXT_PUBLIC_SERVICE_PREFIX` | build | `dev-` | (unset) | Read by @ima-jin/config to build kernel/chat/media public URLs, including the /dashboard -> kernel hub redirect in middleware.ts. MUST be `dev-` on the dev instance (otherwise the redirect points at the prod kernel); leave unset on prod. Baked at build time; rebuild after changing. |
| `NEXT_PUBLIC_DOMAIN` | build | `imajin.ai` | `imajin.ai` | Companion to NEXT_PUBLIC_SERVICE_PREFIX (default imajin.ai). Leave at the default on both environments. |
| `NEXT_PUBLIC_MEDIA_URL` | build | `https://dev-jin.imajin.ai/media` | `https://jin.imajin.ai/media` | Public base URL of the kernel media service, used to turn asset_* image refs into URLs and as the image-upload target (ima-jin/imajin-ai#2637). When unset it is derived from the service prefix/domain. |
| `NEXT_PUBLIC_NODE_DID` | build | (optional) | (optional) | This node's DID, shown in the .fair attribution accordion on a listing. Optional. |
| `IMAJIN_ENV` | runtime | `dev` | (unset) | Selects the kernel session cookie name in @ima-jin/config: `dev` -> imajin_session_dev, anything else -> imajin_session. MUST be `dev` on the dev instance (a production build is NODE_ENV=production, which does not imply dev); leave unset on prod. |
| `IMAJIN_APP_KEYSTORE` | runtime | `/home/jin/.imajin/market.dev.keystore.json` | `/home/jin/.imajin/market.prod.keystore.json` | Path of this app's 0600 bootstrap keystore (never the vault key itself). Default ./.imajin/keystore.json relative to the process cwd. Must be writable, persist across deploys, and be separate for dev and prod. |
| `LOG_LEVEL` | runtime | `debug` | `info` | pino log level for @ima-jin/logger (default info). Output is stdout only; pm2 captures it. |
| `ENABLE_REQUEST_LOG` | runtime | (unset) | (unset) | Logger request-log switch. Leave unset: this app wires no log sink (AGENTS.md — stdout only). |
| `ENABLE_APP_LOG` | runtime | (unset) | (unset) | Logger persisted-log switch. Leave unset: this app never persists logs to a database. |
| `LOG_DB_TRANSPORT` | runtime | (unset) | (unset) | Logger DB-transport switch. Leave unset: logging must never touch a data store (AGENTS.md). |
| `APP_LOG_LEVEL` | runtime | (unset) | (unset) | Minimum level the logger would persist (default warn). Inert while persistence is off. |
| `NEXT_PUBLIC_VERSION` | build | (unset) | (unset) | @ima-jin/ui footer build stamp: version label (default `dev`). Cosmetic; may be set at build time. |
| `NEXT_PUBLIC_BUILD_HASH` | build | (unset) | (unset) | @ima-jin/ui footer build stamp: commit hash (default `local`). Cosmetic; may be set at build time. |
| `NEXT_PUBLIC_COMMIT_COUNT` | build | (unset) | (unset) | @ima-jin/ui footer build stamp: commit count (default empty). Cosmetic; may be set at build time. |
| `VERIFY_BOOT_PORT` | script | (unset) | (unset) | Reserved for a CI boot check; unused today. Not used in deployment. |

## Forbidden

| Variable | When | Dev | Prod | Notes |
|---|---|---|---|---|
| `IMAJIN_APP_PRIVATE_KEY` (secret) | runtime | (never set) | (never set) | Removed. The app throws at boot if this is set — the signing key comes from loadAppSigningKey(), never from env. |

## Set by Next.js / pm2 (never in the env file)

| Variable | When | Dev | Prod | Notes |
|---|---|---|---|---|
| `PORT` | runtime | `3104` | `7104` | Listen port. Set by the pm2 ecosystem entry (prod 7104, dev 3104); only used directly by `pnpm dev`. |
| `NODE_ENV` | runtime | `production` | `production` | Set to `production` by the pm2 entry and by `next build`/`next start`. Do not set it in the env file. |
| `NEXT_RUNTIME` | runtime | (set by Next.js) | (set by Next.js) | Injected by Next.js; instrumentation.ts only bootstraps the signing key when it is `nodejs`. Never set by hand. |

## Read by dependencies on paths market does not use (leave unset)

| Variable | When | Dev | Prod | Notes |
|---|---|---|---|---|
| `ATTESTATION_INTERNAL_API_KEY` (secret) | runtime | (unset) | (unset) | @ima-jin/auth act-as / attestation calls. market exercises neither; leave unset. Never hand-mint it. |
| `AUTH_INTERNAL_API_KEY` (secret) | runtime | (unset) | (unset) | Deprecated @ima-jin/auth internal key (agent delegation). Not used by market; leave unset. |
| `PROFILE_SERVICE_URL` | runtime | (unset) | (unset) | @ima-jin/auth credential resolution. Not used by market; leave unset. |
| `PROFILE_INTERNAL_API_KEY` (secret) | runtime | (unset) | (unset) | @ima-jin/auth credential resolution key. Not used by market; leave unset. |
| `NODE_DID` | runtime | (unset) | (unset) | @ima-jin/auth node-act-as check (kernel node DID). Not used by market; leave unset. |
| `APP_URL` | runtime | (unset) | (unset) | @ima-jin/auth fallback origin for redirects. market passes publicUrl explicitly (NEXT_PUBLIC_APP_URL); leave unset. |
| `NEXT_PUBLIC_BASE_URL` | runtime | (unset) | (unset) | @ima-jin/auth fallback origin for redirects (after APP_URL). market does not rely on it; leave unset. |
| `SESSION_COOKIE_SCOPE` | runtime | (unset) | (unset) | @ima-jin/config cookie-scope switch (`host` = host-only cookie). Leave unset: the shared kernel session cookie is the fallback auth path (docs/REGISTRATION.md section 6). |
| `REGISTRY_SERVICE_URL` | runtime | (unset) | (unset) | @ima-jin/config registry lookup. Not used by market; leave unset. |
| `REGISTRY_URL` | runtime | (unset) | (unset) | Deprecated alias of REGISTRY_SERVICE_URL in @ima-jin/config. Not used by market; leave unset. |
| `NEXT_PUBLIC_NOTIFY_URL` | build | (unset) | (unset) | @ima-jin/ui header: when set, shows the notification bell wired to the kernel notify service. Leave unset (no bell). |

## In the app template but unused here (safe to omit)

| Variable | When | Dev | Prod | Notes |
|---|---|---|---|---|
| `NEXT_PUBLIC_IMAJIN_AUTH_URL` | build | `https://dev-jin.imajin.ai` | `https://jin.imajin.ai` | Listed in the app template; no code in this repo reads it. Safe to omit. |
| `NEXT_PUBLIC_IMAJIN_APP_ID` | build | (optional) | (optional) | Listed in the app template (registry `app_…` id); no code in this repo reads it. Safe to omit. |
| `IMAJIN_APP_ATTESTATION_ID` | runtime | (optional) | (optional) | Listed in the app template (service-level attestation id for kernel calls outside a user session); no code in this repo reads it. Safe to omit. |

## Dev example

```dotenv
# market — DEV deployment env (dev-market, port 3104, https://dev-jin.imajin.ai/market)
# Copy to ~/dev/market/.env.local on the server (chmod 600) and fill the
# placeholders. Never commit the real file. Reference: docs/ENVIRONMENTS.md.
# Validate with: node scripts/check-env.mjs dev

# --- Build-time (baked in by `next build` — rebuild after changing) ---
NEXT_PUBLIC_BASE_PATH=/market
# MUST be `dev-` here: the /dashboard hub redirect and kernel-derived URLs.
NEXT_PUBLIC_SERVICE_PREFIX=dev-
NEXT_PUBLIC_DOMAIN=imajin.ai
NEXT_PUBLIC_AUTH_URL=https://dev-jin.imajin.ai/auth
NEXT_PUBLIC_MEDIA_URL=https://dev-jin.imajin.ai/media

# --- Runtime ---
# PORT and NODE_ENV come from the pm2 entry (ecosystem.config.cjs).
NEXT_PUBLIC_APP_URL=https://dev-jin.imajin.ai/market
# MUST be `dev` here: selects the imajin_session_dev cookie.
IMAJIN_ENV=dev

DATABASE_URL=postgres://market:CHANGE_ME@localhost:5432/imajin_dev
APP_DB_SCHEMA=market

# --- Kernel (public surface only) ---
AUTH_SERVICE_URL=https://dev-jin.imajin.ai/auth
IMAJIN_AUTH_URL=https://dev-jin.imajin.ai
IMAJIN_KERNEL_URL=https://dev-jin.imajin.ai
PAY_SERVICE_URL=https://dev-jin.imajin.ai/pay

# --- Secrets: generate with `openssl rand -hex 32`, distinct per environment ---
SESSION_SECRET=REPLACE_ME
WEBHOOK_SECRET=REPLACE_ME

# --- Identity (operator step: docs/REGISTRATION.md) ---
IMAJIN_APP_DID=did:imajin:REPLACE_ME
# First boot only — delete after the app has booted once.
# IMAJIN_APP_CLAIM_CODE=
# Persistent, per-environment keystore (must survive deploys):
IMAJIN_APP_KEYSTORE=/home/jin/.imajin/market.dev.keystore.json

LOG_LEVEL=debug
```

## Prod example

```dotenv
# market — PROD deployment env (prod-market, port 7104, https://jin.imajin.ai/market)
# Copy to ~/prod/market/.env.local on the server (chmod 600) and fill the
# placeholders. Never commit the real file. Reference: docs/ENVIRONMENTS.md.
# Validate with: node scripts/check-env.mjs prod

# --- Build-time (baked in by `next build` — rebuild after changing) ---
NEXT_PUBLIC_BASE_PATH=/market
# NEXT_PUBLIC_SERVICE_PREFIX stays UNSET on prod (a `dev-` value would point
# the /dashboard redirect at the dev kernel).
NEXT_PUBLIC_DOMAIN=imajin.ai
NEXT_PUBLIC_AUTH_URL=https://jin.imajin.ai/auth
NEXT_PUBLIC_MEDIA_URL=https://jin.imajin.ai/media

# --- Runtime ---
# PORT and NODE_ENV come from the pm2 entry (ecosystem.config.cjs).
NEXT_PUBLIC_APP_URL=https://jin.imajin.ai/market
# IMAJIN_ENV stays UNSET on prod (`dev` would select the dev session cookie).

DATABASE_URL=postgres://market:CHANGE_ME@localhost:5432/imajin_prod
APP_DB_SCHEMA=market

# --- Kernel (public surface only) ---
AUTH_SERVICE_URL=https://jin.imajin.ai/auth
IMAJIN_AUTH_URL=https://jin.imajin.ai
IMAJIN_KERNEL_URL=https://jin.imajin.ai
PAY_SERVICE_URL=https://jin.imajin.ai/pay

# --- Secrets: generate with `openssl rand -hex 32`, distinct per environment ---
SESSION_SECRET=REPLACE_ME
WEBHOOK_SECRET=REPLACE_ME

# --- Identity (operator step: docs/REGISTRATION.md) ---
IMAJIN_APP_DID=did:imajin:REPLACE_ME
# First boot only — delete after the app has booted once.
# IMAJIN_APP_CLAIM_CODE=
# Persistent, per-environment keystore (must survive deploys):
IMAJIN_APP_KEYSTORE=/home/jin/.imajin/market.prod.keystore.json

LOG_LEVEL=info
```
