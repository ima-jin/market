import { afterEach, describe, expect, it, vi } from 'vitest';

const { bootstrapSigningIdentityMock } = vi.hoisted(() => ({
  bootstrapSigningIdentityMock: vi.fn(),
}));

vi.mock('@/lib/signing-identity', () => ({
  bootstrapSigningIdentity: bootstrapSigningIdentityMock,
}));

describe('validateSigningKeyBootEnv', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    bootstrapSigningIdentityMock.mockReset();
  });

  it('fails loud when a raw private key is still set, pointing at the new flow', async () => {
    vi.stubEnv('IMAJIN_APP_PRIVATE_KEY', 'raw-key-that-should-not-be-here');
    vi.stubEnv('IMAJIN_APP_DID', 'did:imajin:app-under-test');
    const { validateSigningKeyBootEnv } = await import('../instrumentation');

    expect(() => validateSigningKeyBootEnv()).toThrow(/IMAJIN_APP_PRIVATE_KEY/);
    expect(() => validateSigningKeyBootEnv()).toThrow(/loadAppSigningKey/);
  });

  it('fails loud when IMAJIN_APP_DID is not set', async () => {
    vi.stubEnv('IMAJIN_APP_PRIVATE_KEY', '');
    vi.stubEnv('IMAJIN_APP_DID', '');
    const { validateSigningKeyBootEnv } = await import('../instrumentation');

    expect(() => validateSigningKeyBootEnv()).toThrow(/IMAJIN_APP_DID is not set/);
  });

  it('passes when neither guard trips', async () => {
    vi.stubEnv('IMAJIN_APP_PRIVATE_KEY', '');
    vi.stubEnv('IMAJIN_APP_DID', 'did:imajin:app-under-test');
    const { validateSigningKeyBootEnv } = await import('../instrumentation');

    expect(() => validateSigningKeyBootEnv()).not.toThrow();
  });
});

describe('register', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    bootstrapSigningIdentityMock.mockReset();
  });

  it('skips validation and bootstrap outside the nodejs runtime (e.g. edge)', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'edge');
    const { register } = await import('../instrumentation');

    await expect(register()).resolves.toBeUndefined();
    expect(bootstrapSigningIdentityMock).not.toHaveBeenCalled();
  });

  it('bootstraps the signing identity once the boot env is valid', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('IMAJIN_APP_PRIVATE_KEY', '');
    vi.stubEnv('IMAJIN_APP_DID', 'did:imajin:app-under-test');
    bootstrapSigningIdentityMock.mockResolvedValue(undefined);
    const { register } = await import('../instrumentation');

    await register();

    expect(bootstrapSigningIdentityMock).toHaveBeenCalledTimes(1);
  });
});
