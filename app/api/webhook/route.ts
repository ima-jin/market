/**
 * POST /api/webhook
 *
 * Called by the pay service after a successful payment.
 * Updates listing status/quantity accordingly.
 */

import { timingSafeEqual } from 'node:crypto';
import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { createLogger } from '@ima-jin/logger';
import { db, listings } from '@/db';
import { webhookSecret } from '@/lib/env';
import { emitEvent } from '@/lib/kernel/events';
import { readPendingCheckout } from '@/lib/pending-checkout';
import { settleListingPurchase, type FairManifest } from '@/lib/settle';
import { errorResponse, jsonResponse } from '@/lib/utils';

const log = createLogger('market');

interface WebhookBody {
  type?: string;
  status?: string;
  /** Stripe Checkout session id of the payment (#2740) — keys the checkout recorded at purchase time. */
  sessionId?: string;
  metadata?: {
    listingId?: string;
    buyerDid?: string;
    amount?: number;
    currency?: string;
    sessionId?: string;
  };
}

function secretsMatch(provided: unknown, expected: string): boolean {
  if (typeof provided !== 'string') return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Verify the caller (#2740, #2743). The kernel authenticates server-to-server with
 * `Authorization: Bearer <WEBHOOK_SECRET>`; that is the only accepted scheme — the legacy
 * `x-webhook-secret` header and body `secret` get 401. Fails closed: with no secret
 * configured, nothing is authorized.
 */
function isWebhookAuthorized(request: NextRequest): boolean {
  const expected = webhookSecret();
  if (!expected) return false;

  const authorization = request.headers.get('authorization');
  const bearer = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : undefined;
  return secretsMatch(bearer, expected);
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
  // listing.purchased → attestation + settle + notify reactors (kernel-side)
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

/**
 * Settle the purchase through market's own app-service token (#2740). The kernel pays out
 * only a payment market's checkout created, so the checkout recorded at purchase time
 * (looked up by Stripe session id) is required; without it there is nothing to settle.
 */
async function settlePurchase(body: WebhookBody, listing: typeof listings.$inferSelect, listingId: string): Promise<void> {
  const fairManifest = (listing.fairManifest as FairManifest | null) || null;
  if (!fairManifest?.chain?.length) {
    log.warn({ listingId }, '[settle] No .fair manifest chain for listing — skipping settlement');
    return;
  }

  const sessionId = body.sessionId || body.metadata?.sessionId;
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
  try {
    const body = await request.json();

    // Verify the caller (Bearer secret only)
    if (!isWebhookAuthorized(request)) {
      return errorResponse('Unauthorized', 401);
    }

    if (isPaymentSuccess(body)) {
      await processSuccessfulPayment(body);
    }

    return jsonResponse({ received: true });
  } catch (error) {
    log.error({ err: String(error) }, 'Webhook error');
    return errorResponse('Webhook processing failed', 500);
  }
}
