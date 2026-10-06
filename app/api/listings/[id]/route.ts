import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { createLogger } from '@ima-jin/logger';
import { db, listings } from '@/db';
import { authenticate, authenticateOptional } from '@/lib/auth/authenticate';
import { emitEvent } from '@/lib/kernel/events';
import {
  MAX_IMAGES,
  buildListingUpdates,
  recalculateFairManifest,
  validateStatusTransition,
} from '@/lib/listings';
import { resolveMediaRef } from '@/lib/media';
import { errorResponse, jsonResponse } from '@/lib/utils';

const log = createLogger('market');

type RouteProps = { params: Promise<{ id: string }> };

/**
 * GET /api/listings/:id — Single listing detail
 */
export async function GET(request: NextRequest, props: RouteProps) {
  const params = await props.params;
  try {
    const [listing] = await db.select().from(listings).where(eq(listings.id, params.id));

    if (!listing) {
      return errorResponse('Listing not found', 404);
    }

    // Trust-gated listings require a valid session
    if (listing.sellerTier === 'trust_gated') {
      const caller = await authenticateOptional(request);
      if (!caller) {
        return Response.json(
          { error: 'This listing is only available to verified members', gated: true },
          { status: 403 }
        );
      }
    }

    // Resolve asset IDs to full URLs at multiple sizes for display
    const rawImages = Array.isArray(listing.images) ? (listing.images as string[]) : [];
    const resolvedImages = rawImages.map((ref) => resolveMediaRef(ref, 'detail'));

    return jsonResponse({
      ...listing,
      price: Number(listing.price),
      images: resolvedImages,
      imageRefs: rawImages,
      // sellerDid is included via spread — client resolves seller profile from this
    });
  } catch (error) {
    log.error({ err: String(error) }, 'Failed to fetch listing');
    return errorResponse('Failed to fetch listing', 500);
  }
}

/**
 * PATCH /api/listings/:id — Update listing (seller only)
 */
export async function PATCH(request: NextRequest, props: RouteProps) {
  const params = await props.params;
  const authResult = await authenticate(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status);
  }

  const did = authResult.auth.did;

  try {
    const [listing] = await db.select().from(listings).where(eq(listings.id, params.id));

    if (!listing) {
      return errorResponse('Listing not found', 404);
    }

    if (listing.sellerDid !== did) {
      return errorResponse('Forbidden', 403);
    }

    const body = await request.json();
    const { price, sellerTier, images, status } = body;

    // Validate status transition
    if (status !== undefined) {
      const transitionError = validateStatusTransition(listing.status ?? 'active', status);
      if (transitionError) {
        return errorResponse(transitionError);
      }
    }

    if (images !== undefined && (!Array.isArray(images) || images.length > MAX_IMAGES)) {
      return errorResponse(`images must be an array with at most ${MAX_IMAGES} items`);
    }

    const updates = buildListingUpdates(body);

    // Recalculate .fair manifest if price, sellerTier, or seller DID changes
    const fairManifest = await recalculateFairManifest({
      did,
      listing,
      listingId: params.id,
      price,
      sellerTier,
    });
    if (fairManifest !== undefined) {
      updates.fairManifest = fairManifest;
    }

    const [updated] = await db.update(listings).set(updates).where(eq(listings.id, params.id)).returning();

    void emitEvent('listing.update', {
      issuer: did,
      subject: did,
      scope: 'market',
      payload: { listingId: params.id },
    });

    return jsonResponse(updated);
  } catch (error) {
    log.error({ err: String(error) }, 'Failed to update listing');
    return errorResponse('Failed to update listing', 500);
  }
}

/**
 * DELETE /api/listings/:id — Soft delete (seller only)
 */
export async function DELETE(request: NextRequest, props: RouteProps) {
  const params = await props.params;
  const authResult = await authenticate(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status);
  }

  const did = authResult.auth.did;

  try {
    const [listing] = await db.select().from(listings).where(eq(listings.id, params.id));

    if (!listing) {
      return errorResponse('Listing not found', 404);
    }

    if (listing.sellerDid !== did) {
      return errorResponse('Forbidden', 403);
    }

    await db
      .update(listings)
      .set({ status: 'removed', updatedAt: new Date() })
      .where(eq(listings.id, params.id));

    return jsonResponse({ success: true });
  } catch (error) {
    log.error({ err: String(error) }, 'Failed to delete listing');
    return errorResponse('Failed to delete listing', 500);
  }
}
