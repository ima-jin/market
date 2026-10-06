import { spawnSync } from 'node:child_process';
import { accessSync, constants, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const require = createRequire(import.meta.url);

type App = {
  name: string;
  cwd: string;
  script: string;
  args: string;
  interpreter: string;
  node_args: string;
  exec_mode: string;
  env: Record<string, string | number>;
  out_file: string;
  error_file: string;
};
const { apps } = require(join(ROOT, 'ecosystem.config.cjs')) as { apps: App[] };
const byName = (name: string) => apps.find((app) => app.name === name) as App;

describe('ecosystem.config.cjs', () => {
  it('defines exactly prod-market and dev-market', () => {
    expect(apps.map((app) => app.name)).toEqual(['prod-market', 'dev-market']);
  });

  it.each([
    ['prod-market', 7104],
    ['dev-market', 3104],
  ])('%s listens on %i (the ports the Caddy route already targets)', (name, port) => {
    const app = byName(name);
    expect(app.args).toBe(`start -p ${port}`);
    expect(app.env.PORT).toBe(port);
    expect(app.env.NODE_ENV).toBe('production');
  });

  it('execs the Next listener directly, never through npm (imajin-ai#2447)', () => {
    for (const app of apps) {
      expect(app.script).toBe('node_modules/next/dist/bin/next');
      expect(app.interpreter).toBe('node');
      expect(app.exec_mode).toBe('fork');
      expect(JSON.stringify(app)).not.toMatch(/"npm"|npm start/);
      accessSync(join(app.cwd, app.script), constants.R_OK);
    }
  });

  it('runs from the checkout and loads that checkout\'s .env.local via --env-file', () => {
    for (const app of apps) {
      expect(app.cwd).toBe(ROOT.replace(/\/$/, ''));
      expect(app.node_args).toBe(`--env-file=${join(app.cwd, '.env.local')}`);
    }
  });

  it('gives each app its own stdout and stderr log under ~/.pm2/logs', () => {
    const logDir = join(homedir(), '.pm2', 'logs');
    for (const app of apps) {
      expect(app.out_file).toBe(join(logDir, `${app.name}-out.log`));
      expect(app.error_file).toBe(join(logDir, `${app.name}-error.log`));
    }
    const logs = apps.flatMap((app) => [app.out_file, app.error_file]);
    expect(new Set(logs).size).toBe(logs.length);
  });

  it('carries no secrets or app config in the tracked file', () => {
    for (const app of apps) {
      expect(Object.keys(app.env).sort()).toEqual(['NODE_ENV', 'PORT']);
    }
    expect(readFileSync(join(ROOT, 'ecosystem.config.cjs'), 'utf8')).not.toMatch(/DATABASE_URL|CLAIM_CODE|PRIVATE_KEY|postgres:\/\//);
  });
});

function deploy(args: string[], extraEnv: Record<string, string> = {}) {
  return spawnSync('bash', [join(ROOT, 'scripts/deploy.sh'), ...args], {
    env: { PATH: process.env.PATH ?? '', ...extraEnv } as unknown as NodeJS.ProcessEnv,
    encoding: 'utf8',
  });
}

describe('scripts/deploy.sh', () => {
  it('is executable and passes bash syntax checking', () => {
    accessSync(join(ROOT, 'scripts/deploy.sh'), constants.X_OK);
    expect(spawnSync('bash', ['-n', join(ROOT, 'scripts/deploy.sh')]).status).toBe(0);
  });

  it.each([
    ['prod', 'prod-market', '7104'],
    ['dev', 'dev-market', '3104'],
  ])('--dry-run %s prints the full plan in order and executes nothing', (target, name, port) => {
    const result = deploy([target, '--dry-run']);
    expect(result.status).toBe(0);

    const plan = result.stdout;
    const order = [
      '[1/8] preflight',
      '[2/8] checkout origin/main',
      'git checkout --detach origin/main',
      '[3/8] env check',
      `scripts/check-env.mjs ${target}`,
      '[4/8] install',
      'pnpm install --frozen-lockfile',
      '[5/8] build',
      'node_modules/next/dist/bin/next build',
      '[6/8] migration baseline',
      'scripts/migrate-baseline.mjs',
      'node_modules/drizzle-kit/bin.cjs migrate',
      '[7/8] restart',
      `pm2 startOrReload ecosystem.config.cjs --only ${name} --update-env`,
      'pm2 save',
      '[8/8] health check',
      `http://127.0.0.1:${port}/market/api/health`,
      'Dry run complete.',
    ];
    let cursor = -1;
    for (const marker of order) {
      const index = plan.indexOf(marker, cursor + 1);
      expect(index, `"${marker}" missing or out of order`).toBeGreaterThan(cursor);
      cursor = index;
    }
  });

  it('loads the env file for build, baseline and migrate (NEXT_PUBLIC_* baked at build time)', () => {
    const { stdout } = deploy(['prod', '--dry-run']);
    const envFile = `--env-file=${join(ROOT, '.env.local')}`;
    for (const marker of ['next/dist/bin/next build', 'scripts/migrate-baseline.mjs', 'drizzle-kit/bin.cjs migrate']) {
      expect(stdout).toContain(`${envFile} node_modules/${marker}`.replace('node_modules/scripts', 'scripts'));
    }
  });

  it('baselines before migrating and migrates before restarting', () => {
    const { stdout } = deploy(['prod', '--dry-run']);
    expect(stdout.indexOf('migrate-baseline.mjs')).toBeLessThan(stdout.indexOf('drizzle-kit/bin.cjs migrate'));
    expect(stdout.indexOf('drizzle-kit/bin.cjs migrate')).toBeLessThan(stdout.indexOf('pm2 startOrReload'));
  });

  it('honours --ref (also the rollback path)', () => {
    const { status, stdout } = deploy(['prod', '--ref', 'v1.2.3', '--dry-run']);
    expect(status).toBe(0);
    expect(stdout).toContain('git checkout --detach v1.2.3');
    expect(stdout).not.toContain('origin/main');
  });

  it('ignores contract variables inherited from the caller\'s shell (names only, never values)', () => {
    const polluted = deploy(['prod', '--dry-run'], { DATABASE_URL: 'postgres://stray-value', APP_DB_SCHEMA: 'wrong' });
    expect(polluted.status).toBe(0);
    expect(polluted.stdout).toMatch(/Ignoring variables inherited from the calling shell \(the env file wins\): DATABASE_URL APP_DB_SCHEMA/);
    expect(polluted.stdout).not.toContain('stray-value');

    expect(deploy(['prod', '--dry-run']).stdout).not.toContain('Ignoring variables inherited');
  });

  it('passes the env file to check-env with --file (Node would swallow --env-file)', () => {
    expect(deploy(['dev', '--dry-run']).stdout).toContain(`scripts/check-env.mjs dev --file ${join(ROOT, '.env.local')}`);
  });

  it('never git-pulls', () => {
    expect(readFileSync(join(ROOT, 'scripts/deploy.sh'), 'utf8')).not.toMatch(/git pull/);
  });

  it.each([[[]], [['staging']], [['prod', '--bogus']], [['prod', '--ref']]])('exits 2 with usage for %j', (args) => {
    const result = deploy(args);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/Usage: scripts\/deploy\.sh/);
  });
});

describe('deploy docs', () => {
  const docs = readFileSync(join(ROOT, 'docs/DEPLOY.md'), 'utf8');

  it('documents the one command, the Caddy route and both pm2 names', () => {
    expect(docs).toContain('scripts/deploy.sh prod');
    expect(docs).toContain('scripts/deploy.sh dev');
    expect(docs).toContain('reverse_proxy localhost:7104');
    expect(docs).toContain('reverse_proxy localhost:3104');
    expect(docs).toContain('jin.imajin.ai');
    expect(docs).toContain('prod-market');
    expect(docs).toContain('dev-market');
    expect(docs).toContain('migrate-baseline.mjs');
  });

  it('keeps the Caddy prefix intact (handle, not handle_path)', () => {
    expect(docs).toMatch(/handle @market/);
    expect(docs).not.toMatch(/^\s*handle_path /m);
  });
});
