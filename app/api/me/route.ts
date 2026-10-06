import { NextRequest } from 'next/server';
import { authenticateOptional } from '@/lib/auth/authenticate';
import { jsonResponse } from '@/lib/utils';

/**
 * GET /api/me — Returns the current caller's DID, or `{ did: null }`.
 *
 * `scopeLabel` is always null: `requireSessionOrAppToken` does not carry an
 * acting-as scope (ima-jin/imajin-ai#2639), so there is no scope to label.
 */
export async function GET(request: NextRequest) {
  const caller = await authenticateOptional(request);
  if (!caller) {
    return jsonResponse({ did: null });
  }

  return jsonResponse({ did: caller.did, scopeLabel: null });
}
