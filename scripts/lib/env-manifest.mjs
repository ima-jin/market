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
// The variable list is pure data, kept in env-manifest.json (see the legend above for the fields).
// `secret` is only present, as true, on variables whose value must never be logged.
/** @type {Array<{ name: string, status: string, phase: string, secret?: boolean, summary: string, dev: string, prod: string }>} */
export const ENV_VARS = JSON.parse(readFileSync(new URL('./env-manifest.json', import.meta.url), 'utf8'));

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
