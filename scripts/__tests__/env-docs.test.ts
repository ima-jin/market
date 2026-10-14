import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import { renderEnvDocs } from '../lib/env-docs-render.mjs';
import { ENV_VAR_NAMES, ENV_VARS, validateEnv } from '../lib/env-manifest.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const read = (relative: string) => readFileSync(join(ROOT, relative), 'utf8');
const CHECK_ENV = join(ROOT, 'scripts/check-env.mjs');
// The installed SDK still supports this fallback; market must never expose it.
const RETIRED_CLAIM_ENV = 'IMAJIN_APP_CLAIM_CODE';
const RETIRED_CLAIM_WARNING =
  'IMAJIN_APP_CLAIM_CODE is ignored — claim at /market/claim and delete IMAJIN_APP_CLAIM_CODE from the env file.';

function childEnv(): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? '' } as unknown as NodeJS.ProcessEnv;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (['node_modules', '.next', '__tests__', 'coverage', '.git'].includes(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry) && !entry.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

function envNamesIn(source: string): string[] {
  const names = new Set<string>();
  for (const match of source.matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)) names.add(match[1]);
  for (const match of source.matchAll(/process\.env\[\s*['"]([A-Z][A-Z0-9_]+)['"]\s*\]/g)) names.add(match[1]);
  return [...names];
}

describe('env contract coverage', () => {
  const manifest = new Set(ENV_VAR_NAMES);

  it('pins both public auth SDK packages exactly to 0.8.18', () => {
    const pkg = JSON.parse(read('package.json')) as { dependencies: Record<string, string> };
    expect(pkg.dependencies['@ima-jin/auth']).toBe('0.8.18');
    expect(pkg.dependencies['@ima-jin/auth-client']).toBe('0.8.18');
  });

  it('has no shared callback credential or secret-generation instructions in operator contracts', () => {
    const retired = ['WEBHOOK', 'SECRET'].join('_');
    const generation = ['openssl', 'rand'].join(' ');
    const contracts = [
      '.env.example', '.env.dev.example', '.env.prod.example',
      'scripts/lib/env-manifest.json', 'scripts/lib/env-manifest.mjs', 'scripts/check-env.mjs',
      'scripts/lib/env-docs-render.mjs', 'README.md', 'AGENTS.md', 'api-spec/openapi.yaml',
      ...readdirSync(join(ROOT, 'docs')).filter((file) => file.endsWith('.md')).map((file) => `docs/${file}`),
    ];
    for (const file of contracts) {
      expect(read(file), file).not.toContain(retired);
      expect(read(file), file).not.toContain(generation);
    }
  });

  it('has no duplicate manifest entries and every entry is complete', () => {
    expect(new Set(ENV_VAR_NAMES).size).toBe(ENV_VAR_NAMES.length);
    for (const variable of ENV_VARS) {
      expect(variable.summary.length, variable.name).toBeGreaterThan(10);
      expect(variable.dev, variable.name).toBeTruthy();
      expect(variable.prod, variable.name).toBeTruthy();
    }
  });

  it('documents every variable read by this repo (app, config, scripts)', () => {
    const files = [
      ...walk(join(ROOT, 'app')),
      ...walk(join(ROOT, 'src')),
      ...walk(join(ROOT, 'scripts')),
      join(ROOT, 'instrumentation.ts'),
      join(ROOT, 'next.config.js'),
      join(ROOT, 'drizzle.config.ts'),
      join(ROOT, 'ecosystem.config.cjs'),
    ];
    const undocumented = files.flatMap((file) =>
      envNamesIn(readFileSync(file, 'utf8'))
        .filter((name) => !manifest.has(name))
        .map((name) => `${name} (${file.replace(ROOT, '')})`),
    );
    expect(undocumented).toEqual([]);
  });

  it('documents every variable read by the installed @ima-jin/* packages', () => {
    const base = join(ROOT, 'node_modules/@ima-jin');
    const undocumented: string[] = [];
    for (const pkg of readdirSync(base)) {
      const dist = join(base, pkg, 'dist');
      for (const file of walk(dist)) {
        for (const name of envNamesIn(readFileSync(file, 'utf8'))) {
          if ((pkg === 'auth-client' && name === RETIRED_CLAIM_ENV) || name === 'SESSION_SECRET') {
            expect(manifest.has(name)).toBe(false);
            continue;
          }
          if (!manifest.has(name)) undocumented.push(`${name} (@ima-jin/${pkg})`);
        }
      }
    }
    expect([...new Set(undocumented)]).toEqual([]);
  });

  it('keeps IMAJIN_APP_CLAIM_CODE absent except for the names-only cleanup warning', () => {
    const result = spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' });
    expect(result.status).toBe(0);
    const files = result.stdout.split('\0').filter((file) => file && !file.includes('__tests__/'));
    for (const file of files) {
      const source = read(file);
      if (file === 'scripts/lib/env-manifest.mjs') {
        const references = source.split('\n').filter((line) => line.includes(RETIRED_CLAIM_ENV));
        expect(references).toEqual([
          `  if (get('${RETIRED_CLAIM_ENV}') !== '') {`,
          `    warnings.push('${RETIRED_CLAIM_WARNING}');`,
        ]);
      } else {
        expect(source, file).not.toContain(RETIRED_CLAIM_ENV);
      }
    }
  });

  it('lists every variable in .env.example and docs/ENVIRONMENTS.md', () => {
    const example = read('.env.example');
    const docs = read('docs/ENVIRONMENTS.md');
    for (const name of ENV_VAR_NAMES) {
      expect(example, `.env.example is missing ${name}`).toMatch(new RegExp(`^#?\\s*${name}=|^# ${name}\\b`, 'm'));
      expect(docs, `docs/ENVIRONMENTS.md is missing ${name}`).toContain(`\`${name}\``);
    }
  });

  it('keeps docs/ENVIRONMENTS.md identical to the generated output (node scripts/gen-env-docs.mjs)', () => {
    const rendered = renderEnvDocs({ devExample: read('.env.dev.example'), prodExample: read('.env.prod.example') });
    expect(read('docs/ENVIRONMENTS.md')).toBe(rendered);
  });

  it('shows both a dev and a prod example in docs/ENVIRONMENTS.md', () => {
    const docs = read('docs/ENVIRONMENTS.md');
    expect(docs).toContain('## Dev example');
    expect(docs).toContain('## Prod example');
    expect(docs).toContain(read('.env.dev.example').trim());
    expect(docs).toContain(read('.env.prod.example').trim());
  });

  it('keeps secrets out of every example file (placeholders only)', () => {
    for (const file of ['.env.example', '.env.dev.example', '.env.prod.example']) {
      const parsed = parseEnv(read(file));
      for (const variable of ENV_VARS.filter((v) => v.secret)) {
        const value = parsed[variable.name] ?? '';
        if (variable.name === 'DATABASE_URL') {
          expect(value, file).toMatch(/^postgres:\/\/[^:@/]+:(CHANGE_ME|password)@/);
        } else {
          expect(value, `${file} ${variable.name}`).toMatch(/^(|REPLACE_ME)$/);
        }
      }
    }
  });
});

const GOOD_SECRET = 'FAKE_TEST_ONLY_NOT_A_SECRET'.repeat(3);

function filled(file: string, overrides: Record<string, string> = {}) {
  return {
    ...parseEnv(read(file)),
    IMAJIN_APP_DID: 'did:imajin:abc123',
    ...overrides,
  };
}

describe('validateEnv', () => {
  it.each([
    ['dev', '.env.dev.example'],
    ['prod', '.env.prod.example'],
  ] as const)('accepts the shipped %s example apart from the placeholders', (target, file) => {
    const { errors } = validateEnv(parseEnv(read(file)), target);
    expect(errors).toHaveLength(1);
    expect(errors.join('\n')).toMatch(/IMAJIN_APP_DID is still the REPLACE_ME placeholder/);
  });

  it('accepts a fully filled-in file for each target', () => {
    for (const [target, file] of [['dev', '.env.dev.example'], ['prod', '.env.prod.example']] as const) {
      expect(validateEnv(filled(file), target)).toEqual({ errors: [], warnings: [] });
    }
  });

  const validProd = (overrides: Record<string, string> = {}) => filled('.env.prod.example', overrides);
  const validDev = (overrides: Record<string, string> = {}) => filled('.env.dev.example', overrides);
  const errorsOf = (env: Record<string, string | undefined>, target: 'dev' | 'prod') =>
    validateEnv(env, target).errors.join('\n');

  it('reports every missing required variable by name', () => {
    const { errors } = validateEnv({}, 'prod');
    for (const variable of ENV_VARS.filter((v) => v.status === 'required')) {
      expect(errors).toContain(`${variable.name} is required but not set.`);
    }
  });

  it('rejects a raw private key', () => {
    expect(errorsOf(validProd({ IMAJIN_APP_PRIVATE_KEY: 'x' }), 'prod')).toMatch(/IMAJIN_APP_PRIVATE_KEY must not be set/);
  });

  it('keeps dev and prod apart', () => {
    expect(errorsOf(validProd({ IMAJIN_ENV: 'dev' }), 'prod')).toMatch(/IMAJIN_ENV=dev must not be set on prod/);
    expect(errorsOf(validProd({ NEXT_PUBLIC_SERVICE_PREFIX: 'dev-' }), 'prod')).toMatch(/SERVICE_PREFIX points at dev/);
    expect(errorsOf(validProd({ AUTH_SERVICE_URL: 'https://dev-jin.imajin.ai/auth' }), 'prod')).toMatch(/dev host/);
    expect(errorsOf(validDev({ IMAJIN_ENV: '' }), 'dev')).toMatch(/IMAJIN_ENV must be `dev`/);
    expect(errorsOf(validDev({ NEXT_PUBLIC_SERVICE_PREFIX: '' }), 'dev')).toMatch(/SERVICE_PREFIX must be `dev-`/);
    expect(errorsOf(validDev({ IMAJIN_KERNEL_URL: 'https://jin.imajin.ai' }), 'dev')).toMatch(/non-dev host/);
    expect(errorsOf(validDev({ PAY_SERVICE_URL: 'https://jin.imajin.ai/pay' }), 'dev')).toMatch(/PAY_SERVICE_URL points at a non-dev host/);
  });

  it('rejects localhost kernels, mismatched kernel hosts and missing /auth or /pay prefixes', () => {
    expect(errorsOf(validProd({ IMAJIN_KERNEL_URL: 'http://localhost:3000' }), 'prod')).toMatch(/localhost/);
    expect(errorsOf(validProd({ IMAJIN_AUTH_URL: 'https://other.imajin.ai' }), 'prod')).toMatch(/same kernel host/);
    expect(errorsOf(validProd({ AUTH_SERVICE_URL: 'https://jin.imajin.ai' }), 'prod')).toMatch(/\/auth prefix/);
    expect(errorsOf(validProd({ PAY_SERVICE_URL: 'https://jin.imajin.ai' }), 'prod')).toMatch(/\/pay prefix/);
    expect(errorsOf(validProd({ AUTH_SERVICE_URL: 'not a url' }), 'prod')).toMatch(/not a valid http/);
  });

  it('rejects a wrong schema, base path, database URL and DID', () => {
    const errors = errorsOf(
      validProd({ APP_DB_SCHEMA: 'other', NEXT_PUBLIC_BASE_PATH: '/x', DATABASE_URL: 'mysql://h/db', IMAJIN_APP_DID: 'abc' }),
      'prod',
    );
    expect(errors).toMatch(/APP_DB_SCHEMA must be `market`/);
    expect(errors).toMatch(/NEXT_PUBLIC_BASE_PATH must be \/market/);
    expect(errors).toMatch(/DATABASE_URL must be a postgres/);
    expect(errors).toMatch(/must start with did:imajin:/);
  });

  it('does not require or validate a stale session env value', () => {
    expect(ENV_VAR_NAMES).not.toContain('SESSION_SECRET');
    expect(validateEnv(validProd(), 'prod')).toEqual({ errors: [], warnings: [] });
    expect(validateEnv(validProd({ SESSION_SECRET: 'FAKE_IGNORED' }), 'prod'))
      .toEqual({ errors: [], warnings: [] });
    for (const file of ['.env.example', '.env.dev.example', '.env.prod.example',
      'README.md', 'docs/REGISTRATION.md', 'docs/DEPLOY.md', 'docs/ENVIRONMENTS.md']) {
      expect(read(file), file).not.toContain('SESSION_SECRET');
    }
  });

  it.each([
    ['dev', '.env.dev.example'],
    ['prod', '.env.prod.example'],
  ] as const)('warns about ignored IMAJIN_APP_CLAIM_CODE on %s without errors or value disclosure', (target, file) => {
    const value = 'FAKE_ENV_CLAIM_CODE_IGNORED';
    const result = validateEnv(filled(file, { [RETIRED_CLAIM_ENV]: value }), target);
    expect(result).toEqual({ errors: [], warnings: [RETIRED_CLAIM_WARNING] });
    expect(JSON.stringify(result)).not.toContain(value);
  });

  it.each(['', '   '])('does not warn about an empty legacy claim variable (%j)', (value) => {
    expect(validateEnv(validProd({ [RETIRED_CLAIM_ENV]: value }), 'prod'))
      .toEqual({ errors: [], warnings: [] });
  });

  it('warns (without failing) about port and logging leftovers', () => {
    const { errors, warnings } = validateEnv(
      validProd({ PORT: '9999', LOG_DB_TRANSPORT: 'true' }),
      'prod',
    );
    expect(errors).toEqual([]);
    expect(warnings.join('\n')).toMatch(/PORT is set/);
    expect(warnings.join('\n')).toMatch(/LOG_DB_TRANSPORT=true/);
  });

  it('throws on an unknown target', () => {
    expect(() => validateEnv({}, 'staging' as never)).toThrow(/Unknown target/);
  });
});

describe('check-env CLI', () => {
  const dir = mkdtempSync(join(tmpdir(), 'market-check-env-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const cli = (args: string[]) => spawnSync(process.execPath, [CHECK_ENV, ...args], { env: childEnv(), encoding: 'utf8', cwd: dir });

  it('exits 0 for a valid file and prints names/messages only', () => {
    const file = join(dir, 'ok.env');
    const lines = Object.entries(filled('.env.prod.example')).map(([key, value]) => `${key}=${value}`);
    writeFileSync(file, `${lines.join('\n')}\n`);
    const result = cli(['prod', '--file', file]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/is valid for prod/);
    expect(result.stdout + result.stderr).not.toContain(GOOD_SECRET);
  });

  it.each([
    ['dev', '.env.dev.example'],
    ['prod', '.env.prod.example'],
  ] as const)('warns exactly once for a stale claim code in a %s env file without echoing its value', (target, example) => {
    const file = join(dir, `stale-claim-${target}.env`);
    const value = 'FAKE_STALE_CLAIM_CODE';
    const env = filled(example, { [RETIRED_CLAIM_ENV]: value });
    writeFileSync(file, `${Object.entries(env).map(([name, entry]) => `${name}=${entry}`).join('\n')}\n`);
    const result = cli([target, '--file', file]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe(`warn:  ${RETIRED_CLAIM_WARNING}\n`);
    expect(result.stdout).toContain(`is valid for ${target}`);
    expect(result.stdout + result.stderr).not.toContain(value);
  });

  it('exits 1 for an invalid file without echoing any value', () => {
    const file = join(dir, 'bad.env');
    writeFileSync(file, 'DATABASE_URL=postgres://u:supersecretvalue@h/db\nIMAJIN_APP_PRIVATE_KEY=supersecretkey\n');
    const result = cli(['prod', '--file', file]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/IMAJIN_APP_PRIVATE_KEY must not be set/);
    expect(result.stdout + result.stderr).not.toContain('supersecret');
  });

  it('exits 2 on a missing file, an unknown target, and stray arguments', () => {
    expect(cli(['prod', '--file', join(dir, 'nope.env')]).status).toBe(2);
    expect(cli(['staging']).status).toBe(2);
    expect(cli(['prod', '--wat']).status).toBe(2);
  });
});
