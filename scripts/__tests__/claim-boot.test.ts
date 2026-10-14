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
  const start = () => {
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
        NEXT_PUBLIC_BASE_PATH: '/market',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    app.stdout?.on('data', (chunk) => { output += chunk.toString(); });
    app.stderr?.on('data', (chunk) => { output += chunk.toString(); });
    return app;
  };
  let app = start();
  try {
    expect(await (await waitForHealth(`${base}/api/health`)).json()).toMatchObject({ claimed: false });
    expect(await (await fetch(base)).text()).toContain('href="/market/claim"');
    expect(await (await fetch(`${base}/claim`)).text()).toContain('Claim this app');
    const response = await fetch(`${base}/api/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ claimCode: 'FAKE_BROWSER_CLAIM_CODE' }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      appDid: 'did:imajin:app-under-test',
      publicKey: 'FAKE_TEST_SIGNING_PUBLIC_KEY',
    });
    expect((await stat(keystore)).mode & 0o777).toBe(0o600);
    expect(await (await fetch(`${base}/api/health`)).json()).toMatchObject({ claimed: true });
    expect(await (await fetch(base)).text()).not.toContain('Not claimed yet');
    expect((await fetch(`${base}/claim`)).status).toBe(404);
    expect((await fetch(`${base}/api/claim`, { method: 'POST' })).status).toBe(404);
    await stop(app);
    app = start();
    expect(await (await waitForHealth(`${base}/api/health`)).json()).toMatchObject({ claimed: true });
    expect(output).not.toContain('FAKE_BROWSER_CLAIM_CODE');
    expect(output).not.toContain('FAKE_ENV_CLAIM_CODE_IGNORED');
    expect(output).not.toContain('FAKE_TEST_SIGNING_PRIVATE_KEY');
  } finally {
    await stop(app);
    await new Promise<void>((resolve, reject) => kernel.close((error) => error ? reject(error) : resolve()));
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);
