# market — Imajin marketplace app (third-party app on Imajin)

> Forked from [`ima-jin/imajin-app-template`](https://github.com/ima-jin/imajin-app-template). **Read
> [`AGENTS.md`](./AGENTS.md) first** — it defines the boundary this app must not cross.

**Platform:** [Imajin](https://imajin.ai) (sovereign-tech kernel) · **Reference app:** `ima-jin/imajin-scorecard`

This repository **is the app** — a real, arms-length third-party application that composes the Imajin platform
**only through its public app surface** (`requireAppAuth` + the documented kernel API). It holds **no `workspace:*`
deps, no monorepo internals, no DB access, no in-process bus** — it talks to Imajin as an external client. Published
`@ima-jin/*` SDK packages (from npmjs.org, no auth needed) are fine to depend on; they're the same versioned
artifact every app — first-party or third-party — consumes.

## Source of truth is the user's

This app holds nothing authoritative. The signed records are **the user's own**, on their per-DID path. The kernel is
the authoritative **index/projection** of those records — not their owner. The user can walk with their records and
everything still verifies. (See `AGENTS.md` §3.)

## How it composes Imajin

| Header | Meaning |
|--------|---------|
| `X-App-DID` | this app's DID (from registration) |
| `X-App-Authorization` | the attestation ID from the user's consent flow |

The kernel verifies both and returns `{ appDid, userDid, scopes }` — that triple is the app's entire authority.

## Getting started

1. **Create your app repo WITH template history** — clone + rename, **not** GitHub's "Use this template" button
   (see [Creating a new app](#creating-a-new-app-with-template-history) below).
2. **Register this app with the kernel** — see [`docs/REGISTRATION.md`](./docs/REGISTRATION.md).
   You'll get back this app's `appDid` and registry `id`.
3. **Set env**: `cp .env.example .env.local`, then fill in `IMAJIN_APP_DID`,
   `NEXT_PUBLIC_IMAJIN_APP_ID`, `APP_DB_SCHEMA`, and
   `IMAJIN_KERNEL_URL`. This app refuses to start without `IMAJIN_APP_DID` set, or if a raw
   `IMAJIN_APP_PRIVATE_KEY` is present (see `instrumentation.ts`) — it fetches its own signing key
   at boot via `@ima-jin/auth-client`'s `loadAppSigningKey()` instead. The only claim path is
   *approve on `/jin` → open `<this app>/claim` → paste the code →
   done* — see [`docs/REGISTRATION.md`](./docs/REGISTRATION.md).
4. **Prepare vault credentials** through the operator's `/jin` App surface:
   sync `imajin.app.json`, then App secrets set/rotate for `DATABASE_URL` with owner countersign.
   The value is operator-supplied, never put in env or a shell. Session signing remains kernel-generated.
   `createVaultBoot` fetches both credentials through the bootstrap keystore-authenticated encrypted
   channel before dynamically importing the server initializer; only then is the database client created.
   Missing required credentials fail closed with no env fallback. Build and unclaimed mode never create a DB client.
5. **Migrate this app's own Postgres schema through the vault** (see
   [`docs/MIGRATIONS.md`](./docs/MIGRATIONS.md); on a database that already holds the `market` schema, i.e. prod/dev,
   `scripts/deploy.sh` runs the migration baseline first — see [`docs/DEPLOY.md`](./docs/DEPLOY.md)):
   ```bash
   pnpm install
   node --env-file=.env.local scripts/migrate-baseline.mjs
   pnpm db:migrate
   ```
6. **Run it**:
   ```bash
   pnpm dev
   ```
   `/api/health` and `/api/spec` should respond immediately; `/api/me` returns your DID once
   you sign in through the header's "Sign in with Imajin" link.

## Identity — minting the app's DID (browser claim flow)

The app's identity is minted by the **kernel**, never by hand: no keys are generated, copied, or logged in this
repo. Dev and prod are **separate registered apps** — each has its own DID, claim code and keystore.

1. **Operator mints a claim code on the kernel's `/jin`** (`https://dev-jin.imajin.ai/jin` for dev,
   `https://jin.imajin.ai/jin` for prod): approve the app's `apps.provision` card. The kernel returns the app's
   `did:imajin:…` and a **one-time claim code**.
2. **Redeem it only in the browser:** configure `IMAJIN_APP_DID` and start the app unclaimed. Until it is
   claimed, every route serves a "not claimed yet" page except `/claim`, `/api/claim` and `/api/health`. Open
   `<this app>/claim` (`/market/claim` behind the kernel host's Caddy), paste the code, and submit.
   The app is live immediately — no env edit or restart. The exchange persists a `0600` bootstrap keystore
   at `IMAJIN_APP_KEYSTORE`; `/claim` and `/api/claim` then return 404.
3. The kernel issues and seals the session signing recipe declared in `imajin.app.json` during provision/claim.
   Boot loads it with `createVaultBoot` into memory before importing the server or enabling sessions. For an existing app, select
   **Sync manifest secrets** on `/jin` and countersign. Rotate there, then restart through the operator tool
   to pick up the new generation (existing sessions are invalidated); no secret env or file edit.
4. Later boots use the keystore alone. A lost keystore needs a re-approval with `reissueClaim: true`.

The claim code and keystore contents are never logged or placed in env.

Full detail: [`docs/REGISTRATION.md`](./docs/REGISTRATION.md) and [`docs/DEPLOY.md`](./docs/DEPLOY.md#identity-the-claim-flow).

## Deploying (prod + dev)

**Rollout is not authorized by #27.** Runtime, baseline and migration scripts load credentials
from the vault into memory; the same non-secret env file passes preflight and configures every step.
No deploy or environment change is part of this adoption. Keep imajin-ai#2260 separate.

Command per environment (`~/prod/market`, `~/dev/market`), after browser claim and vault approvals:

```bash
scripts/deploy.sh dev                 # or: scripts/deploy.sh prod
scripts/deploy.sh prod --ref <tag>    # a specific ref; also the rollback
scripts/deploy.sh prod --dry-run      # print the plan, execute nothing
```

It validates the env file, installs, builds, runs the idempotent **migration baseline** (adopts the existing
`market` schema, refuses on mismatch, never drops anything) then the vault-backed programmatic
`scripts/migrate.mjs`, restarts the pm2 entry
(`prod-market` on 7104 / `dev-market` on 3104) and health-checks `/market/api/health`. The app is served under the
`/market` base path behind the kernel host's Caddy. See [`docs/DEPLOY.md`](./docs/DEPLOY.md) (runbook, Caddy route,
pm2, baseline, cutover checklist) and [`docs/ENVIRONMENTS.md`](./docs/ENVIRONMENTS.md) (every env var; `.env.example`,
`.env.dev.example`, `.env.prod.example`).

## What this app serves

Ported from the kernel's `apps/market` (ima-jin/imajin-ai#1989, step 2 of 5):

- **API** (`app/api/**`, documented in [`api-spec/openapi.yaml`](./api-spec/openapi.yaml), served at `/api/spec`):
  listings (browse, create, update, soft-delete), checkout via the pay service, the seller's own listings,
  seller settings and public profile widgets, handle/DID resolution, and the pay-service payment webhook.
- **Pages** (`app/**/page.tsx`): browse, listing detail, create/edit, seller page, settings, checkout success.
- **Auth:** every authenticated route goes through `authenticate()` (`src/lib/auth/authenticate.ts`): a scoped
  `Authorization: Bearer <app-token>` for the registry slug `market`, or the shared session cookie as a fallback.
  See [`docs/REGISTRATION.md`](./docs/REGISTRATION.md) §6.
- **Kernel callbacks:** the kernel signs; `verifyKernelWebhook` verifies raw bytes, the app DID,
  freshness and nonce before processing. No shared callback credential is needed. See
  [`docs/DEPLOY.md`](./docs/DEPLOY.md#kernel-signed-payment-callbacks).
- **Domain events:** `listing.created`, `listing.updated`, and `listing.purchased` are published through the
  kernel's `POST /api/events` using market's own app-service token. See [Domain events](#domain-events).
- **Known kernel gaps** (filed as `gap(kernel)` issues, all refs ima-jin/imajin-ai#1989): `@ima-jin/media` (#2637),
  acting-as-scope (#2639), identity tier (#2640), `@ima-jin/onboard` (#2645).

## Domain events

`src/lib/kernel/events.ts` publishes to `{IMAJIN_KERNEL_URL}/api/events`. The existing
`IMAJIN_KERNEL_URL` must be the kernel base URL, without an `/auth`, `/pay`, or `/market` suffix.
No new environment variable or shared service secret is needed. `IMAJIN_APP_DID` and the app's claimed
signing identity must be available (see [Identity](#identity--minting-the-apps-did-browser-claim-flow)).
The published `@ima-jin/auth-client` helper proves possession of that in-memory key at
`POST /auth/api/apps/token/service`. Its default `imajin:apps` audience is accepted by the events endpoint;
the cached token is refreshed at 80% of its TTL.

The body is `{ type, subject, payload, correlationId? }`. The kernel sets the issuer/origin and scope itself.
Creation and updates emit one canonical event each; `listing.purchased` is emitted after a verified successful
payment callback, not merely after checkout creation. App-origin events can **notify and audit only** — never
move money or issue attestations. Market's existing checkout/settlement flow remains independent.

Publishing is best-effort and does not change the listing, checkout, or webhook response. Missing configuration
is logged at **error** level naming the setting; unclaimed identity and network failures are also error-logged.
Mint and publish requests each have a five-second timeout. Refusals (including 401, 403 for unapproved types,
and 429 with `Retry-After`) are logged without token, key, payload, or response-body contents. There is no automatic
replay/retry or delivery guarantee; after 401 the next event mints a fresh token.

**Operator step after deployment (prod and dev separately):** review the `emittableEvents` declarations from
`imajin.app.json` in the `/jin` provision/declarations preview and approve `listing.created`, `listing.updated`,
and `listing.purchased` for that environment's market app. Declaration alone grants nothing. Until approval,
the kernel returns 403. Then trigger a listing action and confirm market's app DID/event in the kernel audit
log and the applicable notify reactor. This code change does not deploy or approve anything.

## Creating a new app (with template history)

> **Do not use GitHub's "Use this template" button.** It creates a repo with a brand-new, unrelated root
> commit. Such an app can never merge template changes cleanly — its first sync is an
> `--allow-unrelated-histories` merge with add/add conflicts on nearly every file (that's why `/claim` had to be
> hand-ported into `links` and `dykil`). Instead, keep the template's history as the app's ancestry:

```bash
# 1. Clone the template under your app's name; the template becomes the `template` remote.
git clone https://github.com/ima-jin/imajin-app-template.git <app-name>
cd <app-name>
git remote rename origin template

# 2. Create the (empty) app repo on GitHub and make it `origin`. No README/license/.gitignore — it must be empty.
gh repo create ima-jin/<app-name> --private --source=. --remote=origin --push

# 3. Rename the template identity (one commit), then push.
#    package.json "name", api-spec/openapi.yaml (title + example), app/api/health/route.ts (+ its test),
#    app/layout.tsx description, sonar-project.properties (projectKey), the README title, and AGENTS.md §8.
git checkout -b chore/rename-app
# ...edit the files above...
git commit -am "chore: rename template → <app-name>" && git push -u origin chore/rename-app
```

Because the app was cloned from the template, `git merge-base HEAD template/main` finds a common ancestor from
the very first commit — there is nothing to "join".

### Pulling template changes later

```bash
scripts/sync-from-template.sh --check   # list pending template commits; no merge, no branch
scripts/sync-from-template.sh           # merge template/main onto chore/sync-from-template → open a PR
```

The script adds the `template` remote if missing, fetches `template/main`, and checks for a common ancestor:

- **Histories joined** → prints `histories already joined; incremental merge` and runs a normal
  `git merge template/main --no-edit` on a `chore/sync-from-template` branch (never straight to `main`).
- **Not joined** (app created with "Use this template") → exits with status 2 and prints the one-time join. The
  join is history-only — it changes **no files**:
  ```bash
  git checkout -b chore/join-template-history
  git merge -s ours --allow-unrelated-histories <template-sha> -m "chore: join template history (one-time)"
  ```
  Use the template commit the app was **generated from** (the template's state when the app repo was created),
  not `template/main`: `-s ours` marks everything up to that commit as already merged, so joining at the tip
  would silently skip every template change since the app was created. After the join PR merges, the script
  reports `histories already joined` and pulls later template changes as an ordinary merge.

On a conflict (almost always AGENTS.md §8, or the renamed identity files from step 3), keep your version of
what is yours and take the template's side of the shared contract.

## Consuming `@ima-jin/*`

Published `@ima-jin/*` packages (e.g. `@ima-jin/auth-client`, `@ima-jin/config`, `@ima-jin/ui`) are served from
npmjs.org, the default registry — no `.npmrc` scoping and no auth token needed to install them:

```bash
pnpm add @ima-jin/auth-client
```

## Layout

```
AGENTS.md          ← boundary + scope for coding agents (read first)
README.md          ← this file
docs/
  ARCHITECTURE.md  ← design notes
  REGISTRATION.md  ← how to register this app with the kernel
  MIGRATIONS.md    ← this app's schema-ownership rule
  DEPLOY.md        ← prod + dev deploy runbook, identity, migration baseline, Caddy, pm2
  ENVIRONMENTS.md  ← every env var (generated from scripts/lib/env-manifest.mjs)
app/               ← Next.js App Router: pages + API routes
src/
  components/      ← client components
  lib/             ← auth config, signing-identity (loadAppSigningKey boot path), base-path, other helpers
  db/              ← this app's own drizzle schema (never a kernel schema)
migrations/        ← generated by `pnpm db:generate`, applied by `pnpm db:migrate`
api-spec/          ← this app's own OpenAPI document, served at /api/spec
scripts/           ← deploy.sh, migrate-baseline.mjs, check-env.mjs (+ tests)
ecosystem.config.cjs ← pm2 entries prod-market (7104) / dev-market (3104)
instrumentation.ts ← boot-env guards + loadAppSigningKey() bootstrap (see docs/REGISTRATION.md)
middleware.ts      ← gates every route on claim state — unclaimed page, /claim 404 once claimed (#2427)
```

`app/claim/page.tsx` + `app/api/claim/route.ts` are the operator-facing claim page and its server
route (#2427) — see "This app's own signing key" below.

## This app's own signing key

This app never reads a raw private key from env. `instrumentation.ts` fails loud at boot if
`IMAJIN_APP_PRIVATE_KEY` is set, and instead calls `@ima-jin/auth-client`'s `loadAppSigningKey()`.
Without a keystore yet, this app boots in **unclaimed mode** (#2427): every route
except `/claim`, `/api/claim`, and `/api/health` serves a minimal "not claimed yet" page. The
operator path: approve provisioning on the kernel's `/jin` → open `<this app>/claim` → paste the
one-time claim code → done — no ssh, no env edit, no restart. Only this browser path bootstraps
a local `0600` keystore (`IMAJIN_APP_KEYSTORE`); every later boot re-authenticates with that
keystore, no operator action needed. See
[`docs/REGISTRATION.md`](./docs/REGISTRATION.md#4-claim-this-apps-own-signing-key-7-2427).

## Mounting under a path prefix

Set `NEXT_PUBLIC_BASE_PATH` (e.g. `/coffee`) when this fork is served behind a reverse-proxy path
prefix instead of at `/`. `next.config.js` reads it for Next's own `basePath` (covers `<Link>` and
`router.push` automatically); route any raw `fetch()`, `<a href>`, or `redirect()` through
`src/lib/base-path.ts`'s `withBasePath()` helper, since Next.js doesn't rewrite those.

## The honest test

Every Imajin app before the external integrators was first-party (same repo, same server, privileged access). Apps
built from this template are the **external-integrator** test: if this app can do everything it needs through app-auth
and the public API alone, the federated-app boundary is real.

