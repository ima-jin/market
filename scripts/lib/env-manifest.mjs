/**
 * Single source of truth for every environment variable this app (or a
 * dependency it loads, or one of its scripts) reads — refs
 * ima-jin/imajin-ai#2511. Consumed by:
 *   - scripts/check-env.mjs              (deploy preflight; never prints values)
 *   - scripts/deploy.sh                  (scrubs inherited shell vars by name)
 *   - scripts/__tests__/env-docs.test.ts (fails CI if .env.example or
 *     docs/ENVIRONMENTS.md omit a variable, or if code starts reading one
 *     that is not listed here)
 *
 * Examples here are shape-only placeholders — never real secrets.
 */
import { parseEnv } from 'node:util';
import { readFileSync } from 'node:fs';

export const TARGETS = {
  prod: { name: 'prod-market', port: 7104 },
  dev: { name: 'dev-market', port: 3104 },
};

export const BASE_PATH = '/market';
export const SCHEMA = 'market';

/**
 * status:
 *   required         must be set in the env file for a deployed instance
 *   first-boot       required only on the very first boot, then removed
 *   optional         read, has a safe default when unset
 *   forbidden        must NOT be set (the app refuses to boot if it is)
 *   runtime-set      injected by Next.js / pm2 — not set in the env file
 *   dependency       read by an @ima-jin/* dependency on a code path market
 *                    does not exercise; leave unset
 *   template-unused  present in the app template's .env.example but not read
 *                    by any code in this repo; safe to omit
 * phase: 'build' = baked into the build (set before `next build`),
 *        'runtime' = read at process start / request time,
 *        'script' = read only by an operator/CI script.
 */
