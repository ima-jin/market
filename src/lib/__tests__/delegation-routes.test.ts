import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evaluateDelegationPolicy } from '@ima-jin/auth/delegation-policy';

const mocks = vi.hoisted(() => ({
  requireSessionOrAppToken: vi.fn(),
  fetchNodeSelf: vi.fn(),
  isHardIdentity: vi.fn(),
  getAppServiceToken: vi.fn(),
  emitEvent: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock('@/db', async () => (await import('../../../test/helpers/db-mock')).dbModule);
vi.mock('@ima-jin/auth', () => ({ requireSessionOrAppToken: mocks.requireSessionOrAppToken }));
vi.mock('@/lib/kernel/client', () => ({ fetchNodeSelf: mocks.fetchNodeSelf, isHardIdentity: mocks.isHardIdentity }));
vi.mock('@/lib/kernel/events', () => ({ emitEvent: mocks.emitEvent }));
vi.mock('@/lib/app-token', () => ({ getAppServiceToken: mocks.getAppServiceToken }));

import { dbState } from '../../../test/helpers/db-mock';
import { POST as create } from '../../../app/api/listings/route';
import { PATCH as update, DELETE as remove } from '../../../app/api/listings/[id]/route';
import { POST as purchase } from '../../../app/api/listings/[id]/purchase/route';
import { PATCH as settings } from '../../../app/api/seller/settings/route';
import { authenticate, authenticateOptional } from '@/lib/auth/authenticate';

const OWNER = 'did:imajin:owner';
const DELEGATE = 'did:imajin:delegate';
const PARAMS = { params: Promise.resolve({ id: 'lst_1' }) };
const LISTING = {
  id: 'lst_1', sellerDid: OWNER, title: 'Chair', price: 5000, currency: 'CAD',
  status: 'active', sellerTier: 'public_onplatform',
  fairManifest: { version: '1.0', distributions: [{ did: OWNER, share: 1 }] },
};
const guarded = [
  { method: 'POST', path: '/api/listings', handler: create, action: 'create', class: 'irreversible', body: { title: 'Chair', price: 5000, contactInfo: { email: 'owner@test.invalid' } }, results: [[LISTING]], status: 201, resourceId: undefined },
  { method: 'PATCH', path: '/api/listings/lst_1', handler: update, action: 'update', class: 'value-moving', body: { price: 6000 }, results: [[LISTING], [LISTING]], status: 200, resourceId: 'lst_1' },
  { method: 'DELETE', path: '/api/listings/lst_1', handler: remove, action: 'delete', class: 'irreversible', body: undefined, results: [[LISTING], []], status: 200, resourceId: 'lst_1' },
] as const;

function request(method: string, path: string, body?: unknown) {
  return new Request(`https://market.test${path}`, {
    method,
    headers: { 'X-Acting-For': OWNER, 'X-Owner-Approved': 'true' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }) as Parameters<typeof create>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  dbState.reset();
  vi.stubEnv('NEXT_PUBLIC_BASE_PATH', '');
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://market.test');
  vi.stubEnv('PAY_SERVICE_URL', 'https://pay.test');
  vi.stubGlobal('fetch', mocks.fetch);
  mocks.fetchNodeSelf.mockResolvedValue(null);
  mocks.isHardIdentity.mockResolvedValue(true);
  mocks.getAppServiceToken.mockResolvedValue('market-service-token');
  mocks.fetch.mockResolvedValue(Response.json({ url: 'https://checkout.test/s', id: 'cs_1', transactionId: 'tx_1' }));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe.each(['token', 'cookie'] as const)('%s route delegation', (via) => {
  it.each(guarded)('$method $path denies the delegate before any domain work', async (entry) => {
    mocks.requireSessionOrAppToken.mockResolvedValue({ auth: { did: DELEGATE, actingFor: OWNER, scopes: [], via } });
    const response = await entry.handler(request(entry.method, entry.path, entry.body), PARAMS);
    const decision = evaluateDelegationPolicy({ id: DELEGATE, actingFor: OWNER }, {
      action: entry.action, class: entry.class, resourceId: entry.resourceId,
    });
    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error('Expected SDK proposal');
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(decision.body);
    expect(dbState.calls).toHaveLength(0);
    expect(mocks.fetchNodeSelf).not.toHaveBeenCalled();
    expect(mocks.emitEvent).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it.each(guarded)('$method $path executes when the owner reissues from their own session', async (entry) => {
    mocks.requireSessionOrAppToken.mockResolvedValue({ auth: { did: OWNER, scopes: [], via } });
    dbState.queue(...entry.results);
    const response = await entry.handler(request(entry.method, entry.path, entry.body), PARAMS);
    expect(response.status).toBe(entry.status);
    expect(dbState.calls.length).toBeGreaterThan(0);
  });

  it.each([OWNER, DELEGATE])('allows reversible settings as caller %s, without granting owner identity', async (did) => {
    mocks.requireSessionOrAppToken.mockResolvedValue({ auth: { did, actingFor: OWNER, scopes: [], via } });
    dbState.queue([{ showMarketItems: true }]);
    const response = await settings(request('PATCH', '/api/seller/settings', { showMarketItems: true }));
    expect(response.status).toBe(200);
    expect(dbState.argsOf('values')[0][0]).toMatchObject({ did, showMarketItems: true });
  });

  it.each(['public_onplatform', 'trust_gated'])('allows only a hosted checkout proposal for %s', async (sellerTier) => {
    mocks.requireSessionOrAppToken.mockResolvedValue({ auth: { did: DELEGATE, actingFor: OWNER, scopes: [], via } });
    dbState.queue([{ ...LISTING, sellerTier }]);
    const response = await purchase(request('POST', '/api/listings/lst_1/purchase'), PARAMS);
    expect(response.status).toBe(200);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = mocks.fetch.mock.calls[0];
    expect(url).toBe('https://pay.test/api/checkout');
    expect(init.headers.Authorization).toBe('Bearer market-service-token');
    expect(JSON.parse(init.body).metadata.buyerDid).toBe(DELEGATE);
    expect(dbState.argsOf('set')).toHaveLength(0);
    expect(mocks.emitEvent).not.toHaveBeenCalled();
  });

  it('fails closed on a future mutation and optional auth never returns denied authority', async () => {
    mocks.requireSessionOrAppToken.mockResolvedValue({ auth: { did: DELEGATE, actingFor: OWNER, scopes: [], via } });
    const req = request('PUT', '/api/future');
    expect(await authenticate(req)).toMatchObject({
      status: 403, proposal: { code: 'AGENT_APPROVAL_REQUIRED', action: 'unclassified-mutation', ownerDid: OWNER, delegateDid: DELEGATE },
    });
    expect(await authenticateOptional(req)).toBeNull();
  });
});
