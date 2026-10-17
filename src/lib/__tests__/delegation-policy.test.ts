import { afterEach, describe, expect, it, vi } from 'vitest';
import { evaluateDelegationPolicy } from '@ima-jin/auth/delegation-policy';
import { DELEGATION_ROUTES, evaluateMarketDelegationPolicy } from '../delegation-policy';

const DELEGATE = { id: 'did:imajin:delegate', actingFor: 'did:imajin:owner' };
const OWNER = { id: DELEGATE.actingFor };

afterEach(() => vi.unstubAllEnvs());

describe('market SDK delegation policy', () => {
  it.each(Object.values(DELEGATION_ROUTES))('$method $path preserves the exact SDK decision', (entry) => {
    const path = entry.path.replaceAll('[id]', 'lst_1');
    const resourceId = entry.path.includes('[id]') ? 'lst_1' : undefined;
    const request = new Request(`https://market.test${path}`, { method: entry.method });
    expect(evaluateMarketDelegationPolicy(request, DELEGATE)).toEqual(evaluateDelegationPolicy(DELEGATE, {
      action: entry.action, class: entry.class, resourceId,
    }));
    for (const source of [OWNER, { id: OWNER.id, actingFor: OWNER.id }, { id: 'did:imajin:member', actingAs: 'did:imajin:group' }]) {
      expect(evaluateMarketDelegationPolicy(request, source)).toEqual({ allowed: true });
    }
  });

  it.each(['GET', 'HEAD', 'OPTIONS'])('allows safe %s methods', (method) => {
    expect(evaluateMarketDelegationPolicy(new Request('https://market.test/api/future', { method }), DELEGATE)).toEqual({ allowed: true });
  });

  it.each([
    ['POST', '/api/future'],
    ['PUT', '/api/listings/lst_1'],
    ['DELETE', '/api/listings/'],
    ['POST', '/api/claim'],
    ['POST', '/api/listings/lst_1/purchase/extra'],
    ['POST', '/api/other/lst_1/purchase'],
  ])('fails closed for %s %s at the auth boundary', (method, path) => {
    expect(evaluateMarketDelegationPolicy(new Request(`https://market.test${path}`, { method }), DELEGATE)).toEqual(
      evaluateDelegationPolicy(DELEGATE, { action: 'unclassified-mutation', class: 'irreversible' }),
    );
  });

  it('matches only the configured base path boundary', () => {
    vi.stubEnv('NEXT_PUBLIC_BASE_PATH', '/market');
    const request = (path: string) => new Request(`https://market.test${path}`, { method: 'DELETE' });
    expect(evaluateMarketDelegationPolicy(request('/market/api/listings/lst_1'), DELEGATE)).toEqual(
      evaluateDelegationPolicy(DELEGATE, { action: 'delete', class: 'irreversible', resourceId: 'lst_1' }),
    );
    expect(evaluateMarketDelegationPolicy(request('/marketplace/api/listings/lst_1'), DELEGATE)).toEqual(
      evaluateDelegationPolicy(DELEGATE, { action: 'unclassified-mutation', class: 'irreversible' }),
    );
  });
});
