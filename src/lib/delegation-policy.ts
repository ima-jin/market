import { evaluateDelegationPolicy, type DelegationDecision, type DelegationSource, type MutationClass } from '@ima-jin/auth/delegation-policy';

interface RoutePolicy {
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  action: string;
  class: MutationClass;
  why: string;
}

/** App-owned inventory; policy decisions and proposal payloads remain SDK-owned. */
export const DELEGATION_ROUTES = {
  'market.listing.create': { method: 'POST', path: '/api/listings', action: 'create', class: 'irreversible', why: 'Publishes an offer and contact information; disclosure cannot be undone.' },
  'market.listing.update': { method: 'PATCH', path: '/api/listings/[id]', action: 'update', class: 'value-moving', why: 'Can change price, currency, seller tier and settlement manifest; conservatively gate the whole update.' },
  'market.listing.delete': { method: 'DELETE', path: '/api/listings/[id]', action: 'delete', class: 'irreversible', why: 'Removes a listing with no supported restore transition.' },
  'market.listing.purchase': { method: 'POST', path: '/api/listings/[id]/purchase', action: 'checkout', class: 'reversible', why: 'Creates a hosted checkout proposal; the payer must still authorize payment in Stripe.' },
  'market.seller.settings': { method: 'PATCH', path: '/api/seller/settings', action: 'settings', class: 'reversible', why: 'Toggles visibility of already-public market items; the setting can be undone.' },
} as const satisfies Record<string, RoutePolicy>;

/** Independent authority protocols, not delegated owner execution. */
export const DELEGATION_EXCEPTIONS = [
  { method: 'POST', path: '/api/webhook', why: 'Kernel-signed callback with audience and replay verification, not user session authority.' },
  { method: 'POST', path: '/api/claim', why: 'One-time app bootstrap claim-code protocol, not owner session authority.' },
  { method: 'POST', path: '/api/auth/logout', why: 'SDK session logout, not a delegated resource mutation.' },
] as const;

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function matchPath(template: string, path: string): Record<string, string> | null {
  const expected = template.split('/');
  const actual = path.split('/');
  if (expected.length !== actual.length) return null;
  const params: Record<string, string> = {};
  for (const [index, segment] of expected.entries()) {
    if (segment.startsWith('[')) {
      if (!actual[index]) return null;
      params[segment.slice(1, -1)] = actual[index];
    } else if (segment !== actual[index]) {
      return null;
    }
  }
  return params;
}

/** Run at authenticate(), never from a list of opt-in route wrappers. */
export function evaluateMarketDelegationPolicy(request: Request, source: DelegationSource): DelegationDecision {
  if (SAFE_METHODS.has(request.method)) return { allowed: true };
  const pathname = new URL(request.url).pathname;
  const base = process.env.NEXT_PUBLIC_BASE_PATH ?? '';
  const path = base && pathname.startsWith(`${base}/`) ? pathname.slice(base.length) : pathname;
  for (const entry of Object.values(DELEGATION_ROUTES)) {
    if (entry.method !== request.method) continue;
    const params = matchPath(entry.path, path);
    if (!params) continue;
    return evaluateDelegationPolicy(source, { action: entry.action, class: entry.class, resourceId: params.id });
  }
  // Exceptions use their own protocols; they are not an auth-boundary bypass.
  return evaluateDelegationPolicy(source, { action: 'unclassified-mutation', class: 'irreversible' });
}
