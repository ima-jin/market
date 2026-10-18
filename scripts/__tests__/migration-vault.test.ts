import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main as baseline } from '../migrate-baseline.mjs';
import { main as migrate } from '../migrate.mjs';
import { loadMigrationDatabaseUrl } from '../lib/migration-database.mjs';
import { BaselineMismatchError } from '../lib/migrate-baseline-core.mjs';

const mocks = vi.hoisted(() => ({
  vault: vi.fn(), connect: vi.fn(), end: vi.fn(), baseline: vi.fn(),
  migrate: vi.fn(), drizzle: vi.fn(),
}));
vi.mock('node:module', async (original) => ({
  ...await original<typeof import('node:module')>(),
  createRequire: () => () => ({ loadFromVault: mocks.vault }),
}));
vi.mock('postgres', () => ({ default: mocks.connect }));
vi.mock('drizzle-orm/postgres-js', () => ({ drizzle: mocks.drizzle }));
vi.mock('drizzle-orm/postgres-js/migrator', () => ({ migrate: mocks.migrate }));
vi.mock('../lib/migrate-baseline-core.mjs', async (original) => ({
  ...await original<typeof import('../lib/migrate-baseline-core.mjs')>(),
  runBaseline: mocks.baseline,
}));

const FAKE_URL = 'FAKE_TEST_ONLY_VAULT_DATABASE_LOCATOR';
const FAKE_ERROR = 'FAKE_TEST_ONLY_PROVIDER_OR_DRIVER_TEXT';
const entries = [['baseline', baseline], ['migrate', migrate]] as const;
let dir: string;
let legacyReads: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'market-migration-vault-'));
  vi.stubEnv('MIGRATIONS_TEST_DATABASE_URL', undefined);
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('CI', undefined);
  vi.stubEnv('IMAJIN_APP_DID', 'did:imajin:market-test');
  vi.stubEnv('IMAJIN_KERNEL_URL', 'https://kernel.example.test');
  vi.stubEnv('IMAJIN_APP_KEYSTORE', join(dir, 'test.keystore'));
  mocks.vault.mockReset().mockResolvedValue({ values: { DATABASE_URL: FAKE_URL }, degraded: [] });
  mocks.end.mockReset().mockResolvedValue(undefined);
  mocks.connect.mockReset().mockReturnValue({ end: mocks.end });
  mocks.baseline.mockReset().mockResolvedValue({ status: 'fresh-database' });
  mocks.migrate.mockReset().mockResolvedValue(undefined);
  mocks.drizzle.mockReset().mockReturnValue({ fakeDatabase: true });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  legacyReads = 0;
  const guardedEnv = new Proxy({ ...process.env }, {
    get(target, key) {
      if (key === 'DATABASE_URL') {
        legacyReads += 1;
        throw new Error('FAKE_TEST_ONLY_LEGACY_ENV_READ_FORBIDDEN');
      }
      return Reflect.get(target, key);
    },
  });
  vi.stubGlobal('process', new Proxy(process, {
    get(target, key) {
      return key === 'env' ? guardedEnv : Reflect.get(target, key);
    },
  }));
});
afterEach(() => {
  expect(legacyReads).toBe(0);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('vault-backed deployment migration entry points', () => {
  it.each(entries)('%s accepts the same check-env-valid file without a database env credential', async (_name, main) => {
    const file = join(dir, 'server.env');
    const source = readFileSync('.env.prod.example', 'utf8')
      .replace('did:imajin:REPLACE_ME', 'did:imajin:market-test');
    writeFileSync(file, source);
    const checked = spawnSync(process.execPath, ['scripts/check-env.mjs', 'prod', '--file', file], {
      env: { PATH: process.env.PATH, NODE_ENV: 'production' }, encoding: 'utf8',
    });
    expect(checked.status).toBe(0);
    const config = parseEnv(source);
    expect(config.DATABASE_URL).toBeUndefined();
    for (const [key, value] of Object.entries(config)) vi.stubEnv(key, value);

    expect(await main([])).toBe(0);
    expect(mocks.vault).toHaveBeenCalledWith({
      appDid: config.IMAJIN_APP_DID, kernelUrl: config.IMAJIN_KERNEL_URL,
      keystorePath: config.IMAJIN_APP_KEYSTORE,
      keys: [{ key: 'DATABASE_URL', onMissing: 'fail' }],
      fetchOptions: { signal: expect.any(AbortSignal) },
    });
    expect(mocks.connect).toHaveBeenCalledWith(FAKE_URL, { max: 1, onnotice: expect.any(Function) });
    expect(mocks.end).toHaveBeenCalledWith({ timeout: 5 });
    expect(JSON.stringify([vi.mocked(console.log).mock.calls, vi.mocked(console.error).mock.calls]))
      .not.toContain(FAKE_URL);
  });

  it('waits for the vault before constructing any database client and passes the app tracking schema', async () => {
    let resolve!: (result: { values: { DATABASE_URL: string }; degraded: string[] }) => void;
    mocks.vault.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const running = migrate([]);
    await vi.waitFor(() => expect(mocks.vault).toHaveBeenCalledOnce());
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.migrate).not.toHaveBeenCalled();
    resolve({ values: { DATABASE_URL: FAKE_URL }, degraded: [] });
    expect(await running).toBe(0);
    expect(mocks.migrate).toHaveBeenCalledWith({ fakeDatabase: true }, {
      migrationsFolder: expect.stringMatching(/\/migrations$/), migrationsSchema: 'market',
    });
  });

  it.each(entries)('%s fails closed on a refused fetch without using legacy env or exposing provider text', async (_name, main) => {
    mocks.vault.mockRejectedValue(new Error(FAKE_ERROR));
    expect(await main([])).toBe(2);
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.baseline).not.toHaveBeenCalled();
    expect(mocks.migrate).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(FAKE_ERROR);
  });

  it.each([undefined, '', 123])('rejects unavailable or invalid returned values (%j)', async (value) => {
    mocks.vault.mockResolvedValue({ values: { DATABASE_URL: value }, degraded: [] });
    await expect(loadMigrationDatabaseUrl()).rejects.toThrow('Migration DATABASE_URL unavailable');
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it.each(entries)('%s suppresses driver and cleanup error values and closes a constructed client', async (_name, main) => {
    mocks.connect.mockImplementationOnce(() => { throw new Error(FAKE_ERROR); });
    expect(await main([])).toBe(2);
    expect(mocks.end).not.toHaveBeenCalled();
    mocks.end.mockRejectedValue(new Error(FAKE_ERROR));
    expect(await main([])).toBe(2);
    expect(mocks.end).toHaveBeenCalledOnce();
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(FAKE_ERROR);
  });

  it('preserves baseline refusal exit 1 while redacting mismatch values and closing the client', async () => {
    mocks.baseline.mockRejectedValue(new BaselineMismatchError([FAKE_ERROR]));
    expect(await baseline(['--dry-run'])).toBe(1);
    expect(mocks.baseline).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ dryRun: true }));
    expect(mocks.end).toHaveBeenCalledOnce();
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(FAKE_ERROR);
  });

  it('redacts a migration SQL error and still closes the client', async () => {
    mocks.migrate.mockRejectedValue(new Error(FAKE_ERROR));
    expect(await migrate([])).toBe(2);
    expect(mocks.end).toHaveBeenCalledOnce();
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(FAKE_ERROR);
  });

  it.each(entries)('%s rejects arguments without logging caller values or fetching credentials', async (_name, main) => {
    expect(await main([FAKE_ERROR])).toBe(2);
    expect(mocks.vault).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(FAKE_ERROR);
  });

  it.each(['test', 'ci'])('allows only an explicit isolated %s database override', async (context) => {
    vi.stubEnv('NODE_ENV', context === 'test' ? 'test' : undefined);
    vi.stubEnv('CI', context === 'ci' ? 'true' : undefined);
    vi.stubEnv('MIGRATIONS_TEST_DATABASE_URL', FAKE_URL);
    expect(await migrate([])).toBe(0);
    expect(mocks.vault).not.toHaveBeenCalled();
    expect(mocks.connect).toHaveBeenCalledWith(FAKE_URL, expect.anything());
  });

  it.each(['production', 'development'])('refuses the test override outside test/CI (%s)', async (mode) => {
    vi.stubEnv('NODE_ENV', mode);
    vi.stubEnv('MIGRATIONS_TEST_DATABASE_URL', FAKE_URL);
    expect(await migrate([])).toBe(2);
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it('refuses the override even with CI=true in production and rejects an empty override in tests', async () => {
    vi.stubEnv('CI', 'true');
    vi.stubEnv('MIGRATIONS_TEST_DATABASE_URL', FAKE_URL);
    expect(await migrate([])).toBe(2);
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('MIGRATIONS_TEST_DATABASE_URL', '');
    expect(await migrate([])).toBe(2);
    expect(mocks.connect).not.toHaveBeenCalled();
  });
});