export const ENV_VARS = [
  {
    name: 'DATABASE_URL',
    status: 'required',
    phase: 'runtime',
    secret: true,
    summary:
      'Postgres connection string for this app\'s own database (also read by drizzle-kit and scripts/migrate-baseline.mjs). Never a kernel database.',
    dev: 'postgres://<role>:<password>@localhost:5432/<dev_db>',
    prod: 'postgres://<role>:<password>@localhost:5432/<prod_db>',
  },
  {
    name: 'APP_DB_SCHEMA',
    status: 'required',
    phase: 'runtime',
    summary:
      'The one Postgres schema this app owns. Fixed to `market` — the existing prod/dev schema; never change it (it would orphan migration state).',
    dev: 'market',
    prod: 'market',
  },
  {
    name: 'AUTH_SERVICE_URL',
    status: 'required',
    phase: 'runtime',
    summary:
      'Kernel auth service base URL, including the /auth prefix. Read by @ima-jin/auth for session and app-token verification.',
    dev: 'https://dev-jin.imajin.ai/auth',
    prod: 'https://jin.imajin.ai/auth',
  },
  {
    name: 'IMAJIN_AUTH_URL',
    status: 'required',
    phase: 'runtime',
    summary:
      'Kernel base URL for the Sign-in-with-Imajin flow (src/lib/auth-config.ts). Same host as IMAJIN_KERNEL_URL.',
    dev: 'https://dev-jin.imajin.ai',
    prod: 'https://jin.imajin.ai',
  },
  {
    name: 'IMAJIN_KERNEL_URL',
    status: 'required',
    phase: 'runtime',
    summary:
      'Kernel base URL (no path). Used by loadAppSigningKey() to fetch this app\'s signing key at boot, and by the kernel client.',
    dev: 'https://dev-jin.imajin.ai',
    prod: 'https://jin.imajin.ai',
  },
  {
    name: 'PAY_SERVICE_URL',
    status: 'required',
    phase: 'runtime',
    summary:
      'Kernel pay service base URL, including the /pay prefix. Checkout sessions are created with POST {PAY_SERVICE_URL}/api/checkout; purchases fail with a 500 while it is unset.',
    dev: 'https://dev-jin.imajin.ai/pay',
    prod: 'https://jin.imajin.ai/pay',
  },
  {
    name: 'WEBHOOK_SECRET',
    status: 'required',
    phase: 'runtime',
    secret: true,
    summary:
      'Shared secret the pay service sends with payment webhooks (POST /api/webhook). The webhook rejects every request while it is unset. 32+ random bytes; set the same value on the pay side. Never the dev value on prod.',
    dev: '(32+ random bytes — openssl rand -hex 32)',
    prod: '(32+ random bytes — openssl rand -hex 32)',
  },
  {
    name: 'SESSION_SECRET',
    status: 'required',
    phase: 'runtime',
    secret: true,
    summary:
      'Signs this app\'s session cookie (HS256, @ima-jin/auth-client). 32+ random bytes; distinct per environment.',
    dev: '(32+ random bytes — openssl rand -hex 32)',
    prod: '(32+ random bytes — openssl rand -hex 32)',
  },
  {
    name: 'NEXT_PUBLIC_BASE_PATH',
    status: 'required',
    phase: 'build',
    summary:
      'Reverse-proxy path prefix the app is mounted under. Must be `/market`. Baked at build time; rebuild after changing.',
    dev: '/market',
    prod: '/market',
  },
  {
    name: 'NEXT_PUBLIC_APP_URL',
    status: 'required',
    phase: 'runtime',
    summary:
      'This app\'s public URL. Its HOST is the `aud` used to verify scoped app tokens — it must match a host in this app\'s registered tokenAudiences (operator-confirmed at registration).',
    dev: 'https://dev-jin.imajin.ai/market',
    prod: 'https://jin.imajin.ai/market',
  },
  {
    name: 'NEXT_PUBLIC_AUTH_URL',
    status: 'required',
    phase: 'build',
    summary:
      'Public URL of the kernel auth service the browser talks to (the "enter your email to buy" gate: GET /api/session, POST /api/onboard). Includes the /auth prefix. Baked at build time.',
    dev: 'https://dev-jin.imajin.ai/auth',
    prod: 'https://jin.imajin.ai/auth',
  },
  {
    name: 'IMAJIN_APP_DID',
    status: 'required',
    phase: 'runtime',
    summary:
      'This app\'s own did:imajin:… from registration (docs/REGISTRATION.md). instrumentation.ts refuses to boot without it. Not a secret. Separate DID for dev and prod.',
    dev: 'did:imajin:<dev app DID>',
    prod: 'did:imajin:<prod app DID>',
  },
  {
    name: 'NEXT_PUBLIC_SERVICE_PREFIX',
    status: 'optional',
    phase: 'build',
    summary:
      'Read by @ima-jin/config to build kernel/chat/media public URLs, including the /dashboard -> kernel hub redirect in middleware.ts. MUST be `dev-` on the dev instance (otherwise the redirect points at the prod kernel); leave unset on prod. Baked at build time; rebuild after changing.',
    dev: 'dev-',
    prod: '(unset)',
  },
  {
    name: 'NEXT_PUBLIC_DOMAIN',
    status: 'optional',
    phase: 'build',
    summary:
      'Companion to NEXT_PUBLIC_SERVICE_PREFIX (default imajin.ai). Leave at the default on both environments.',
    dev: 'imajin.ai',
    prod: 'imajin.ai',
  },
  {
    name: 'NEXT_PUBLIC_MEDIA_URL',
    status: 'optional',
    phase: 'build',
    summary:
      'Public base URL of the kernel media service, used to turn asset_* image refs into URLs and as the image-upload target (ima-jin/imajin-ai#2637). When unset it is derived from the service prefix/domain.',
    dev: 'https://dev-jin.imajin.ai/media',
    prod: 'https://jin.imajin.ai/media',
  },
  {
    name: 'NEXT_PUBLIC_NODE_DID',
    status: 'optional',
    phase: 'build',
    summary:
      'This node\'s DID, shown in the .fair attribution accordion on a listing. Optional.',
    dev: '(optional)',
    prod: '(optional)',
  },
  {
    name: 'IMAJIN_ENV',
    status: 'optional',
    phase: 'runtime',
    summary:
      'Selects the kernel session cookie name in @ima-jin/config: `dev` -> imajin_session_dev, anything else -> imajin_session. MUST be `dev` on the dev instance (a production build is NODE_ENV=production, which does not imply dev); leave unset on prod.',
    dev: 'dev',
    prod: '(unset)',
  },
  {
    name: 'IMAJIN_APP_CLAIM_CODE',
    status: 'first-boot',
    phase: 'runtime',
    secret: true,
    summary:
      'One-time code from the kernel operator\'s /jin approval card. Needed only on the very first boot (no keystore yet) or a lost-keystore rebind; delete it after the first successful boot.',
    dev: '(only on first boot)',
    prod: '(only on first boot)',
  },
  {
    name: 'IMAJIN_APP_KEYSTORE',
    status: 'optional',
    phase: 'runtime',
    summary:
      'Path of this app\'s 0600 bootstrap keystore (never the vault key itself). Default ./.imajin/keystore.json relative to the process cwd. Must be writable, persist across deploys, and be separate for dev and prod.',
    dev: '/home/jin/.imajin/market.dev.keystore.json',
    prod: '/home/jin/.imajin/market.prod.keystore.json',
  },
  {
    name: 'IMAJIN_APP_PRIVATE_KEY',
    status: 'forbidden',
    phase: 'runtime',
    secret: true,
    summary:
      'Removed. The app throws at boot if this is set — the signing key comes from loadAppSigningKey(), never from env.',
    dev: '(never set)',
    prod: '(never set)',
  },
  {
    name: 'PORT',
    status: 'runtime-set',
    phase: 'runtime',
    summary:
      'Listen port. Set by the pm2 ecosystem entry (prod 7104, dev 3104); only used directly by `pnpm dev`.',
    dev: '3104',
    prod: '7104',
  },
  {
    name: 'NODE_ENV',
    status: 'runtime-set',
    phase: 'runtime',
    summary:
      'Set to `production` by the pm2 entry and by `next build`/`next start`. Do not set it in the env file.',
    dev: 'production',
    prod: 'production',
  },
  {
    name: 'NEXT_RUNTIME',
    status: 'runtime-set',
    phase: 'runtime',
    summary:
      'Injected by Next.js; instrumentation.ts only bootstraps the signing key when it is `nodejs`. Never set by hand.',
    dev: '(set by Next.js)',
    prod: '(set by Next.js)',
  },
  {
    name: 'LOG_LEVEL',
    status: 'optional',
    phase: 'runtime',
    summary:
      'pino log level for @ima-jin/logger (default info). Output is stdout only; pm2 captures it.',
    dev: 'debug',
    prod: 'info',
  },
  {
    name: 'ENABLE_REQUEST_LOG',
    status: 'optional',
    phase: 'runtime',
    summary:
      'Logger request-log switch. Leave unset: this app wires no log sink (AGENTS.md — stdout only).',
    dev: '(unset)',
    prod: '(unset)',
  },
  {
    name: 'ENABLE_APP_LOG',
    status: 'optional',
    phase: 'runtime',
    summary:
      'Logger persisted-log switch. Leave unset: this app never persists logs to a database.',
    dev: '(unset)',
    prod: '(unset)',
  },
  {
    name: 'LOG_DB_TRANSPORT',
    status: 'optional',
    phase: 'runtime',
    summary:
      'Logger DB-transport switch. Leave unset: logging must never touch a data store (AGENTS.md).',
    dev: '(unset)',
    prod: '(unset)',
  },
  {
    name: 'APP_LOG_LEVEL',
    status: 'optional',
    phase: 'runtime',
    summary:
      'Minimum level the logger would persist (default warn). Inert while persistence is off.',
    dev: '(unset)',
    prod: '(unset)',
  },
  {
    name: 'ATTESTATION_INTERNAL_API_KEY',
    status: 'dependency',
    phase: 'runtime',
    secret: true,
    summary:
      '@ima-jin/auth act-as / attestation calls. market exercises neither; leave unset. Never hand-mint it.',
    dev: '(unset)',
    prod: '(unset)',
  },
  {
    name: 'AUTH_INTERNAL_API_KEY',
    status: 'dependency',
    phase: 'runtime',
    secret: true,
    summary:
      'Deprecated @ima-jin/auth internal key (agent delegation). Not used by market; leave unset.',
    dev: '(unset)',
    prod: '(unset)',
  },
  {
    name: 'PROFILE_SERVICE_URL',
    status: 'dependency',
    phase: 'runtime',
    summary:
      '@ima-jin/auth credential resolution. Not used by market; leave unset.',
    dev: '(unset)',
    prod: '(unset)',
  },
  {
    name: 'PROFILE_INTERNAL_API_KEY',
    status: 'dependency',
    phase: 'runtime',
    secret: true,
    summary:
      '@ima-jin/auth credential resolution key. Not used by market; leave unset.',
    dev: '(unset)',
    prod: '(unset)',
  },
  {
    name: 'NODE_DID',
    status: 'dependency',
    phase: 'runtime',
    summary:
      '@ima-jin/auth node-act-as check (kernel node DID). Not used by market; leave unset.',
    dev: '(unset)',
    prod: '(unset)',
  },
  {
    name: 'APP_URL',
    status: 'dependency',
    phase: 'runtime',
    summary:
      '@ima-jin/auth fallback origin for redirects. market passes publicUrl explicitly (NEXT_PUBLIC_APP_URL); leave unset.',
    dev: '(unset)',
    prod: '(unset)',
  },
  {
    name: 'NEXT_PUBLIC_BASE_URL',
    status: 'dependency',
    phase: 'runtime',
    summary:
      '@ima-jin/auth fallback origin for redirects (after APP_URL). market does not rely on it; leave unset.',
    dev: '(unset)',
    prod: '(unset)',
  },
  {
    name: 'NEXT_PUBLIC_IMAJIN_AUTH_URL',
    status: 'template-unused',
    phase: 'build',
    summary:
      'Listed in the app template; no code in this repo reads it. Safe to omit.',
    dev: 'https://dev-jin.imajin.ai',
    prod: 'https://jin.imajin.ai',
  },
  {
    name: 'NEXT_PUBLIC_IMAJIN_APP_ID',
    status: 'template-unused',
    phase: 'build',
    summary:
      'Listed in the app template (registry `app_…` id); no code in this repo reads it. Safe to omit.',
    dev: '(optional)',
    prod: '(optional)',
  },
  {
    name: 'IMAJIN_APP_ATTESTATION_ID',
    status: 'template-unused',
    phase: 'runtime',
    summary:
      'Listed in the app template (service-level attestation id for kernel calls outside a user session); no code in this repo reads it. Safe to omit.',
    dev: '(optional)',
    prod: '(optional)',
  },
  {
    name: 'VERIFY_BOOT_PORT',
    status: 'optional',
    phase: 'script',
    summary:
      'Reserved for a CI boot check; unused today. Not used in deployment.',
    dev: '(unset)',
    prod: '(unset)',
  },
];

