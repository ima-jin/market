import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { generateBootstrapKeypair, writeKeystore } from '@ima-jin/auth-client';
import { bootstrapSigningIdentity, isAppClaimed, resetSigningIdentityForTests } from '../signing-identity';

vi.mock('@ima-jin/auth-client', async (importOriginal) => {
  const sdk = await importOriginal<typeof import('@ima-jin/auth-client')>();
  return {
    ...sdk,
    readKeystore(path: string) {
      const keystore = sdk.readKeystore(path);
      // Simulate removal after the app's preflight, before the SDK's own read.
      rmSync(path, { force: true });
      return keystore;
    },
  };
});

const dir = mkdtempSync(join(tmpdir(), 'market-boot-race-'));

afterEach(() => {
  resetSigningIdentityForTests();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

it('never falls back to IMAJIN_APP_CLAIM_CODE if the keystore disappears during boot', async () => {
  const path = join(dir, 'keystore.json');
  writeKeystore(path, generateBootstrapKeypair());
  vi.stubEnv('IMAJIN_APP_KEYSTORE', path);
  vi.stubEnv('IMAJIN_KERNEL_URL', 'https://kernel.example.test');
  vi.stubEnv('IMAJIN_APP_DID', 'did:imajin:app-under-test');
  vi.stubEnv('IMAJIN_APP_CLAIM_CODE', 'FAKE_ENV_CLAIM_CODE_IGNORED');
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);

  await expect(bootstrapSigningIdentity()).rejects.toThrow(/Required vault configuration unavailable.*\/jin/);
  expect(fetchMock).not.toHaveBeenCalled();
  expect(isAppClaimed()).toBe(false);
});
