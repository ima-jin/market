/**
 * POST /api/webhook — kernel-signed payment notifications.
 * Fulfillment requires a server-recorded checkout, attested seller and DB price.
 */
import { NextRequest } from 'next/server';
import { KernelWebhookError, verifyKernelWebhook } from '@ima-jin/auth/kernel-webhook';
import { createLogger } from '@ima-jin/logger';
import type { Checkout, Listing } from '@/db';
import { STRIPE_BYO_RAIL } from '@/lib/card-rail';
import { claimPaidCheckout, FulfillmentRejected, type PaidNotification } from '@/lib/fulfillment';
import { emitEvent } from '@/lib/kernel/events';
import { recordByoSettlement, settleListingPurchase, type FairManifest } from '@/lib/settle';
import { errorResponse, jsonResponse } from '@/lib/utils';

const log = createLogger('market');

function isPaymentSuccess(body: PaidNotification): boolean {
  return body.type === 'payment.succeeded' || body.status === 'paid' || body.status === 'succeeded';
}
function auditId(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function publishListingPurchased(checkout: Checkout, listing: Listing): void {
  // Only the atomic claim winner emits; identity/value come from the server's checkout.
  void emitEvent('listing.purchased', {
    ...(checkout.buyerDid ? { issuer: checkout.buyerDid } : {}),
    subject: checkout.sellerDid,
    scope: 'market',
    payload: {
      context_id: checkout.listingId,
      context_type: 'market',
      amount: checkout.amountCents,
      currency: checkout.currency,
      fairManifest: listing.fairManifest || null,
      funded: true,
      funded_provider: 'stripe',
      buyerDid: checkout.buyerDid,
      metadata: { listingId: checkout.listingId },
      interestDids: [checkout.buyerDid, checkout.sellerDid].filter(Boolean),
    },
  });
}

async function processSuccessfulPayment(body: PaidNotification): Promise<void> {
  const claimed = await claimPaidCheckout(body);
  if (!claimed) return;
  const { checkout, listing } = claimed;
  const fairManifest = (listing.fairManifest as FairManifest | null) || null;
  const settlement = {
    listingId: checkout.listingId,
    sessionId: checkout.sessionId,
    currency: checkout.currency,
    fairManifest,
  };

  if (body.rail === STRIPE_BYO_RAIL) {
    await recordByoSettlement({ ...settlement, amountCents: checkout.amountCents });
  } else if (checkout.chain.length > 0) {
    await settleListingPurchase({
      ...settlement,
      pending: {
        transactionId: checkout.transactionId,
        amountCents: checkout.amountCents,
        chain: checkout.chain,
        at: checkout.createdAt.toISOString(),
      },
    });
  }
  publishListingPurchased(checkout, listing);
}

export async function POST(request: NextRequest) {
  let body: PaidNotification;
  try {
    // Authenticate exact bytes and atomically consume the nonce before parsing.
    body = await verifyKernelWebhook<PaidNotification>(request, {
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
    if (body === null || typeof body !== 'object') return errorResponse('Invalid webhook body', 400);
    if (isPaymentSuccess(body)) await processSuccessfulPayment(body);
    return jsonResponse({ received: true });
  } catch (error) {
    if (error instanceof FulfillmentRejected) {
      log.warn({
        sessionId: auditId(body.sessionId),
        paymentId: auditId(body.paymentId),
        listingId: auditId(body.metadata?.listingId),
        reason: error.code,
      }, 'paid notification refused');
      if (error.code === 'PAYMENT_ID_CONFLICT') {
        return jsonResponse({ error: error.message, code: error.code }, 409);
      }
      return errorResponse(error.message, 400);
    }
    // Query errors can embed SQL parameters; keep unknown failures out of logs.
    log.error({ reason: 'PROCESSING_FAILED' }, 'Webhook error');
    return errorResponse('Webhook processing failed', 500);
  }
}