export const ENV_VAR_NAMES = ENV_VARS.map((v) => v.name);

const MIN_SECRET_LENGTH = 32;

function parseUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isLocalHost(hostname) {
  return hostname === 'localhost' || hostname === '::1' || hostname.startsWith('127.');
}

function checkKernelUrl(name, value, target, errors) {
  const url = parseUrl(value);
  if (url === null || !/^https?:$/.test(url.protocol)) {
    errors.push(`${name} is not a valid http(s) URL.`);
    return;
  }
  if (isLocalHost(url.hostname)) {
    errors.push(`${name} points at localhost — a deployed ${target} instance must use the real kernel host.`);
    return;
  }
  const isDevHost = url.hostname.startsWith('dev-');
  if (target === 'prod' && isDevHost) {
    errors.push(`${name} points at a dev host (${url.hostname}) in a prod env file.`);
  }
  if (target === 'dev' && !isDevHost) {
    errors.push(`${name} points at a non-dev host (${url.hostname}) in a dev env file — dev must never talk to the prod kernel.`);
  }
}

function checkSecret(name, value, errors) {
  if (value === '') return;
  if (value.includes('REPLACE_ME') || value.includes('CHANGE_ME')) {
    errors.push(`${name} is still a placeholder — generate a real value (openssl rand -hex 32).`);
  } else if (value.length < MIN_SECRET_LENGTH) {
    errors.push(`${name} is shorter than ${MIN_SECRET_LENGTH} characters.`);
  }
}

