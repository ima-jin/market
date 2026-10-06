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
import { errorResponse, jsonResponse } from '@/lib/utils';

const log = createLogger('market');

interface WebhookBody {
  type?: string;
  status?: string;
  secret?: string;
  metadata?: {
    listingId?: string;
    buyerDid?: string;
    amount?: number;
    currency?: string;
  };
}

function secretsMatch(provided: unknown, expected: string): boolean {
  if (typeof provided !== 'string') return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The secret may arrive in the `x-webhook-secret` header or the body.
 * Fails closed when WEBHOOK_SECRET is not configured — an unset secret must
 * never authorize a request.
 */
function isWebhookAuthorized(headerSecret: string | null, bodySecret: unknown): boolean {
  const expected = webhookSecret();
  if (!expected) return false;
  return secretsMatch(headerSecret, expected) || secretsMatch(bodySecret, expected);
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

async function processSuccessfulPayment(body: WebhookBody): Promise<void> {
  const listingId = body.metadata?.listingId;
  if (!listingId) return;

  const [listing] = await db.select().from(listings).where(eq(listings.id, listingId)).limit(1);
  if (!listing) return;

  await applyListingPurchase(listingId, listing);
  publishListingPurchased(body, listing, listingId);
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    // Verify webhook secret from header or body
    const headerSecret = request.headers.get('x-webhook-secret');
    if (!isWebhookAuthorized(headerSecret, body?.secret)) {
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
