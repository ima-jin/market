import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionToken, verifySessionToken } from '@ima-jin/auth-client';
import manifest from '../../../imajin.app.json';
import { authConfig } from '../auth-config';
import {
  clearSelfSecrets, getSessionSecret, loadSelfSecrets, SelfSecretsUnavailableError,
} from '../self-secrets';
import {
  bootstrapSigningIdentity, claimWithCode, getSigningIdentity, isAppClaimed,
  resetSigningIdentityForTests,
} from '../signing-identity';

const { loadFromVaultMock, signingMock, readKeystoreMock } = vi.hoisted(() => ({
  loadFromVaultMock: vi.fn(), signingMock: vi.fn(), readKeystoreMock: vi.fn(),
}));
vi.mock('@ima-jin/auth-client', async (importOriginal) => ({
  ...await importOriginal<typeof import('@ima-jin/auth-client')>(),
  loadFromVault: loadFromVaultMock,
  loadAppSigningKey: signingMock,
  readKeystore: readKeystoreMock,
}));

const FAKE_VALUE = 'FAKE_TEST_ONLY_VAULT_SESSION_MATERIAL';
const FAKE_ROTATED = 'FAKE_TEST_ONLY_ROTATED_SESSION_MATERIAL';
const user = {
  did: 'did:imajin:user-test', displayName: 'Test user',
  handle: 'test-user', attestationId: 'FAKE_TEST_ONLY_ATTESTATION',
};
const identity = {
  appDid: 'did:imajin:market-test',
  privateKey: 'FAKE_TEST_ONLY_PRIVATE_KEY',
  publicKey: 'FAKE_TEST_ONLY_PUBLIC_KEY',
};
const result = (value = FAKE_VALUE) => ({ values: { SESSION_SECRET: value }, degraded: [] });