function checkPresence(get, errors) {
  for (const variable of ENV_VARS) {
    if (variable.status === 'required' && get(variable.name) === '') {
      errors.push(`${variable.name} is required but not set.`);
    }
    if (variable.status === 'forbidden' && get(variable.name) !== '') {
      errors.push(`${variable.name} must not be set (${variable.summary})`);
    }
  }
}

function checkKernelUrls(get, target, errors) {
  for (const name of ['AUTH_SERVICE_URL', 'PAY_SERVICE_URL', 'NEXT_PUBLIC_AUTH_URL']) {
    const value = get(name);
    if (value === '') continue;
    checkKernelUrl(name, value, target, errors);
    const prefix = name === 'PAY_SERVICE_URL' ? '/pay' : '/auth';
    if (!value.endsWith(prefix) && !value.endsWith(`${prefix}/`)) {
      errors.push(`${name} must include the ${prefix} prefix.`);
    }
  }
  for (const name of ['IMAJIN_KERNEL_URL', 'IMAJIN_AUTH_URL', 'NEXT_PUBLIC_APP_URL']) {
    if (get(name) !== '') checkKernelUrl(name, get(name), target, errors);
  }
  if (get('IMAJIN_KERNEL_URL') !== '' && get('IMAJIN_AUTH_URL') !== '') {
    if (parseUrl(get('IMAJIN_KERNEL_URL'))?.host !== parseUrl(get('IMAJIN_AUTH_URL'))?.host) {
      errors.push('IMAJIN_KERNEL_URL and IMAJIN_AUTH_URL must point at the same kernel host.');
    }
  }
}

