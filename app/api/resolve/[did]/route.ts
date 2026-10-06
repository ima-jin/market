import { NextRequest } from 'next/server';
import { createLogger } from '@ima-jin/logger';
import { lookupProfile } from '@/lib/kernel/client';
import { errorResponse, jsonResponse } from '@/lib/utils';

const log = createLogger('market');

export const dynamic = 'force-dynamic';

/**
 * GET /api/resolve/:did — Resolve DID to profile info (handle, displayName)
 * Server-side proxy to the kernel's public profile route so clients don't
 * make cross-service calls.
 */
export async function GET(_request: NextRequest, props: { params: Promise<{ did: string }> }) {
  const params = await props.params;
  const { did } = params;

  if (!did) {
    return errorResponse('did is required');
  }

  try {
    const lookup = await lookupProfile(did);
    if (!lookup.found) {
      return errorResponse('Identity not found', 404);
    }
    const { profile } = lookup;
    return jsonResponse({
      did: profile.did,
      handle: profile.handle,
      displayName: profile.displayName,
    });
  } catch (error) {
    log.error({ err: String(error) }, 'Failed to resolve DID');
    return errorResponse('Failed to resolve identity', 500);
  }
}
