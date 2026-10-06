import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateBootstrapKeypair, writeKeystore } from '@ima-jin/auth-client';
import { bootstrapSigningIdentity, getSigningIdentity, resetSigningIdentityForTests } from '../signing-identity';

const KERNEL_URL = 'https://dev-jin.imajin.test';

/** Builds a fetch mock that only answers the given kernel path, and records every call. */
function mockKernelFetch(path: string, responseBody: Record<string, unknown>) {
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (!url.endsWith(path)) {
      throw new Error(`unexpected fetch to ${url} — test only mocks ${path}`);
    }
    if (init?.method !== 'POST') {
      throw new Error(`expected a POST to ${path}, got ${init?.method ?? 'unknown'}`);
    }
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('bootstrapSigningIdentity / getSigningIdentity', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'imajin-keystore-'));
  });

  afterEach(async () => {
    resetSigningIdentityForTests();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await rm(workDir, { recursive: true, force: true });
  });

  it('first boot: exchanges a claim code for the signing key and persists a bootstrap keystore', async () => {
    const keystorePath = join(workDir, 'keystore.json');
    vi.stubEnv('IMAJIN_KERNEL_URL', KERNEL_URL);
    vi.stubEnv('IMAJIN_APP_KEYSTORE', keystorePath);
    vi.stubEnv('IMAJIN_APP_CLAIM_CODE', 'one-time-code');
    vi.stubEnv('IMAJIN_APP_DID', '');
    mockKernelFetch('/api/apps/claim', {
      appDid: 'did:imajin:app-under-test',
      privateKey: 'signing-private-key-hex',
      publicKey: 'signing-public-key-hex',
    });

    await bootstrapSigningIdentity();

    expect(getSigningIdentity()).toEqual({
      appDid: 'did:imajin:app-under-test',
      privateKey: 'signing-private-key-hex',
      publicKey: 'signing-public-key-hex',
    });

    const keystoreStat = await stat(keystorePath);
    expect(keystoreStat.mode & 0o777).toBe(0o600);
  });

  it('second boot: signs a challenge with the persisted bootstrap key and skips the claim code', async () => {
    const keystorePath = join(workDir, 'keystore.json');
    writeKeystore(keystorePath, generateBootstrapKeypair());

    vi.stubEnv('IMAJIN_KERNEL_URL', KERNEL_URL);
    vi.stubEnv('IMAJIN_APP_KEYSTORE', keystorePath);
    vi.stubEnv('IMAJIN_APP_CLAIM_CODE', '');
    vi.stubEnv('IMAJIN_APP_DID', 'did:imajin:app-under-test');
    const fetchMock = mockKernelFetch('/api/apps/signing-key/fetch', {
      appDid: 'did:imajin:app-under-test',
      privateKey: 'signing-private-key-hex',
      publicKey: 'signing-public-key-hex',
    });

    await bootstrapSigningIdentity();

    expect(getSigningIdentity().appDid).toBe('did:imajin:app-under-test');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, requestInit] = fetchMock.mock.calls[0];
    const requestBody = JSON.parse(requestInit?.body as string);
    expect(requestBody).toMatchObject({ appDid: 'did:imajin:app-under-test' });
    expect(typeof requestBody.signature).toBe('string');
  });

  it('no keystore and no claim code: throws a clear, actionable error instead of hanging or crashing unsigned', async () => {
    const keystorePath = join(workDir, 'never-created.json');
    vi.stubEnv('IMAJIN_KERNEL_URL', KERNEL_URL);
    vi.stubEnv('IMAJIN_APP_KEYSTORE', keystorePath);
    vi.stubEnv('IMAJIN_APP_CLAIM_CODE', '');
    vi.stubEnv('IMAJIN_APP_DID', '');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('fetch should never be called when there is no keystore and no claim code');
      })
    );

    await expect(bootstrapSigningIdentity()).rejects.toThrow(/no keystore found/i);
    await expect(bootstrapSigningIdentity()).rejects.toThrow(/IMAJIN_APP_CLAIM_CODE/);
    expect(() => getSigningIdentity()).toThrow(/not bootstrapped yet/);
  });
});
