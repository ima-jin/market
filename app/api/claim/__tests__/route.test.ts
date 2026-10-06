import { existsSync } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetSigningIdentityForTests } from '@/lib/signing-identity';
import { resetClaimRateLimitForTests } from '@/lib/claim-rate-limit';
import { POST } from '../route';

const KERNEL_URL = 'https://dev-jin.imajin.test';
const RATE_LIMIT = 5;

function postRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost:3000/api/claim', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function mockKernelClaim(responseBody: Record<string, unknown>, status = 200) {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify(responseBody), { status, headers: { 'Content-Type': 'application/json' } })
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('POST /api/claim', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'imajin-claim-route-'));
    vi.stubEnv('IMAJIN_KERNEL_URL', KERNEL_URL);
    vi.stubEnv('IMAJIN_APP_KEYSTORE', join(workDir, 'keystore.json'));
    vi.stubEnv('IMAJIN_APP_CLAIM_CODE', '');
    vi.stubEnv('IMAJIN_APP_DID', '');
  });

  afterEach(async () => {
    resetSigningIdentityForTests();
    resetClaimRateLimitForTests();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await rm(workDir, { recursive: true, force: true });
  });

  it('redeems a valid claim code, persists a 0600 keystore, and never returns the private key', async () => {
    mockKernelClaim({
      appDid: 'did:imajin:app-under-test',
      privateKey: 'signing-private-key-hex',
      publicKey: 'signing-public-key-hex',
    });

    const response = await POST(postRequest({ claimCode: 'operator-pasted-code' }) as never);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ appDid: 'did:imajin:app-under-test', publicKey: 'signing-public-key-hex' });
    expect(body.privateKey).toBeUndefined();

    const keystoreStat = await stat(join(workDir, 'keystore.json'));
    expect(keystoreStat.mode & 0o777).toBe(0o600);
  });

  it('rejects a missing claim code without calling the kernel', async () => {
    const fetchMock = mockKernelClaim({});

    const response = await POST(postRequest({}) as never);

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps a kernel refusal to a generic 400 without leaking the kernel error body', async () => {
    mockKernelClaim({ error: 'This claim code has already been redeemed' }, 410);

    const response = await POST(postRequest({ claimCode: 'spent-code' }) as never);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(typeof body.error).toBe('string');
  });

  it('404s once this app is already claimed', async () => {
    mockKernelClaim({
      appDid: 'did:imajin:app-under-test',
      privateKey: 'signing-private-key-hex',
      publicKey: 'signing-public-key-hex',
    });
    await POST(postRequest({ claimCode: 'first-code' }) as never);

    const response = await POST(postRequest({ claimCode: 'second-code' }) as never);

    expect(response.status).toBe(404);
  });

  it('rate-limits repeated attempts from the same client', async () => {
    mockKernelClaim({ error: 'Unrecognized claim code' }, 404);

    for (let attempt = 0; attempt < RATE_LIMIT; attempt += 1) {
      await POST(postRequest({ claimCode: `attempt-${attempt}` }, { 'x-forwarded-for': '203.0.113.5' }) as never);
    }
    const response = await POST(
      postRequest({ claimCode: 'one-attempt-too-many' }, { 'x-forwarded-for': '203.0.113.5' }) as never
    );

    expect(response.status).toBe(429);
  });

  it('keys the rate limit on the trusted LAST X-Forwarded-For hop, not the spoofable leading one', async () => {
    mockKernelClaim({ error: 'Unrecognized claim code' }, 404);

    // A different, attacker-controlled leading hop on every request, but the
    // same trailing hop — the one this app's own front-door proxy actually
    // appends. If the limiter (still, wrongly) keyed on the first hop, this
    // loop would never trip the limit at all.
    for (let attempt = 0; attempt < RATE_LIMIT; attempt += 1) {
      await POST(
        postRequest({ claimCode: `attempt-${attempt}` }, { 'x-forwarded-for': `10.0.0.${attempt}, 203.0.113.5` }) as never
      );
    }
    const response = await POST(
      postRequest({ claimCode: 'one-attempt-too-many' }, { 'x-forwarded-for': '10.0.0.99, 203.0.113.5' }) as never
    );

    expect(response.status).toBe(429);
  });

  it('ignores a spoofed x-real-ip header and still rate-limits by last XFF hop', async () => {
    mockKernelClaim({ error: 'Unrecognized claim code' }, 404);

    // A fresh fabricated x-real-ip on every request, but the same trailing
    // x-forwarded-for hop. If the limiter trusted x-real-ip, every request
    // would land in its own bucket and this loop would never trip the limit.
    for (let attempt = 0; attempt < RATE_LIMIT; attempt += 1) {
      await POST(
        postRequest(
          { claimCode: `attempt-${attempt}` },
          { 'x-real-ip': `198.51.100.${attempt}`, 'x-forwarded-for': '203.0.113.5' }
        ) as never
      );
    }
    const response = await POST(
      postRequest(
        { claimCode: 'one-attempt-too-many' },
        { 'x-real-ip': '198.51.100.99', 'x-forwarded-for': '203.0.113.5' }
      ) as never
    );

    expect(response.status).toBe(429);
  });

  it('refuses a claim whose kernel-returned appDid does not match IMAJIN_APP_DID, and persists nothing', async () => {
    vi.stubEnv('IMAJIN_APP_DID', 'did:imajin:this-app');
    mockKernelClaim({
      appDid: 'did:imajin:a-different-app',
      privateKey: 'signing-private-key-hex',
      publicKey: 'signing-public-key-hex',
    });

    const response = await POST(postRequest({ claimCode: 'operator-pasted-code' }) as never);
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.expectedAppDid).toBe('did:imajin:this-app');
    expect(body.claimedAppDid).toBe('did:imajin:a-different-app');
    expect(body.error).not.toContain('operator-pasted-code');
    expect(existsSync(join(workDir, 'keystore.json'))).toBe(false);
  });
});
