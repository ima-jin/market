import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '@ima-jin/logger';
import manifest from '../../../../imajin.app.json';

const mocks = vi.hoisted(() => ({
  getSigningIdentity: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock('@/lib/signing-identity', () => ({ getSigningIdentity: mocks.getSigningIdentity }));

import { resetAppServiceTokenCache } from '@/lib/app-token';
import { emitEvent, type MarketEvent, type MarketEventType } from '../events';

const KERNEL_URL = 'https://kernel.test';
const TYPES: MarketEventType[] = ['listing.created', 'listing.updated', 'listing.purchased'];
const EVENT: MarketEvent = {
  issuer: 'did:imajin:buyer',
  subject: 'did:imajin:seller',
  scope: 'market',
  payload: { listingId: 'lst_1', interestDids: ['did:imajin:buyer'] },
  correlationId: 'purchase-1',
};
const log = createLogger('market');

beforeEach(() => {
  vi.clearAllMocks();
  resetAppServiceTokenCache();
  vi.stubEnv('IMAJIN_KERNEL_URL', `${KERNEL_URL}/`);
  vi.stubEnv('IMAJIN_APP_DID', 'did:imajin:market-app');
  vi.stubGlobal('fetch', mocks.fetch);
  mocks.getSigningIdentity.mockReset().mockReturnValue({
    appDid: 'did:imajin:market-app',
    privateKey: '11'.repeat(32),
  });
  mocks.fetch.mockReset().mockImplementation(async (url: string) => {
    if (url.endsWith('/auth/api/apps/token/service')) {
      return Response.json({ token: 'test-service-token', expiresIn: 600, scopes: [] });
    }
    return Response.json({ ok: true, ran: ['notify', 'audit-log'] }, { status: 201 });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('market domain events', () => {
  it('declares exactly the published types for the kernel declarations preview', () => {
    expect(manifest.emittableEvents).toEqual(TYPES);
  });

  it.each(TYPES)('mints an app-service token and posts %s with the kernel wire contract', async (type) => {
    await expect(emitEvent(type, EVENT)).resolves.toBeUndefined();

    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    const [mintUrl, mint] = mocks.fetch.mock.calls[0] as [string, RequestInit];
    expect(mintUrl).toBe(`${KERNEL_URL}/auth/api/apps/token/service`);
    expect(mint.method).toBe('POST');
    expect(JSON.parse(mint.body as string)).toEqual({
      appDid: 'did:imajin:market-app',
      nonce: expect.stringMatching(/^[0-9a-f]{32}$/),
      timestamp: expect.any(String),
      signature: expect.stringMatching(/^[0-9a-f]{128}$/),
    });
    const [url, init] = mocks.fetch.mock.calls[1] as [string, RequestInit];
    expect(url).toBe(`${KERNEL_URL}/api/events`);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-service-token',
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(init.body as string)).toEqual({
      type, subject: EVENT.subject, payload: EVENT.payload, correlationId: EVENT.correlationId,
    });
    expect(log.error).not.toHaveBeenCalled();
  });

  it.each([
    [401, 'Unauthorized'],
    [403, 'event_type_not_approved'],
    [429, 'rate_limited'],
    [503, 'unavailable'],
  ])('logs HTTP %s without failing the caller or retrying', async (status, error) => {
    mocks.fetch.mockResolvedValueOnce(Response.json({ token: 'test-service-token', expiresIn: 600 }));
    mocks.fetch.mockResolvedValueOnce(Response.json({ error }, {
      status, headers: { 'Retry-After': '60' },
    }));

    await expect(emitEvent('listing.created', EVENT)).resolves.toBeUndefined();

    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(log.error).toHaveBeenCalledWith(
      { type: 'listing.created', status, retryAfter: '60' },
      expect.stringContaining('operator-approved emittableEvents'),
    );
  });

  it('invalidates a refused token so the next event mints again (no replay)', async () => {
    mocks.fetch.mockResolvedValueOnce(Response.json({ token: 'expired-token', expiresIn: 600 }));
    mocks.fetch.mockResolvedValueOnce(new Response(null, { status: 401 }));
    await emitEvent('listing.created', EVENT);
    await emitEvent('listing.updated', EVENT);
    expect(mocks.fetch.mock.calls.map(([url]) => url)).toEqual([
      `${KERNEL_URL}/auth/api/apps/token/service`, `${KERNEL_URL}/api/events`,
      `${KERNEL_URL}/auth/api/apps/token/service`, `${KERNEL_URL}/api/events`,
    ]);
  });

  it('reuses the service token and omits optional correlationId', async () => {
    const event = { ...EVENT, correlationId: undefined };
    await emitEvent('listing.created', event);
    await emitEvent('listing.updated', event);
    expect(mocks.fetch).toHaveBeenCalledTimes(3);
    const body = JSON.parse(mocks.fetch.mock.calls[2][1].body);
    expect(body).not.toHaveProperty('correlationId');
    expect(log.error).not.toHaveBeenCalled();
  });

  it.each(['IMAJIN_KERNEL_URL', 'IMAJIN_APP_DID'])('logs a missing %s at error level, naming the setting', async (setting) => {
    vi.stubEnv(setting, '');
    await expect(emitEvent('listing.created', EVENT)).resolves.toBeUndefined();
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(
      { type: 'listing.created', setting }, expect.stringContaining(setting),
    );
  });

  it('reports an unclaimed identity without leaking the cause', async () => {
    mocks.getSigningIdentity.mockImplementation(() => { throw new Error('sensitive identity'); });
    await expect(emitEvent('listing.created', EVENT)).resolves.toBeUndefined();
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(
      { type: 'listing.created', stage: 'app-service token mint' },
      expect.stringContaining('IMAJIN_APP_KEYSTORE'),
    );
    expect(JSON.stringify(vi.mocked(log.error).mock.calls)).not.toContain('sensitive');
  });

  it.each([401, 403, 429])('handles a token mint HTTP %s failure non-fatally', async (status) => {
    mocks.fetch.mockResolvedValueOnce(Response.json({ error: 'refused' }, { status }));
    await expect(emitEvent('listing.created', EVENT)).resolves.toBeUndefined();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith(
      { type: 'listing.created', stage: 'app-service token mint' }, expect.any(String),
    );
  });

  it('handles network failure or timeout without leaking credentials or payloads', async () => {
    mocks.fetch.mockResolvedValueOnce(Response.json({ token: 'test-service-token', expiresIn: 600 }));
    mocks.fetch.mockRejectedValueOnce(new Error('sensitive transport diagnostic'));
    await expect(emitEvent('listing.created', EVENT)).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledWith(
      { type: 'listing.created', stage: 'POST /api/events' }, expect.any(String),
    );
    const logs = JSON.stringify(vi.mocked(log.error).mock.calls);
    for (const value of ['test-service-token', 'sensitive', EVENT.subject, 'lst_1']) {
      expect(logs).not.toContain(value);
    }
  });
});
