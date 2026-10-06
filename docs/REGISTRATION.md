# Registering this app with the kernel

Per ima-jin/imajin-ai#1990, the kernel refuses to serve an unregistered app: every app is an
identity — a row in the kernel's app registry — before it can compose the platform. This app
**refuses to start** without `IMAJIN_APP_DID` set (see `instrumentation.ts`), so registration
is the first thing a fork must do, before `pnpm dev`.

## 1. Register (self-service)

You must already be signed in to the kernel as a developer (a human DID) before calling this —
the endpoint is `requireAuth`-gated to whoever owns the app being created.

```bash
curl -X POST "${IMAJIN_AUTH_URL}/api/registry/apps" \
  -H "Content-Type: application/json" \
  -H "Cookie: <your kernel session cookie>" \
  -d '{
    "name": "My App",
    "callbackUrl": "https://my-app.example.com/api/auth/callback",
    "requestedScopes": ["profile:read"]
  }'
```

Response (`201`):

```json
{
  "id": "app_xxxxxxxxxxxxxxxx",
  "ownerDid": "did:imajin:...",
  "name": "My App",
  "appDid": "did:imajin:...",
  "publicKey": "...",
  "callbackUrl": "https://my-app.example.com/api/auth/callback",
  "requestedScopes": ["profile:read"],
  "tier": "third_party",
  "allowedRedirectHosts": ["https://my-app.example.com"],
  "status": "active",
  "keypair": { "privateKey": "...", "publicKey": "..." }
}
```

`keypair` is only present when you didn't supply your own `publicKey` — it is shown **once** and
never stored by the kernel. **Do not put `keypair.privateKey` in `.env` or anywhere in this repo.**
This template never reads a raw private key from env at all (`instrumentation.ts` fails loud at
boot if `IMAJIN_APP_PRIVATE_KEY` is set) — see "Fetch this app's own signing key at boot" below for
how this app actually obtains its signing key.

## 2. Fields, and what they mean for a fork

| Field | Meaning |
|---|---|
| `appDid` | This app's own `did:imajin:…`, derived from its public key. Set as `IMAJIN_APP_DID`. |
| `ownerDid` | The developer DID that registered the app (you). Not needed as an env var. |
| `tier` | Always `third_party` for self-service registration. `first_party` is reserved for the kernel's own admin surface — every app forked from this template, including Imajin's own extractions (dykil, links, …), registers the same way, at the same tier. |
| `requestedScopes` | Clamped server-side to the kernel's declarative scope vocabulary — you cannot register an ad-hoc scope string. |
| `allowedRedirectHosts` | Seeded from `callbackUrl`'s origin. The kernel will only ever redirect a signed-in user back to a host in this set. |
| `tokenAudiences` | Starts empty. Irrelevant to this template's session/cookie flow (`getSession`, the `/api/auth/*` routes) — it only matters if you later adopt scoped app-tokens (`requireSessionOrAppToken`-style, host-scoped) instead of, or in addition to, the shared session cookie. |

`id` (the `app_...` registry id, not the DID) is what you set as `NEXT_PUBLIC_IMAJIN_APP_ID` —
it's what the "Sign in with Imajin" redirect uses client-side.

## 3. Wire up this app

```bash
cp .env.example .env.local
# fill in:
#   IMAJIN_APP_DID=<appDid from the response above>
#   NEXT_PUBLIC_IMAJIN_APP_ID=<id from the response above>
#   SESSION_SECRET=$(openssl rand -hex 32)
#   APP_DB_SCHEMA=<a name for this app's own Postgres schema — see docs/MIGRATIONS.md>
#   DATABASE_URL=<this app's own Postgres connection string>
#   IMAJIN_KERNEL_URL=<same host as IMAJIN_AUTH_URL above>
#   IMAJIN_APP_CLAIM_CODE=<one-time code from the kernel operator's /jin approval card — first boot only>
```

Without `IMAJIN_APP_DID` set, or with a raw `IMAJIN_APP_PRIVATE_KEY` still set, `pnpm dev` /
`pnpm start` throw immediately (`instrumentation.ts`) instead of serving requests no kernel call
could ever authenticate.

## 4. Fetch this app's own signing key at boot (#7)

This app never reads a raw private key out of `.env`. Instead, `instrumentation.ts` calls
`@ima-jin/auth-client`'s `loadAppSigningKey()` once, before serving any request:

- **First boot** (no local keystore yet): spends the one-time `IMAJIN_APP_CLAIM_CODE` from the
  kernel operator's `/jin` approval card, together with a freshly minted Ed25519 "bootstrap"
  keypair, to fetch the real signing key. The bootstrap keypair — never the signing key — is then
  persisted in a local keystore file (`IMAJIN_APP_KEYSTORE`, default `./.imajin/keystore.json`,
  mode `0600`). Delete `IMAJIN_APP_CLAIM_CODE` from `.env.local` once this succeeds; it's spent.
- **Every later boot**: signs a fresh challenge with the persisted bootstrap key and fetches the
  signing key again — no claim code needed, no operator action required for an ordinary restart.
- **No keystore and no claim code**: `loadAppSigningKey()` throws immediately with a clear error
  instead of booting unsigned.

If the local keystore is ever lost (disk wipe, redeploy to a fresh host), ask the kernel operator
to re-approve `apps.provision` with `reissueClaim: true` for a fresh claim code — redeeming it also
revokes the lost keystore's bootstrap key. See `@ima-jin/auth-client`'s README for the full API.

## 5. List or manage your apps later

```bash
curl "${IMAJIN_AUTH_URL}/api/registry/apps?owner=me" \
  -H "Cookie: <your kernel session cookie>"
```

Revoking or rotating an app's credentials is done through the kernel's admin/developer surface,
not by this template — see the kernel's own `/auth/developer/apps` UI.

## 6. This app's own inbound auth (scoped app tokens)

Every authenticated route goes through one function, `authenticate()`
(`src/lib/auth/authenticate.ts`), which wraps `@ima-jin/auth`'s `requireSessionOrAppToken`
(the ima-jin/imajin-ai#1974 pattern). A caller mints a token for this app's host:

```bash
curl -X POST "${IMAJIN_AUTH_URL}/api/tokens/app" \
  -H "Content-Type: application/json" \
  -H "Cookie: <caller's own kernel session cookie>" \
  -d '{ "aud": "market.imajin.ai", "scopes": [] }'
```

and calls this app with `Authorization: Bearer <token>`. The audience must equal the host of
`NEXT_PUBLIC_APP_URL`. The shared session cookie is accepted as a fallback. Set `AUTH_SERVICE_URL`
(see `.env.example`); `@ima-jin/auth` uses it to validate the cookie fallback.

Two kernel-side limits are tracked as issues: app tokens carry no acting-as-scope (ima-jin/imajin-ai#2639)
and no identity tier (ima-jin/imajin-ai#2640), so purchasing a `trust_gated` listing currently requires
the session-cookie path.
