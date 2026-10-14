import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { createClaimKernel } from './fixtures/claim-kernel.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('No test port available');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}
async function jsonResponse(response: Response) {
  expect(response.headers.get('content-type'), `${response.url} status ${response.status}`)
    .toContain('application/json');
  return response.json();
}

async function waitForHealth(url: string): Promise<Response> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {
      // The test's child process has not started listening yet.
    }
    await delay(100);
  }
  throw new Error('Test app did not boot');
}

async function stop(app: ChildProcess): Promise<void> {
  if (app.exitCode !== null || app.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => app.once('exit', () => resolve()));
  app.kill('SIGTERM');
  await exited;
}

// Run after a /market production build: CLAIM_BOOT_SMOKE=1 pnpm vitest run scripts/__tests__/claim-boot.test.ts
it.skipIf(process.env.CLAIM_BOOT_SMOKE !== '1')('production boot ignores IMAJIN_APP_CLAIM_CODE → browser claim → live → restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'market-claim-boot-'));
  const keystore = join(dir, 'keystore.json');
  const kernel = createClaimKernel();
  await new Promise<void>((resolve) => kernel.listen(0, '127.0.0.1', resolve));
  const address = kernel.address();
  if (address === null || typeof address === 'string') throw new Error('No test kernel port available');
  const port = await unusedPort();
  const base = `http://127.0.0.1:${port}/market`;
  let output = '';
  const start = (mode = 'initial') => {
    const app = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', String(port)], {
      cwd: ROOT,
      env: {
        PATH: process.env.PATH,
        NODE_ENV: 'production',
        APP_DB_SCHEMA: 'market',
        DATABASE_URL: 'postgres://localhost:5432/market_test',
        IMAJIN_APP_DID: 'did:imajin:app-under-test',
        IMAJIN_APP_CLAIM_CODE: 'FAKE_ENV_CLAIM_CODE_IGNORED',
        IMAJIN_APP_KEYSTORE: keystore,
        IMAJIN_KERNEL_URL: `http://127.0.0.1:${address.port}`,
        IMAJIN_AUTH_URL: `http://127.0.0.1:${address.port}`,
        NEXT_PUBLIC_APP_URL: base,
        NEXT_PUBLIC_BASE_PATH: '/market',
        // Stub only loadFromVault in this test process; all claim/session code is real.
        NODE_OPTIONS: `--require=${join(ROOT, 'scripts/__tests__/fixtures/vault-loader.cjs')}`,
        FAKE_VAULT_TEST_MODE: mode,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    app.stdout?.on('data', (chunk) => { output += chunk.toString(); });
    app.stderr?.on('data', (chunk) => { output += chunk.toString(); });
    return app;
  };
  let app = start();
  try {
    expect(await jsonResponse(await waitForHealth(`${base}/api/health`))).toMatchObject({ claimed: false });
    expect(await (await fetch(base)).text()).toContain('href="/market/claim"');
    expect(await (await fetch(`${base}/claim`)).text()).toContain('Claim this app');
    const response = await fetch(`${base}/api/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ claimCode: 'FAKE_BROWSER_CLAIM_CODE' }),
    });
    expect(response.status).toBe(200);
    expect(await jsonResponse(response)).toEqual({
      appDid: 'did:imajin:app-under-test',
      publicKey: 'FAKE_TEST_SIGNING_PUBLIC_KEY',
    });
    expect((await stat(keystore)).mode & 0o777).toBe(0o600);
    expect(await jsonResponse(await fetch(`${base}/api/health`))).toMatchObject({ claimed: true });
    expect(await (await fetch(base)).text()).not.toContain('Not claimed yet');
    expect((await fetch(`${base}/claim`)).status).toBe(404);
    expect((await fetch(`${base}/api/claim`, { method: 'POST' })).status).toBe(404);
    const login = await fetch(`${base}/api/auth/callback?attestation_id=FAKE_TEST_ONLY_ATTESTATION&user_did=did:imajin:user-test`, {
      redirect: 'manual',
    });
    expect(login.status).toBe(307);
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const session = () => fetch(`${base}/api/auth/session`, { headers: { cookie }, redirect: 'manual' });
    expect(await jsonResponse(await session())).toMatchObject({ did: 'did:imajin:user-test' });
    await stop(app);
    app = start('rotated');
    expect(await jsonResponse(await waitForHealth(`${base}/api/health`))).toMatchObject({ claimed: true });
    expect(await jsonResponse(await session())).toBeNull();
    // Claimed boot fails before serving with one safe log, regardless of provider text.
    for (const failure of ['unreachable', 'missing']) {
      await stop(app);
      output = '';
      app = start(failure);
      const code = await new Promise<number | null>((resolve) => app.once('exit', resolve));
      expect(code).toBe(1);
      expect(output.match(/SESSION_SECRET unavailable from vault/g)).toHaveLength(1);
      expect(output).toContain('/jin select Sync manifest secrets');
      expect(output).not.toContain('FAKE_TEST_ONLY_PROVIDER_ERROR_MUST_NOT_LEAK');
      await expect(fetch(`${base}/api/health`)).rejects.toThrow();
    }
    expect(output).not.toContain('FAKE_BROWSER_CLAIM_CODE');
    expect(output).not.toContain('FAKE_ENV_CLAIM_CODE_IGNORED');
    expect(output).not.toContain('FAKE_TEST_SIGNING_PRIVATE_KEY');
    expect(output).not.toContain('FAKE_TEST_ONLY_VAULT_SESSION_MATERIAL');
    expect(output).not.toContain('FAKE_TEST_ONLY_ROTATED_SESSION_MATERIAL');
  } finally {
    await stop(app);
    await new Promise<void>((resolve, reject) => kernel.close((error) => error ? reject(error) : resolve()));
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);