beforeEach(() => {
  resetSigningIdentityForTests();
  vi.stubEnv('IMAJIN_APP_DID', identity.appDid);
  vi.stubEnv('IMAJIN_KERNEL_URL', 'https://kernel.example.test');
  vi.stubEnv('IMAJIN_APP_KEYSTORE', '/fake-test-only/market.keystore.json');
  vi.stubEnv('SESSION_SECRET', '');
  loadFromVaultMock.mockReset().mockResolvedValue(result());
  signingMock.mockReset().mockResolvedValue(identity);
  readKeystoreMock.mockReset().mockReturnValue({ publicKey: 'FAKE', privateKey: 'FAKE' });
});
afterEach(() => {
  resetSigningIdentityForTests();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('vault-only boot and sessions', () => {
  it('loads the manifest using this app identity/keystore and serves signed-in sessions without env secrets', async () => {
    expect(manifest.secrets).toEqual([{ name: 'SESSION_SECRET', kind: 'random-32B' }]);
    await bootstrapSigningIdentity();
    expect(loadFromVaultMock).toHaveBeenCalledTimes(1);
    expect(loadFromVaultMock).toHaveBeenCalledWith({
      appDid: identity.appDid,
      kernelUrl: 'https://kernel.example.test',
      keystorePath: '/fake-test-only/market.keystore.json',
      keys: [{ key: 'SESSION_SECRET', onMissing: 'fail' }],
      fetchOptions: { signal: expect.any(AbortSignal) },
    });
    expect(signingMock.mock.invocationCallOrder[0]).toBeLessThan(loadFromVaultMock.mock.invocationCallOrder[0]);
    expect(isAppClaimed()).toBe(true);
    expect(process.env.SESSION_SECRET).toBe('');
    const token = await createSessionToken(user, authConfig);
    expect(await verifySessionToken(token, authConfig)).toMatchObject({ did: 'did:imajin:user-test' });
  });

  it('never uses a stale env value before or after load', async () => {
    vi.stubEnv('SESSION_SECRET', 'FAKE_TEST_ONLY_STALE_ENV_MATERIAL');
    expect(() => authConfig.secret).toThrow(SelfSecretsUnavailableError);
    await loadSelfSecrets();
    expect(authConfig.secret).toBe(FAKE_VALUE);
    expect(process.env.SESSION_SECRET).toBe('FAKE_TEST_ONLY_STALE_ENV_MATERIAL');
  });

  it('does not activate identity or session signing while the boot load is unresolved', async () => {
    let resolve!: (value: ReturnType<typeof result>) => void;
    loadFromVaultMock.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const boot = bootstrapSigningIdentity();
    await vi.waitFor(() => expect(loadFromVaultMock).toHaveBeenCalledOnce());
    expect(isAppClaimed()).toBe(false);
    expect(() => getSigningIdentity()).toThrow();
    expect(() => getSessionSecret()).toThrow(SelfSecretsUnavailableError);
    resolve(result());
    await boot;
    expect(isAppClaimed()).toBe(true);
    expect(getSessionSecret()).toBe(FAKE_VALUE);
  });

  it.each(['unreachable', 'missing', 'empty', 'invalid'])('fails closed on %s, redacting errors and discarding previous memory', async (failure) => {
    await bootstrapSigningIdentity();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubEnv('SESSION_SECRET', 'FAKE_TEST_ONLY_ENV_FALLBACK_FORBIDDEN');
    if (failure === 'unreachable') {
      loadFromVaultMock.mockRejectedValue(new Error('FAKE_TEST_ONLY_PROVIDER_INPUT_MUST_NOT_LEAK'));
    } else {
      const values: Record<string, unknown> = {};
      if (failure === 'empty') values.SESSION_SECRET = '';
      if (failure === 'invalid') values.SESSION_SECRET = 123;
      loadFromVaultMock.mockResolvedValue({ values, degraded: ['SESSION_SECRET'] });
    }
    const error = await bootstrapSigningIdentity().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(SelfSecretsUnavailableError);
    expect((error as Error).message).toBe(
      'SESSION_SECRET unavailable from vault — on /jin select Sync manifest secrets, countersign, and restart market.',
    );
    expect((error as Error).cause).toBeUndefined();
    expect(log).not.toHaveBeenCalled(); // The boot boundary reports only the sanitised throw.
    expect(isAppClaimed()).toBe(false);
    expect(() => getSessionSecret()).toThrow(SelfSecretsUnavailableError);
  });

  it('unclaimed boot does not fetch secrets or enable sessions', async () => {
    readKeystoreMock.mockReturnValue(null);
    await bootstrapSigningIdentity();
    expect(loadFromVaultMock).not.toHaveBeenCalled();
    expect(isAppClaimed()).toBe(false);
    expect(() => authConfig.secret).toThrow(SelfSecretsUnavailableError);
  });

  it('shares secret memory between instrumentation and separately loaded route bundles', async () => {
    await loadSelfSecrets();
    vi.resetModules();
    const routeCopy = await import('../self-secrets');
    expect(routeCopy.getSessionSecret()).toBe(FAKE_VALUE);
    routeCopy.clearSelfSecrets();
    expect(() => getSessionSecret()).toThrow(SelfSecretsUnavailableError);
  });

  it('restart loads the rotated value with no file/env edit and invalidates old sessions', async () => {
    await bootstrapSigningIdentity();
    const oldToken = await createSessionToken(user, authConfig);
    resetSigningIdentityForTests(); // A fresh process has no memory from the previous boot.
    loadFromVaultMock.mockResolvedValue(result(FAKE_ROTATED));
    await bootstrapSigningIdentity();
    expect(getSessionSecret()).toBe(FAKE_ROTATED);
    expect(await verifySessionToken(oldToken, authConfig)).toBeNull();
    const newToken = await createSessionToken(user, authConfig);
    expect(await verifySessionToken(newToken, authConfig)).toMatchObject({ did: 'did:imajin:user-test' });
    expect(loadFromVaultMock).toHaveBeenCalledTimes(2);
    expect(process.env.SESSION_SECRET).toBe('');
  });

  it('browser claim awaits the secret before identity activation; a failed load leaves the app inactive', async () => {
    loadFromVaultMock.mockRejectedValue(new Error('FAKE_TEST_ONLY_ERROR'));
    await expect(claimWithCode({ claimCode: 'FAKE_TEST_ONLY_CODE' })).rejects.toThrow(SelfSecretsUnavailableError);
    expect(isAppClaimed()).toBe(false);
    expect(() => getSessionSecret()).toThrow(SelfSecretsUnavailableError);
    loadFromVaultMock.mockResolvedValue(result());
    await claimWithCode({ claimCode: 'FAKE_TEST_ONLY_CODE' });
    expect(isAppClaimed()).toBe(true);
    expect(getSessionSecret()).toBe(FAKE_VALUE);
  });

  it('clear removes the only stored session generation', async () => {
    await loadSelfSecrets();
    clearSelfSecrets();
    expect(() => getSessionSecret()).toThrow(SelfSecretsUnavailableError);
  });
});
