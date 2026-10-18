import { eq } from 'drizzle-orm';
import { checkouts, db, listings, type Checkout, type Listing } from '@/db';

/** The kernel overwrites metadata.amount/currency from Stripe; sellerDid is top-level attestation. */
export interface PaidNotification {
  type?: string;
  status?: string;
  sessionId?: string;
  paymentId?: string;
  sellerDid?: string;
  rail?: string;
  metadata?: {
    listingId?: string;
    buyerDid?: string;
    sellerDid?: string;
    amount?: number;
    currency?: string;
    sessionId?: string;
  };
}

export class FulfillmentRejected extends Error {
  constructor() {
    super('Payment does not match a recorded checkout');
  }
}

function requireMatch(condition: boolean): void {
  if (!condition) throw new FulfillmentRejected();
}

function validatePayment(body: PaidNotification, checkout: Checkout): void {
  requireMatch(body.metadata?.listingId === checkout.listingId);
  requireMatch(body.sellerDid === checkout.sellerDid);
  requireMatch(body.metadata?.amount === checkout.amountCents);
  requireMatch(body.metadata?.currency === checkout.currency);
  // Metadata identity can corroborate the record, but cannot supply a different buyer or seller.
  requireMatch(body.metadata?.buyerDid === (checkout.buyerDid || undefined));
  requireMatch(body.metadata?.sellerDid === undefined || body.metadata.sellerDid === checkout.sellerDid);
  requireMatch(body.metadata?.sessionId === undefined || body.metadata.sessionId === checkout.sessionId);
}

function validateListing(listing: Listing, checkout: Checkout): void {
  requireMatch(listing.sellerDid === checkout.sellerDid);
  requireMatch(listing.price === checkout.unitPrice && listing.currency === checkout.currency);
  requireMatch(Number.isSafeInteger(checkout.quantity) && checkout.quantity > 0);
  const expectedAmount = listing.price * checkout.quantity;
  requireMatch(Number.isSafeInteger(expectedAmount) && expectedAmount > 0 && expectedAmount === checkout.amountCents);
  requireMatch(listing.status === 'active');
  requireMatch(listing.quantity === null || listing.quantity >= checkout.quantity);
}

/**
 * Lock both ownership and inventory. The unique payment claim and stock update commit together.
 * A fresh signature/nonce does not bypass the durable fulfillment marker; rollback releases both.
 */
export function claimPaidCheckout(body: PaidNotification): Promise<{ checkout: Checkout; listing: Listing } | null> {
  requireMatch(typeof body.sessionId === 'string' && body.sessionId.length > 0);
  requireMatch(typeof body.paymentId === 'string' && body.paymentId.length > 0);
  return db.transaction(async (tx) => {
    const [checkout] = await tx.select().from(checkouts).where(eq(checkouts.sessionId, body.sessionId!)).for('update');
    if (!checkout) throw new FulfillmentRejected();
    validatePayment(body, checkout);
    if (checkout.fulfilledAt) {
      requireMatch(checkout.paymentId === body.paymentId);
      return null;
    }

    const [listing] = await tx.select().from(listings).where(eq(listings.id, checkout.listingId)).for('update');
    if (!listing) throw new FulfillmentRejected();
    validateListing(listing, checkout);

    // payment_id is unique across sessions/listings, not just within this checkout.
    await tx.update(checkouts).set({ paymentId: body.paymentId, fulfilledAt: new Date() })
      .where(eq(checkouts.sessionId, checkout.sessionId));
    const quantity = listing.quantity === null ? null : listing.quantity - checkout.quantity;
    await tx.update(listings).set({
      quantity,
      status: quantity === 0 ? 'sold' : listing.status,
      updatedAt: new Date(),
    }).where(eq(listings.id, listing.id));
    return { checkout, listing };
  });
}
