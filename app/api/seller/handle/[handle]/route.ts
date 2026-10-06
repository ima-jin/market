import { NextRequest } from 'next/server';
import { and, desc, eq } from 'drizzle-orm';
import { createLogger } from '@ima-jin/logger';
import { db, listings } from '@/db';
import { lookupProfile } from '@/lib/kernel/client';
import { errorResponse, jsonResponse } from '@/lib/utils';

const log = createLogger('market');

/**
 * GET /api/seller/handle/:handle — Resolve handle → DID → listings
 * Server-side profile lookup (kernel public profile route) so the client
 * doesn't need cross-service calls.
 */
export async function GET(_request: NextRequest, props: { params: Promise<{ handle: string }> }) {
  const params = await props.params;
  const { handle } = params;

  if (!handle) {
    return errorResponse('handle is required');
  }

  try {
    const lookup = await lookupProfile(handle);
    if (!lookup.found || !lookup.profile.did) {
      return errorResponse('Seller not found', 404);
    }
    const { profile } = lookup;
    const did = profile.did as string;

    // Fetch active listings (no settings gate — this is the market's own seller page,
    // not the cross-service profile widget)
    const rows = await db
      .select({
        id: listings.id,
        title: listings.title,
        price: listings.price,
        currency: listings.currency,
        images: listings.images,
        category: listings.category,
        sellerTier: listings.sellerTier,
        createdAt: listings.createdAt,
      })
      .from(listings)
      .where(and(eq(listings.sellerDid, did), eq(listings.status, 'active')))
      .orderBy(desc(listings.createdAt))
      .limit(100);

    return jsonResponse({
      seller: { handle: profile.handle, displayName: profile.displayName, did },
      listings: rows,
      enabled: true,
    });
  } catch (error) {
    log.error({ err: String(error) }, 'Failed to fetch seller by handle');
    return errorResponse('Failed to fetch seller listings', 500);
  }
}
