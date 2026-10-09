/**
 * Card-rail outcomes from pay's `POST /api/checkout` (ima-jin/imajin-ai#2757, #2773).
 *
 * Stripe Connect is gone: a card payment is charged on the SELLER'S OWN Stripe account
 * through their BYO connector. A seller with no connected key gets a 400 with the stable
 * `code: "SELLER_NO_CARD_RAIL"`; a connected seller whose Stripe account cannot take the
 * charge right now gets a 502 with one of the `CARD_RAIL_*` codes. Neither is a server
 * fault, so neither may surface as a generic "Payment service error".
 */

/** Pay's stable code when the seller has no card rail (no connected Stripe key). */
export const SELLER_NO_CARD_RAIL = 'SELLER_NO_CARD_RAIL';

/** The `rail` pay puts on the purchase webhook for a payment it already settled on the seller's own Stripe. */
export const STRIPE_BYO_RAIL = 'stripe-byo';

/** What a buyer is told when the seller has not set up card payments. */
export const NO_CARD_RAIL_MESSAGE =
  "Card payments aren't set up for this seller yet. Please contact the seller about another way to pay.";

/** What the seller sees on their own listing when they have no card rail. */
export const OWNER_NO_CARD_RAIL_MESSAGE =
  "Card payments aren't set up. Buyers can't pay by card until you connect your Stripe key under Connectors.";

/** What a buyer is told when the seller's Stripe account could not start the charge. */
export const CARD_RAIL_UNAVAILABLE_MESSAGE =
  "Card payment couldn't be started on the seller's Stripe account. Please try again later or contact the seller.";

/** Pay's `CARD_RAIL_*` codes: the seller has a key, but their Stripe account would not take the charge. */
const CARD_RAIL_FAILURE_CODES = new Set([
  'CARD_RAIL_KEY_MISSING',
  'CARD_RAIL_KEY_REJECTED',
  'CARD_RAIL_UNAVAILABLE',
  'CARD_RAIL_REQUEST_REJECTED',
]);

export interface CardRailFailure {
  /** Plain, buyer-facing sentence. */
  message: string;
  status: number;
  /** The pay code, passed through so the client can react to it. */
  code: string;
}

/**
 * Map a pay checkout error `code` to a plain buyer-facing failure, or `null` when the code is
 * not a card-rail outcome (the caller then keeps its own handling).
 */
export function cardRailFailure(code: unknown): CardRailFailure | null {
  if (code === SELLER_NO_CARD_RAIL) {
    return { message: NO_CARD_RAIL_MESSAGE, status: 400, code: SELLER_NO_CARD_RAIL };
  }
  if (typeof code === 'string' && CARD_RAIL_FAILURE_CODES.has(code)) {
    return { message: CARD_RAIL_UNAVAILABLE_MESSAGE, status: 502, code };
  }
  return null;
}