function checkFixedValues(get, errors) {
  const databaseUrl = get('DATABASE_URL');
  if (databaseUrl !== '' && !/^postgres(ql)?:$/.test(parseUrl(databaseUrl)?.protocol ?? '')) {
    errors.push('DATABASE_URL must be a postgres:// or postgresql:// URL.');
  }
  const schema = get('APP_DB_SCHEMA');
  if (schema !== '' && schema !== SCHEMA) {
    errors.push(`APP_DB_SCHEMA must be \`${SCHEMA}\` — the existing schema this app owns; renaming it orphans migration state.`);
  }
  const basePath = get('NEXT_PUBLIC_BASE_PATH');
  if (basePath !== '' && basePath !== BASE_PATH) {
    errors.push(`NEXT_PUBLIC_BASE_PATH must be ${BASE_PATH}.`);
  }
}

function checkIdentity(get, errors) {
  const did = get('IMAJIN_APP_DID');
  if (did !== '' && !did.startsWith('did:imajin:')) {
    errors.push('IMAJIN_APP_DID must start with did:imajin:.');
  }
  if (did.includes('REPLACE_ME')) {
    errors.push('IMAJIN_APP_DID is still the REPLACE_ME placeholder — mint the app identity first (docs/REGISTRATION.md).');
  }
}

function checkEnvironmentSplit(get, target, errors) {
  const imajinEnv = get('IMAJIN_ENV');
  const prefix = get('NEXT_PUBLIC_SERVICE_PREFIX');
  if (target === 'dev') {
    if (imajinEnv !== 'dev') {
      errors.push('IMAJIN_ENV must be `dev` on the dev instance (selects the imajin_session_dev cookie).');
    }
    if (prefix !== 'dev-') {
      errors.push('NEXT_PUBLIC_SERVICE_PREFIX must be `dev-` on the dev instance (the /dashboard redirect would otherwise target the prod kernel).');
    }
  } else {
    if (imajinEnv === 'dev') {
      errors.push('IMAJIN_ENV=dev must not be set on prod (it would read the dev session cookie).');
    }
    if (prefix.startsWith('dev')) {
      errors.push('NEXT_PUBLIC_SERVICE_PREFIX points at dev in a prod env file.');
    }
  }
}

function collectWarnings(get, target) {
  const warnings = [];
  const port = get('PORT');
  if (port !== '' && port !== String(TARGETS[target].port)) {
    warnings.push(`PORT is set in the env file but ${TARGETS[target].name} runs on ${TARGETS[target].port}; the pm2 entry's value wins.`);
  }
  if (get('IMAJIN_APP_CLAIM_CODE') !== '') {
    warnings.push('IMAJIN_APP_CLAIM_CODE is set — it is needed on the first boot only; remove it once the app has booted once.');
  }
  for (const name of ['ENABLE_APP_LOG', 'LOG_DB_TRANSPORT', 'ENABLE_REQUEST_LOG']) {
    if (get(name) === 'true') {
      warnings.push(`${name}=true — this app is stdout-logging only (AGENTS.md); leave it unset.`);
    }
  }
  return warnings;
}

/**
 * Pure validation of a parsed env file for a deploy target. Returns
 * `{ errors, warnings }`; messages name variables, never values.
 * @param {Record<string, string | undefined>} env
 * @param {'prod' | 'dev'} target
 */
export function validateEnv(env, target) {
  if (!(target in TARGETS)) {
    throw new Error(`Unknown target ${JSON.stringify(target)} — expected prod or dev.`);
  }
  const errors = [];
  const get = (name) => (env[name] ?? '').trim();

  checkPresence(get, errors);
  checkFixedValues(get, errors);
  checkKernelUrls(get, target, errors);
  checkSecret('SESSION_SECRET', get('SESSION_SECRET'), errors);
  checkSecret('WEBHOOK_SECRET', get('WEBHOOK_SECRET'), errors);
  checkIdentity(get, errors);
  checkEnvironmentSplit(get, target, errors);

  return { errors, warnings: collectWarnings(get, target) };
}

/**
 * Reads and parses an env file WITHOUT touching process.env.
 * @param {string} path
 */
export function readEnvFile(path) {
  return parseEnv(readFileSync(path, 'utf8'));
}
