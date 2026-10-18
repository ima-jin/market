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
import { getAppServiceToken } from '@/lib/app-token';
import { authenticate, authenticateOptional } from '@/lib/auth/authenticate';
import { appBaseUrl, payServiceUrl } from '@/lib/env';
import { cardRailFailure } from '@/lib/card-rail';
import { isHardIdentity } from '@/lib/kernel/client';
import { withBasePath } from '@/lib/base-path';
import { recordPendingCheckout, type CheckoutOwnership, type PayeeChainEntry } from '@/lib/pending-checkout';
import { buildPayeeChain, type FairManifest } from '@/lib/settle';
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

async function parseQuantity(request: NextRequest): Promise<unknown> {
  try {
    const body = await request.json();
    return body?.quantity ?? 1;
  } catch {
    // body is optional — default to quantity 1
  }
  return 1;
}

/**
 * Remember which kernel payment (`transactionId`) this Stripe session is, so the purchase
 * webhook can fulfill it. Never expose a payment URL without its local ownership record.
 */
async function rememberCheckout(
  listingId: string,
  checkout: { id?: string; transactionId?: string },
  amountCents: number,
  chain: PayeeChainEntry[],
  ownership: CheckoutOwnership,
): Promise<void> {
  if (typeof checkout.id !== 'string' || !checkout.id || typeof checkout.transactionId !== 'string' || !checkout.transactionId) {
    throw new Error('Pay checkout response had no session id / transactionId');
  }
  await recordPendingCheckout(listingId, checkout.id, { transactionId: checkout.transactionId, amountCents, chain, ...ownership });
}

/**
 * Every seller checkout uses market's own app-service token, including listings without
 * a payee chain (#31). Returns `null` when minting fails: never fall back to an
 * unauthenticated checkout.
 */
async function checkoutHeaders(): Promise<Record<string, string> | null> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  try {
    headers.Authorization = `Bearer ${await getAppServiceToken()}`;
    return headers;
  } catch (err) {
    log.error({ err: String(err) }, 'Market app-service token unavailable');
    return null;
  }
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
    if (typeof quantity !== 'number' || !Number.isSafeInteger(quantity) || quantity <= 0) {
      return errorResponse('Quantity must be a positive integer', 400);
    }
    if (listing.quantity !== null && listing.quantity < quantity) {
      return errorResponse('Insufficient listing quantity', 400);
    }

    // 4. Build .fair manifest (use listing's manifest if present)
    const fairManifest = (listing.fairManifest as object | null) ?? {
      version: '1.0',
      type: 'market:purchase',
      distributions: [
        { did: listing.sellerDid, share: 0.99, role: 'seller' },
        { did: 'did:imajin:platform', share: 0.01, role: 'platform' },
      ],
    };

    // 5. Declare the payees (#2740). The chain is fixed here and re-posted verbatim at settle time.
    const amountCents = listing.price * quantity;
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0 || amountCents > 2147483647 || !listing.currency) {
      return errorResponse('Invalid listing price or currency', 400);
    }
    const payeeChain = buildPayeeChain({ amountCents, fairManifest: fairManifest as FairManifest, buyerDid });
    const headers = await checkoutHeaders();
    if (!headers) {
      return errorResponse('Payment service unavailable. Please try again later.', 503);
    }

    // 6. POST to pay service
    const appUrl = appBaseUrl();
    const listingPath = withBasePath(`/listings/${listing.id}`);
    const successPath = withBasePath('/checkout/success');
    const payResponse = await fetch(`${payServiceUrl()}/api/checkout`, {
      method: 'POST',
      headers,
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
        ...(payeeChain && { payeeManifest: { chain: payeeChain } }),
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
      const err = await payResponse.json().catch(() => ({}));
      // #2773: a seller with no card rail (or a Stripe account that would not take the charge) is not a
      // server fault — say so plainly and pass the code through so the page can hide the card button.
      const railFailure = cardRailFailure(err.code);
      if (railFailure) {
        log.warn({ code: railFailure.code, listingId: listing.id }, 'Seller has no working card rail');
        return Response.json({ error: railFailure.message, code: railFailure.code }, { status: railFailure.status });
      }
      log.error({ err }, 'Pay service error');
      return errorResponse(err.error || 'Payment service error', 500);
    }

    const checkout = await payResponse.json();

    await rememberCheckout(listing.id, checkout, amountCents, payeeChain ?? [], {
      sellerDid: listing.sellerDid,
      buyerDid: buyerDid ?? '',
      quantity,
      unitPrice: listing.price,
      currency: listing.currency,
    });

    return jsonResponse({ url: checkout.url, sessionId: checkout.id });
  } catch (error) {
    log.error({ err: String(error) }, 'Purchase error');
    return errorResponse('Purchase failed', 500);
  }
}
