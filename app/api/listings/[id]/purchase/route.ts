/**
 * POST /api/listings/:id/purchase
 *
 * Initiates a checkout session via the pay service.
 * Market app does not touch Stripe directly — sovereign node model.
 */

import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { createLogger } from '@ima-jin/logger';
import { db, listings } from '@/db';
import { authenticate, authenticateOptional } from '@/lib/auth/authenticate';
import { appBaseUrl, payServiceUrl } from '@/lib/env';
import { isHardIdentity } from '@/lib/kernel/client';
import { emitEvent } from '@/lib/kernel/events';
import { withBasePath } from '@/lib/base-path';
import { errorResponse, jsonResponse } from '@/lib/utils';

const log = createLogger('market');

type RouteProps = { params: Promise<{ id: string }> };

/**
 * Resolve the buyer DID. trust_gated listings require an authenticated hard
 * DID; every other tier accepts an anonymous buyer. Returns an error
 * response when the buyer is not allowed to purchase.
 */
async function resolveBuyer(
  request: NextRequest,
  sellerTier: string
): Promise<{ buyerDid: string | undefined } | { response: Response }> {
  if (sellerTier === 'trust_gated') {
    const authResult = await authenticate(request);
    if ('error' in authResult || !(await isHardIdentity(request, authResult.auth))) {
      return { response: errorResponse('This listing requires a verified identity to purchase', 403) };
    }
    return { buyerDid: authResult.auth.did };
  }

  const caller = await authenticateOptional(request);
  return { buyerDid: caller ? caller.did : undefined };
}

async function parseQuantity(request: NextRequest): Promise<number> {
  try {
    const body = await request.json();
    if (body?.quantity && typeof body.quantity === 'number' && body.quantity > 0) {
      return body.quantity;
    }
  } catch {
    // body is optional — default to quantity 1
  }
  return 1;
}

export async function POST(request: NextRequest, props: RouteProps) {
  const params = await props.params;
  try {
    // 1. Fetch listing
    const [listing] = await db.select().from(listings).where(eq(listings.id, params.id)).limit(1);

    if (!listing) {
      return errorResponse('Listing not found', 404);
    }

    if (listing.status !== 'active') {
      return errorResponse('This listing is not available', 400);
    }

    if (listing.sellerTier === 'public_offplatform') {
      return errorResponse('This listing requires direct contact with the seller', 400);
    }

    // 2. Get buyer identity
    const buyer = await resolveBuyer(request, listing.sellerTier);
    if ('response' in buyer) {
      return buyer.response;
    }
    const { buyerDid } = buyer;

    // 3. Parse body for quantity
    const quantity = await parseQuantity(request);

    // 4. Build .fair manifest (use listing's manifest if present)
    const fairManifest = (listing.fairManifest as object | null) ?? {
      version: '1.0',
      type: 'market:purchase',
      distributions: [
        { did: listing.sellerDid, share: 0.99, role: 'seller' },
        { did: 'did:imajin:platform', share: 0.01, role: 'platform' },
      ],
    };

    // 5. POST to pay service
    const appUrl = appBaseUrl();
    const listingPath = withBasePath(`/listings/${listing.id}`);
    const successPath = withBasePath('/checkout/success');
    const payResponse = await fetch(`${payServiceUrl()}/api/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: [
          {
            name: listing.title,
            description: listing.description || undefined,
            amount: listing.price,
            quantity,
          },
        ],
        currency: listing.currency,
        successUrl: `${appUrl}${successPath}?session_id={CHECKOUT_SESSION_ID}&listing=${listing.id}`,
        cancelUrl: `${appUrl}${listingPath}`,
        fairManifest,
        metadata: {
          service: 'market',
          listingId: listing.id,
          listingTitle: listing.title,
          sellerDid: listing.sellerDid,
          ...(buyerDid && { buyerDid }),
        },
      }),
    });

    if (!payResponse.ok) {
      const err = await payResponse.json();
      log.error({ err }, 'Pay service error');
      return errorResponse(err.error || 'Payment service error', 500);
    }

    const checkout = await payResponse.json();

    void emitEvent('listing.purchase', {
      issuer: listing.sellerDid,
      subject: buyerDid || listing.sellerDid,
      scope: 'market',
      payload: { listingId: listing.id, sellerDid: listing.sellerDid, quantity },
    });

    return jsonResponse({ url: checkout.url, sessionId: checkout.id });
  } catch (error) {
    log.error({ err: String(error) }, 'Purchase error');
    return errorResponse('Purchase failed', 500);
  }
}
