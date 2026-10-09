<!--
  ┌─────────────────────────────────────────────────────────────────────┐
  │  FORK CHECKLIST — fill this in first, then delete this comment block  │
  │                                                                       │
  │  APP NAME:        <e.g. AgriFortress>                                 │
  │  APP DID:         <did:imajin:… — from app registration>             │
  │  SCOPES:          <e.g. supply:read, supply:write>                    │
  │  DOMAIN:          <e.g. integrity.imajin.ai>                          │
  │  KERNEL:          <prod: https://jin.imajin.ai | dev: https://dev-jin.imajin.ai> │
  │  REFERENCE APP:   ima-jin/imajin-scorecard                            │
  │                                                                       │
  │  Then: fill the "This App" section, keep everything else, delete me.  │
  └─────────────────────────────────────────────────────────────────────┘
-->

# AGENTS.md — Third-Party App on Imajin

This repo is a **standalone, arms-length application** that composes the Imajin platform through its
**public app surface only**. You (the coding agent) are working *on* the app, not *inside* Imajin. Read this whole
file before touching code — it defines the boundary you must not cross and the scope you must stay inside.

---

## 0. Quick start for a fresh fork

1. Clone the template and rename it — **not** GitHub's "Use this template" button, which drops the template's
   history (see the README's "Creating a new app").
2. Register the app with the kernel — [`docs/REGISTRATION.md`](./docs/REGISTRATION.md).
3. Set env: `cp .env.example .env.local` and fill it in (the app refuses to start without
   `IMAJIN_APP_DID` — see `instrumentation.ts`).
4. `pnpm db:migrate` — this app's own Postgres schema only, see
   [`docs/MIGRATIONS.md`](./docs/MIGRATIONS.md).
5. `pnpm dev`.

---

## 1. What Imajin is (the supporting framework)

**Imajin (今人, "now-person") is the sovereign substrate this app runs on — not a library you import, a platform you
compose.** It provides five primitives, and this app rents them; it never owns them:

| Primitive | What it gives you |
|-----------|-------------------|
| **Identity** | sovereign DIDs — every actor (this app, every user) is a `did:imajin:…` |
| **Attestation** | signed, content-addressed records — the unit of proof |
| **Communication** | messaging / events between identities |
| **Attribution (.fair)** | who-made-what, who-gets-paid — attribution + settlement manifests |
| **Settlement** | the paid leg — value moves against a signed record |

**Why it's built this way (so you get the *why*, not just the rules):** Imajin runs the *honesty inversion*. For the
whole surveillance-tech era the money was in the lie — information asymmetry, monetized opacity. Imajin inverts the
incentive: **the signed record IS the value**, so hiding stops paying and disclosure starts. Everything below follows
from that. When a rule here feels strict, it's protecting the provable record — that record is the entire product.

**This app is a tenant, a lens, a render — never the authority.** The kernel + the user's own signed records hold
authority; this app proposes and displays. If you ever find yourself making this app the source of truth, you've
misunderstood the architecture — stop and re-read §3.

---

## 2. The boundary contract (do NOT cross this)

This app talks to Imajin as an **external client**. Hard rules, enforced in review:

- ✅ **Compose Imajin only via the public app surface:** app-auth headers + the documented kernel HTTP API.
  - `X-App-DID` — this app's DID (from registration)
  - `X-App-Authorization` — the attestation ID from the user's consent flow
  - The kernel verifies these and returns `{ appDid, userDid, scopes }`. That triple is your entire authority.
- ✅ **Published `@ima-jin/*` packages are fine.** `@ima-jin/auth-client`, `@ima-jin/config`, `@ima-jin/logger`, `@ima-jin/ui`, …
  installed from npmjs.org (no auth needed) are the SDK — every app, first-party or third-party, consumes the
  same versioned artifact the same way. Depending on one is not a boundary violation.
- ❌ **No `workspace:*` dependencies.** A `workspace:*` version range only resolves inside the monorepo. If you see
  one, this app has drifted back into being a monorepo package instead of an external client.
- ❌ **No monorepo internals.** No importing `apps/kernel/src/**`, no `@imajin/db`, no direct Postgres access to
  kernel schemas. The kernel is consumed only via its `/spec`'d HTTP/WS routes and the published SDK — never by
  reaching around them into the kernel's own source or database.
- ❌ **No in-process bus.** The bus is kernel-internal. Emit `supply.*`/domain events by calling the kernel's
  app-auth-gated domain API, never by importing a publisher.
- ❌ **No kernel internals, secrets, or private keys beyond this app's own registration credentials.**

**Logging:** stdout only. The host process manager (pm2) captures it. Never wire a DB log transport — logging is not
an attestation and must not touch kernel or app data stores.

**Reference implementation: `ima-jin/imajin-scorecard`** — the clean 2nd-party pattern (Next.js, `jose` HS256 session
cookie, `/api/auth/callback` handling the kernel redirect, published `@ima-jin/*` SDK only). Match its shape. Do
**not** copy in-monorepo apps (coffee/dykil/learn) — those talk to the kernel over the same public contract as this
app; if one looks privileged, that's the drift this template exists to close, not a pattern to imitate.

**The honest test this app exists to pass:** an outside party can build everything it needs through app-auth + the
public API *without being inside Imajin*. Every shortcut through the boundary invalidates that test — and Imajin's
own apps are rebuilt on this same template to prove the sentence above has no first-party exception.

---

## 3. Source of truth is the USER's, not the kernel's ⚠️

**This is the most common mistake — bake it in.** The kernel is authoritative *as an index/projection*, **not as the
owner of truth.**

| Tier | What | Owns the truth? |
|------|------|-----------------|
| **User's signed records** | signed markdown/attestations on the user's per-DID path (hosted today, user-held vault eventually) | ✅ **source of truth** |
| **Kernel domain core** | a *projection* — index, query, reactor chains, settlement | derived view |
| **Connectors** | services the user *selects* (QuickBooks, …) feeding their own records | user's chosen instruments |
| **This app** | thin render + gesture UX over the user's records | a lens |

The user can walk away with their signed records and everything still verifies. The platform holds data **for** the
user, never **from** them. **Moat = legitimacy, not lock-in.**

> When you write UI copy, comments, or issues: never say "the kernel is the source of truth." Say "the kernel is the
> authoritative *index/projection* of the user's own signed records." Reading the kernel replaces a stale local cache
> because it's the authoritative projection — **not** because the kernel owns the truth.
>
> Note: an app may not have *flipped* to user-held vaults yet (Phase 1 often hosts records on our infra). Word things
> so they're true today **and** point at the user-held end-state — don't assert kernel-as-owner as a principle.

---

## 4. Epistemics & the claim boundary (binding on all copy + logic)

- **Evidence ≠ measurement.** Voice/text where a human *asserts and signs* a value = the record. A **photo is evidence,
  not measurement — never count/measure from an image.** A confidently-wrong count poisons the provable record. An
  attestation proves "X said it and signed it," not "a camera verified it."
- **Inference is a prior, the human is the authority.** Inferred fields (from a photo, from last time) pre-fill an
  **editable** confirm step. The human's confirmation is the signing event.
- **Claim boundary:** signed attestations prove a claim is *consistent + attributed*, **not *true about the physical
  world*.** Never overclaim "verified truth." Two tiers if you surface trust: *cryptographically verified* (signature/
  chain) vs *AI-reviewed / advisory*.
- **Friction gate (if this app instruments a real-world workflow):** the app must **never make the real task slower than
  it is today.** Time-to-signed-record ≤ time-to-current-process. Generate the record from the *gesture*, not a form.

---

## 5. Engineering discipline (carried from imajin-ai)

**SonarCloud-clean — zero new issues per PR.** These are enforced:
- No negated conditions with `else` (`if (x) {B} else {A}`, not `if (!x) {A} else {B}`)
- No nested ternaries — extract to variables or if/else
- No array index keys in React — stable IDs
- No `forEach` — use `for...of`
- No dead stores; positive conditions first in ternaries
- `replaceAll()` not `.replace(/g)`; `node:` protocol for built-ins
- `globalThis` not bare `window`/`self` (`globalThis.window`, `globalThis.document`, …)
- React component props typed `Readonly<>` in the signature
- No redundant type constituents (don't write `string | undefined` for a `?:` param)

**Other:**
- **Stop means stop.** When the human says stop, STOP immediately — no "just one more fix."
- **Search before writing.** Match existing patterns in this repo (and the reference app) before inventing.
- **Commit hygiene:** feature branch → PR. `Closes #N` to auto-close. `[skip ci]` only for iteration commits.
- **Sub-agent memory rule:** if you spawn a sub-agent, tell it to append a summary of what it built/changed to
  `docs/worklog/YYYY-MM-DD.md` (create if missing) — what was built, files changed, decisions, status.
- **Env:** all service URLs come from env vars (`.env.example` is the contract) — **no hard-coded URLs**.
- **No secrets in the repo.** The session secret lives in `.env`, never committed. This app's own signing key is
  never put in `.env` at all — it's fetched at boot via `@ima-jin/auth-client`'s `loadAppSigningKey()` (a one-time
  claim code on first boot, a local `0600` bootstrap keystore on every later boot). See `docs/REGISTRATION.md`.

---

## 5a. Staying in sync with the template

This app tracks `ima-jin/imajin-app-template` as an **upstream remote** (not a GitHub fork). The shared contract
(§1–§7 + config files) flows in from the template; **§8 is yours** and is never overwritten.

```bash
scripts/sync-from-template.sh --check   # see what upstream changes are pending
scripts/sync-from-template.sh           # merge template/main onto a sync branch → open a PR
```

An app cloned from the template shares its history, so every run is a normal merge. An app created with "Use this
template" must be joined **once** first (`git merge -s ours --allow-unrelated-histories <generating-template-sha>`,
history-only); the script detects that and prints the steps. On the rare conflict (almost always §8), **keep your
§8** and take the template's §1–§7. See the script header for details.

---

## 7. Issue & contribution conventions

This app follows the portable Imajin conventions from **[`ima-jin/conventions`](https://github.com/ima-jin/conventions)**
— consumed, not forked.

**Labels** are executable state, seeded once (idempotent):
```bash
scripts/init-taxonomy.sh <owner/repo>    # universal label set
```

**Lifecycle rules (the portable subset — standalone-repo, NOT the monorepo fork model):**
- `Closes #N` / `Fixes #N` in a PR is the **only** thing that auto-closes an issue. A body mention or `Phase N — #N:`
  closes nothing.
- **Don't close-and-icebox real ideas** — a genuine idea not being worked now stays *open* (shelved), not closed.
- **Native sub-issues / blocked-by** over `- [ ]` body checklists (GraphQL: `addSubIssue` / `addBlockedBy`; the latter's
  arg is `blockingIssueId`).
- Use labels for **type/topic**, not status. (Status/priority live on a board where one exists.)

Full text: `ima-jin/conventions/ISSUE-CONVENTIONS.md`. This §7 is kept in sync via `scripts/sync-from-template.sh`.

---

## 8. This App

- **What it is:** Market — local commerce: listings (sale/rental), disputes, and seller settings. Forked from
  `imajin-app-template`; extracted from the kernel's in-monorepo `apps/market` (ima-jin/imajin-ai#1989).
- **App DID:** _set at registration — see `docs/REGISTRATION.md` (not yet registered; registration is step 4 of 5)_
- **Scopes:** none required by the routes today. Every inbound request is authenticated through one function,
  `authenticate()` (`src/lib/auth/authenticate.ts`, wrapping `@ima-jin/auth`'s `requireSessionOrAppToken`, the
  #1974 pattern): a scoped `Authorization: Bearer <app-token>` (audience = this app's host) or the shared session
  cookie as fallback. No route imports an auth primitive directly (`__tests__/boundary.test.ts` enforces this).
  Ownership is enforced by this app: a listing's `sellerDid` must equal the caller's DID.
- **Domain:** _TBD_
- **Database:** Postgres schema `market` (`APP_DB_SCHEMA=market`), owned by this app via `migrations/`. Tables:
  `listings`, `disputes`, `seller_settings`.
- **The real-world loop it instruments:** seller lists an item or service → buyer purchases (settled via the kernel) →
  disputes are resolved if the sale goes wrong.
- **Domain events it emits (via kernel API):** `listing.create|created|update|purchase|purchased` — all through the
  single seam `emitEvent()` (`src/lib/kernel/events.ts`), currently a logged no-op because the kernel has no public
  app-token-gated event route yet (ima-jin/imajin-ai#2638). Until it lands, post-purchase reactors (attestation,
  notify) do not fire for sales made here. Settlement does not depend on it: market settles its own purchases through
  pay's registered-app contract — it mints its own app-service token (`src/lib/app-token.ts`), checks out with a
  declared payee chain (`src/lib/settle.ts`), remembers the kernel payment per Stripe session
  (`src/lib/pending-checkout.ts`, in `listings.metadata`), and settles from `POST /api/webhook`, which accepts only
  `Authorization: Bearer <WEBHOOK_SECRET>`. Card payments are charged on the seller's OWN Stripe account (no Stripe
  Connect): a payment the kernel already settled there arrives with `rail: stripe-byo`, and that notification IS the
  settlement — the webhook records the receipt and never calls `/pay/api/settle` (which refuses such a payment). A
  seller with no connected key gets `SELLER_NO_CARD_RAIL` (`src/lib/card-rail.ts`): the purchase route answers a plain
  400 and the listing page hides the card button (ima-jin/imajin-ai#2773).
- **Connectors it consumes:** none
- **Scope guardrails specific to this app:** no tables outside the `market` schema; no `@imajin/*` workspace
  packages or kernel imports — only published `@ima-jin/*` packages from npmjs. Where a package the kernel app used
  is not published (`@ima-jin/media` #2637, `@ima-jin/onboard` #2645, the bus #2638) the stand-in lives in one
  small file (`src/lib/media.ts`, `src/components/OnboardGate.tsx`, `src/lib/kernel/events.ts`) with the gap issue
  in its header, so it can be deleted when the package ships. Known kernel-side gaps that change behaviour:
  acting-as-scope (#2639) and identity tier for `trust_gated` purchases (#2640).
