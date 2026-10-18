/**
 * Pending-checkout bookkeeping for settlement (#2740).
 *
 * `POST /pay/api/settle` settles by `transaction_id` — the id the app-authenticated
 * checkout returned — and verifies the posted chain against the payee manifest
 * declared at that checkout. The purchase route therefore remembers, per Stripe
 * session, the transaction id plus the exact payee chain it declared; the
 * purchase webhook looks the entry up by session id and settles with it.
 *
 * Ownership lives in the server-only checkouts table. Seller-editable listing
 * metadata is not an authority, and legacy entries there fail closed (#30).
 */
import { sql, eq } from 'drizzle-orm';
import { checkouts, db, listings } from '@/db';

/** One settled payee — the shape `/pay/api/settle`'s `fair_manifest.chain` takes (dollars). */
export interface PayeeChainEntry {
  did: string;
  role: string;
  amount: number;
}

export interface PendingCheckout {
  /** `transactionId` returned by pay's `/api/checkout`. */
  transactionId: string;
  /** Gross payment in cents. */
  amountCents: number;
  /** The payee chain declared at checkout (dollars); settlement posts exactly this. */
  chain: PayeeChainEntry[];
  /** ISO timestamp the checkout was recorded. */
  at: string;
}

export interface CheckoutOwnership {
  sellerDid: string;
  buyerDid: string;
  quantity: number;
  unitPrice: number;
  currency: string;
}

/** Remember every checkout, including no-chain/BYO payments. Duplicate ownership is never overwritten. */
export async function recordPendingCheckout(
  listingId: string,
  sessionId: string,
  entry: Omit<PendingCheckout, 'at'> & CheckoutOwnership,
): Promise<void> {
  await db.insert(checkouts).values({ listingId, sessionId, ...entry });
}

/**
 * Store the settled `.fair` receipt on the listing and drop the now-settled pending
 * entry, atomically (`||` merges the receipt, `#-` deletes the entry).
 */
export async function saveSettlementSnapshot(listingId: string, sessionId: string, fairSettlement: unknown): Promise<void> {
  await db
    .update(listings)
    .set({
      metadata: sql`(
        coalesce(${listings.metadata}, '{}'::jsonb)
        || jsonb_build_object('fairSettlement', ${JSON.stringify(fairSettlement)}::jsonb)
      ) #- array['pendingCheckouts', ${sessionId}::text]`,
    })
    .where(eq(listings.id, listingId));
}
