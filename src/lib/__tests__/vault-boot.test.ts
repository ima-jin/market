import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearSelfSecrets, getServerConfig, loadSelfSecrets, SelfSecretsUnavailableError } from '../self-secrets';

const { load, postgres, drizzle, select } = vi.hoisted(() => ({
  load: vi.fn(), postgres: vi.fn(), drizzle: vi.fn(), select: vi.fn(),
}));
vi.mock('@ima-jin/auth-client', async (original) => {
  const { mockVaultBoot } = await import('../../../test/__tests__/vault-boot.stub');
  return {
    ...await original<typeof import('@ima-jin/auth-client')>(),
    createVaultBoot: mockVaultBoot(load),
  };
});
vi.mock('postgres', () => ({ default: postgres }));
vi.mock('drizzle-orm/postgres-js', () => ({ drizzle }));

const credentials = () => ({
  values: {
    DATABASE_URL: 'FAKE_TEST_ONLY_VAULT_DATABASE_LOCATOR',
    SESSION_SECRET: 'FAKE_TEST_ONLY_VAULT_SESSION_MATERIAL',
  },
  degraded: [],
});
const databaseKey = Symbol.for('imajin.market.database');
const databaseStore = globalThis as { [databaseKey]?: unknown };

beforeEach(() => {
  clearSelfSecrets();
  delete databaseStore[databaseKey];
  load.mockReset().mockResolvedValue(credentials());
  postgres.mockReset().mockReturnValue({});
  select.mockReset().mockReturnValue('FAKE_TEST_ONLY_QUERY');
  drizzle.mockReset().mockReturnValue({ select });
  vi.stubEnv('DATABASE_URL', 'FAKE_TEST_ONLY_STALE_ENV_FORBIDDEN');
});
afterEach(() => {
  clearSelfSecrets();
  delete databaseStore[databaseKey];
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('pre-import vault boot', () => {
  it('does not initialize the database on route import, or while required credentials are loading', async () => {
    let resolve!: (value: ReturnType<typeof credentials>) => void;
    load.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const { db, initializeDatabase } = await import('../../db');
    expect(postgres).not.toHaveBeenCalled();
    expect(() => initializeDatabase()).toThrow(SelfSecretsUnavailableError);
    expect(() => db.select()).toThrow(SelfSecretsUnavailableError);
    expect(() => getServerConfig()).toThrow(SelfSecretsUnavailableError);

    const boot = loadSelfSecrets();
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
    expect(postgres).not.toHaveBeenCalled();
    expect(() => getServerConfig()).toThrow(SelfSecretsUnavailableError);
    resolve(credentials());
    await boot;

    expect(postgres).toHaveBeenCalledOnce();
    expect(postgres).toHaveBeenCalledWith(credentials().values.DATABASE_URL, { max: 1 });
    expect(load.mock.invocationCallOrder[0]).toBeLessThan(postgres.mock.invocationCallOrder[0]);
    expect(Object.isFrozen(getServerConfig())).toBe(true);
    expect(process.env.DATABASE_URL).toBe('FAKE_TEST_ONLY_STALE_ENV_FORBIDDEN');
    expect(db.select()).toBe('FAKE_TEST_ONLY_QUERY');
    expect(select.mock.instances[0]).toBe(databaseStore[databaseKey]);
    expect(db.query).toBeUndefined();
    initializeDatabase();
    expect(postgres).toHaveBeenCalledOnce();

    clearSelfSecrets();
    expect(() => db.select()).toThrow(SelfSecretsUnavailableError);
  });

  it.each(['DATABASE_URL', 'SESSION_SECRET'])('fails closed when %s is absent, empty or invalid', async (key) => {
    for (const value of [undefined, '', 123]) {
      const result = credentials();
      Reflect.set(result.values, key, value);
      load.mockResolvedValue(result);
      await expect(loadSelfSecrets()).rejects.toThrow(SelfSecretsUnavailableError);
      expect(postgres).not.toHaveBeenCalled();
      expect(() => getServerConfig()).toThrow(SelfSecretsUnavailableError);
    }
  });

  it('does not initialize the database or expose provider errors when fetch fails', async () => {
    load.mockRejectedValue(new Error('FAKE_TEST_ONLY_PROVIDER_TEXT'));
    const error = await loadSelfSecrets().catch((cause: unknown) => cause) as Error;
    expect(error.message).toBe(new SelfSecretsUnavailableError().message);
    expect(error.cause).toBeUndefined();
    expect(postgres).not.toHaveBeenCalled();
    expect(() => getServerConfig()).toThrow(SelfSecretsUnavailableError);
  });

  it('revokes config on server initialization failure without retaining a cause or value', async () => {
    postgres.mockImplementation(() => { throw new Error('FAKE_TEST_ONLY_DRIVER_TEXT'); });
    await expect(loadSelfSecrets()).rejects.toThrow(new SelfSecretsUnavailableError());
    expect(() => getServerConfig()).toThrow(SelfSecretsUnavailableError);
  });

  it('refuses DB access even with config if the server has no initialized client', async () => {
    await loadSelfSecrets();
    delete databaseStore[databaseKey];
    const { db } = await import('../../db');
    expect(() => db.select()).toThrow('Database unavailable before vault boot.');
  });

  it('shares the typed boot configuration with separately bundled consumers', async () => {
    await loadSelfSecrets();
    vi.resetModules();
    const routeCopy = await import('../self-secrets');
    expect(routeCopy.getServerConfig()).toBe(getServerConfig());
    routeCopy.clearSelfSecrets();
    expect(() => getServerConfig()).toThrow(SelfSecretsUnavailableError);
  });
});
