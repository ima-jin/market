/**
 * POST /api/webhook
 *
 * Called by the pay service after a successful payment.
 * Updates listing status/quantity accordingly.
 */

import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { KernelWebhookError, verifyKernelWebhook } from '@ima-jin/auth/kernel-webhook';
import { createLogger } from '@ima-jin/logger';
import { db, listings } from '@/db';
import { STRIPE_BYO_RAIL } from '@/lib/card-rail';
import { emitEvent } from '@/lib/kernel/events';
import { readPendingCheckout } from '@/lib/pending-checkout';
import { recordByoSettlement, settleListingPurchase, type FairManifest } from '@/lib/settle';
import { errorResponse, jsonResponse } from '@/lib/utils';

const log = createLogger('market');

interface WebhookBody {
  type?: string;
  status?: string;
  /** Stripe Checkout session id of the payment (#2740) — keys the checkout recorded at purchase time. */
  sessionId?: string;
  /**
   * Set to `stripe-byo` when the payment was collected on the seller's own Stripe account and the
   * kernel has already settled it (#2773). Absent for a platform-collected payment.
   */
  rail?: string;
  metadata?: {
    listingId?: string;
    buyerDid?: string;
    amount?: number;
    currency?: string;
    sessionId?: string;
  };
}

function isPaymentSuccess(body: WebhookBody): boolean {
  return body.type === 'payment.succeeded' || body.status === 'paid' || body.status === 'succeeded';
}

async function applyListingPurchase(listingId: string, listing: typeof listings.$inferSelect): Promise<void> {
  if (listing.quantity === null || listing.quantity <= 1) {
    // Single item or unlimited — mark sold
    await db.update(listings).set({ status: 'sold', updatedAt: new Date() }).where(eq(listings.id, listingId));
    return;
  }

  // Multi-quantity — decrement and mark sold if depleted
  const newQuantity = listing.quantity - 1;
  await db
    .update(listings)
    .set({
      quantity: newQuantity,
      status: newQuantity === 0 ? 'sold' : listing.status,
      updatedAt: new Date(),
    })
    .where(eq(listings.id, listingId));
}

function publishListingPurchased(body: WebhookBody, listing: typeof listings.$inferSelect, listingId: string): void {
  // App-origin listing.purchased → notify + audit only; settlement is separate below.
  void emitEvent('listing.purchased', {
    issuer: body.metadata?.buyerDid || '',
    subject: listing.sellerDid,
    scope: 'market',
    payload: {
      context_id: listingId,
      context_type: 'market',
      amount: body.metadata?.amount || 0,
      currency: body.metadata?.currency || 'CAD',
      fairManifest: listing.fairManifest || null,
      funded: true,
      funded_provider: 'stripe',
      buyerDid: body.metadata?.buyerDid || '',
      metadata: { listingId },
      interestDids: [body.metadata?.buyerDid, listing.sellerDid].filter((did): did is string => Boolean(did)),
    },
  });
}

/** Record a purchase the kernel already settled on the seller's own Stripe account (#2773). */
async function settleByoPurchase(
  body: WebhookBody,
  listing: typeof listings.$inferSelect,
  listingId: string,
  sessionId: string | undefined,
  fairManifest: FairManifest | null,
): Promise<void> {
  if (!sessionId) {
    log.error({ listingId }, '[settle] BYO purchase webhook carried no Stripe session id — cannot record the receipt');
    return;
  }

  const pending = readPendingCheckout(listing.metadata, sessionId);
  await recordByoSettlement({
    listingId,
    sessionId,
    amountCents: body.metadata?.amount ?? pending?.amountCents ?? 0,
    currency: body.metadata?.currency || listing.currency || 'CAD',
    fairManifest,
  });
}

/**
 * Settle the purchase through market's own app-service token (#2740). The kernel pays out
 * only a payment market's checkout created, so the checkout recorded at purchase time
 * (looked up by Stripe session id) is required; without it there is nothing to settle.
 */
async function settlePurchase(body: WebhookBody, listing: typeof listings.$inferSelect, listingId: string): Promise<void> {
  const fairManifest = (listing.fairManifest as FairManifest | null) || null;
  const sessionId = body.sessionId || body.metadata?.sessionId;

  // #2773: paid on the seller's own Stripe account. The kernel has already completed the payment and
  // told us, so this notification IS the settlement — `/pay/api/settle` refuses such a payment (409).
  if (body.rail === STRIPE_BYO_RAIL) {
    await settleByoPurchase(body, listing, listingId, sessionId, fairManifest);
    return;
  }

  if (!fairManifest?.chain?.length) {
    log.warn({ listingId }, '[settle] No .fair manifest chain for listing — skipping settlement');
    return;
  }

  if (!sessionId) {
    log.error({ listingId }, '[settle] Purchase webhook carried no Stripe session id — cannot find the checkout to settle');
    return;
  }

  const pending = readPendingCheckout(listing.metadata, sessionId);
  if (!pending) {
    log.error(
      { listingId, sessionId },
      '[settle] No recorded checkout for this session — nothing to settle (already settled, or never bound to market)',
    );
    return;
  }

  await settleListingPurchase({
    listingId,
    sessionId,
    pending,
    currency: body.metadata?.currency || listing.currency || 'CAD',
    fairManifest,
  });
}

async function processSuccessfulPayment(body: WebhookBody): Promise<void> {
  const listingId = body.metadata?.listingId;
  if (!listingId) return;

  const [listing] = await db.select().from(listings).where(eq(listings.id, listingId)).limit(1);
  if (!listing) return;

  await applyListingPurchase(listingId, listing);
  publishListingPurchased(body, listing, listingId);
  await settlePurchase(body, listing, listingId);
}

export async function POST(request: NextRequest) {
  let body: WebhookBody;
  try {
    // Authenticate exact bytes and atomically consume the nonce before parsing.
    // The expected recipient is local configuration, never a request header.
    body = await verifyKernelWebhook<WebhookBody>(request, {
      audience: process.env.IMAJIN_APP_DID ?? '',
      authServiceUrl: process.env.AUTH_SERVICE_URL,
    });
  } catch (error) {
    if (!(error instanceof KernelWebhookError) || ['STORE', 'DISCOVERY', 'TRUST'].includes(error.code)) {
      return errorResponse('Webhook verification unavailable', 503);
    }
    if (error.code === 'INVALID_BODY') {
      return errorResponse('Invalid webhook body', 400);
    }
    return errorResponse('Unauthorized', 401);
  }
  try {
    if (isPaymentSuccess(body)) {
      await processSuccessfulPayment(body);
    }

    return jsonResponse({ received: true });
  } catch (error) {
    log.error({ err: String(error) }, 'Webhook error');
    return errorResponse('Webhook processing failed', 500);
  }
}
