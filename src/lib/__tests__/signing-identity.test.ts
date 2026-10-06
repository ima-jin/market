import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateBootstrapKeypair, writeKeystore } from '@ima-jin/auth-client';
import {
  AppDidMismatchError,
  bootstrapSigningIdentity,
  claimWithCode,
  getSigningIdentity,
  isAppClaimed,
  resetSigningIdentityForTests,
} from '../signing-identity';

const KERNEL_URL = 'https://dev-jin.imajin.test';
const SIGNING_IDENTITY_KEY = Symbol.for('imajin.app.signingIdentity');

interface GlobalIdentitySlot {
  [SIGNING_IDENTITY_KEY]?: unknown;
}

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

/**
 * Registers the shared temp-keystore-dir setup/teardown for a `describe`
 * block (call at the top of the `describe` callback, same as writing the
 * hooks inline) and returns an accessor for the current test's temp dir.
 * Shared by both describe blocks below to avoid duplicating this verbatim.
 */
function useTempKeystoreDir(tmpPrefix: string): { dir: () => string } {
  let workDir = '';

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), tmpPrefix));
  });

  afterEach(async () => {
    resetSigningIdentityForTests();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await rm(workDir, { recursive: true, force: true });
  });

  return { dir: () => workDir };
}

describe('bootstrapSigningIdentity / getSigningIdentity', () => {
  const tmp = useTempKeystoreDir('imajin-keystore-');

  it('first boot: exchanges a claim code for the signing key and persists a bootstrap keystore', async () => {
    const keystorePath = join(tmp.dir(), 'keystore.json');
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
    expect(isAppClaimed()).toBe(true);

    const keystoreStat = await stat(keystorePath);
    expect(keystoreStat.mode & 0o777).toBe(0o600);
  });

  it('second boot: signs a challenge with the persisted bootstrap key and skips the claim code', async () => {
    const keystorePath = join(tmp.dir(), 'keystore.json');
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
    expect(isAppClaimed()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, requestInit] = fetchMock.mock.calls[0];
    const requestBody = JSON.parse(requestInit?.body as string);
    expect(requestBody).toMatchObject({ appDid: 'did:imajin:app-under-test' });
    expect(typeof requestBody.signature).toBe('string');
  });

  it('shares the identity across separately-loaded module copies (instrumentation.ts vs route bundles)', async () => {
    const keystorePath = join(tmp.dir(), 'keystore.json');
    writeKeystore(keystorePath, generateBootstrapKeypair());
    vi.stubEnv('IMAJIN_KERNEL_URL', KERNEL_URL);
    vi.stubEnv('IMAJIN_APP_KEYSTORE', keystorePath);
    vi.stubEnv('IMAJIN_APP_CLAIM_CODE', '');
    vi.stubEnv('IMAJIN_APP_DID', 'did:imajin:app-under-test');
    mockKernelFetch('/api/apps/signing-key/fetch', {
      appDid: 'did:imajin:app-under-test',
      privateKey: 'signing-private-key-hex',
      publicKey: 'signing-public-key-hex',
    });

    // Copy A stands in for the bundle `instrumentation.ts` boots from...
    vi.resetModules();
    const instrumentationCopy = await import('../signing-identity');
    await instrumentationCopy.bootstrapSigningIdentity();

    // ...copy B for a distinct route bundle: a fresh module instance with its own module scope.
    vi.resetModules();
    const routeCopy = await import('../signing-identity');
    expect(routeCopy).not.toBe(instrumentationCopy);

    expect(routeCopy.isAppClaimed()).toBe(true);
    expect(routeCopy.getSigningIdentity().appDid).toBe('did:imajin:app-under-test');
  });

  it('reads the identity from the Symbol.for(imajin.app.signingIdentity) slot on globalThis', () => {
    const fixtureIdentity = {
      appDid: 'did:imajin:app-under-test',
      privateKey: 'fixture-private',
      publicKey: 'fixture-public',
    };
    expect(isAppClaimed()).toBe(false);

    (globalThis as GlobalIdentitySlot)[SIGNING_IDENTITY_KEY] = fixtureIdentity;

    expect(isAppClaimed()).toBe(true);
    expect(getSigningIdentity()).toBe(fixtureIdentity);

    resetSigningIdentityForTests();
    expect(isAppClaimed()).toBe(false);
    expect((globalThis as GlobalIdentitySlot)[SIGNING_IDENTITY_KEY]).toBeNull();
  });

  it('unclaimed boot mode (#2427): no keystore and no claim code boots without throwing', async () => {
    const keystorePath = join(tmp.dir(), 'never-created.json');
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

    await expect(bootstrapSigningIdentity()).resolves.toBeUndefined();

    expect(isAppClaimed()).toBe(false);
    expect(() => getSigningIdentity()).toThrow(/not bootstrapped yet/);
  });

  it('still fails loud when a claim code IS provided but the kernel rejects it', async () => {
    const keystorePath = join(tmp.dir(), 'never-created.json');
    vi.stubEnv('IMAJIN_KERNEL_URL', KERNEL_URL);
    vi.stubEnv('IMAJIN_APP_KEYSTORE', keystorePath);
    vi.stubEnv('IMAJIN_APP_CLAIM_CODE', 'bad-code');
    vi.stubEnv('IMAJIN_APP_DID', '');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'Unrecognized claim code' }), { status: 404 }))
    );

    await expect(bootstrapSigningIdentity()).rejects.toThrow();
    expect(isAppClaimed()).toBe(false);
  });
});

describe('claimWithCode', () => {
  const tmp = useTempKeystoreDir('imajin-claim-page-');

  it('hot-swaps the in-memory signing identity and persists a bootstrap keystore, without needing IMAJIN_APP_CLAIM_CODE', async () => {
    const keystorePath = join(tmp.dir(), 'keystore.json');
    vi.stubEnv('IMAJIN_KERNEL_URL', KERNEL_URL);
    vi.stubEnv('IMAJIN_APP_KEYSTORE', keystorePath);
    vi.stubEnv('IMAJIN_APP_CLAIM_CODE', '');
    mockKernelFetch('/api/apps/claim', {
      appDid: 'did:imajin:app-under-test',
      privateKey: 'signing-private-key-hex',
      publicKey: 'signing-public-key-hex',
    });

    expect(isAppClaimed()).toBe(false);

    const identity = await claimWithCode({ claimCode: 'operator-pasted-code' });

    expect(identity.appDid).toBe('did:imajin:app-under-test');
    expect(isAppClaimed()).toBe(true);
    expect(getSigningIdentity()).toEqual(identity);

    const keystoreStat = await stat(keystorePath);
    expect(keystoreStat.mode & 0o777).toBe(0o600);
  });

  it('refuses a claim whose kernel-returned appDid does not match IMAJIN_APP_DID, and undoes the keystore write', async () => {
    const keystorePath = join(tmp.dir(), 'keystore.json');
    vi.stubEnv('IMAJIN_KERNEL_URL', KERNEL_URL);
    vi.stubEnv('IMAJIN_APP_KEYSTORE', keystorePath);
    vi.stubEnv('IMAJIN_APP_DID', 'did:imajin:this-app');
    mockKernelFetch('/api/apps/claim', {
      appDid: 'did:imajin:a-different-app',
      privateKey: 'signing-private-key-hex',
      publicKey: 'signing-public-key-hex',
    });

    await expect(claimWithCode({ claimCode: 'operator-pasted-code' })).rejects.toThrow(AppDidMismatchError);

    expect(isAppClaimed()).toBe(false);
    await expect(stat(keystorePath)).rejects.toThrow();
  });
});
