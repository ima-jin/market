import { and, asc, desc, eq, ilike, ne, sql } from 'drizzle-orm';
import { buildFairManifest, type FairFeeManifest } from '@ima-jin/fair';
import { createLogger } from '@ima-jin/logger';
import { listings } from '@/db';
import { fetchNodeSelf } from '@/lib/kernel/client';

const log = createLogger('market');

export const VALID_SELLER_TIERS = ['public_offplatform', 'public_onplatform', 'trust_gated'] as const;

export const MAX_IMAGES = 8;

export const STATUS_TRANSITIONS: Record<string, string[]> = {
  active: ['paused', 'sold', 'rented', 'unavailable'],
  paused: ['active', 'removed'],
  unavailable: ['active', 'removed'],
  sold: ['removed'],
  rented: ['removed'],
  removed: [],
};

export function validateStatusTransition(currentStatus: string, nextStatus: string): string | null {
  const validNext = STATUS_TRANSITIONS[currentStatus] ?? [];
  if (validNext.includes(nextStatus)) return null;
  return `Cannot transition listing from '${currentStatus}' to '${nextStatus}'. Allowed: ${validNext.join(', ') || 'none'}`;
}

export interface PageParams {
  page: number;
  limit: number;
  offset: number;
}

export function parsePagination(searchParams: URLSearchParams): PageParams {
  const parsedPage = Number.parseInt(searchParams.get('page') || '1', 10);
  const parsedLimit = Number.parseInt(searchParams.get('limit') || '20', 10);
  // Non-numeric input falls back to the defaults instead of propagating NaN into the query.
  const page = Math.max(1, Number.isNaN(parsedPage) ? 1 : parsedPage);
  const limit = Math.min(100, Math.max(1, Number.isNaN(parsedLimit) ? 20 : parsedLimit));
  return { page, limit, offset: (page - 1) * limit };
}

export function resolveListingsSortOrder(sort: string) {
  if (sort === 'price_asc') return asc(listings.price);
  if (sort === 'price_desc') return desc(listings.price);
  return desc(listings.createdAt);
}

export function parseListingsQuery(searchParams: URLSearchParams) {
  return {
    category: searchParams.get('category'),
    status: searchParams.get('status') || 'active',
    currency: searchParams.get('currency'),
    sellerTier: searchParams.get('seller_tier'),
    sellerDid: searchParams.get('seller_did'),
    exclude: searchParams.get('exclude'),
    sort: searchParams.get('sort') || 'newest',
    ...parsePagination(searchParams),
  };
}

function buildOwnerOrPublicStatusConditions(
  searchParams: URLSearchParams,
  status: string,
  sellerDid: string | null,
  authSellerDid: string | null
) {
  const conditions = [];
  if (sellerDid && sellerDid === authSellerDid) {
    // Authenticated seller viewing their own — respect explicit status filter if provided
    if (searchParams.has('status')) {
      conditions.push(eq(listings.status, status));
    }
    conditions.push(eq(listings.sellerDid, sellerDid));
  } else {
    conditions.push(eq(listings.status, status));
    if (sellerDid) {
      conditions.push(eq(listings.sellerDid, sellerDid));
    }
  }
  return conditions;
}

export interface ListingsWhereParams {
  searchParams: URLSearchParams;
  status: string;
  sellerDid: string | null;
  authSellerDid: string | null;
  hasSession: boolean;
  exclude: string | null;
  category: string | null;
  currency: string | null;
  sellerTier: string | null;
}

export function buildListingsWhereConditions(params: ListingsWhereParams) {
  const { searchParams, status, sellerDid, authSellerDid, hasSession, exclude, category, currency, sellerTier } = params;

  const conditions = buildOwnerOrPublicStatusConditions(searchParams, status, sellerDid, authSellerDid);

  // Filter out trust_gated listings for unauthenticated users
  if (!hasSession) {
    conditions.push(sql`${listings.sellerTier} != 'trust_gated'`);
  }

  // Exclude a specific listing ID (e.g. for 'other items by seller' queries)
  if (exclude) {
    conditions.push(ne(listings.id, exclude));
  }

  if (category) {
    conditions.push(ilike(listings.category, `%${category}%`));
  }

  if (currency) {
    conditions.push(eq(listings.currency, currency.toUpperCase()));
  }

  if (sellerTier) {
    conditions.push(eq(listings.sellerTier, sellerTier));
  }

  return conditions;
}

export function andAll(conditions: ReturnType<typeof buildListingsWhereConditions>) {
  return conditions.length > 0 ? and(...conditions) : undefined;
}

export const UPDATABLE_LISTING_FIELDS = [
  'title',
  'description',
  'price',
  'currency',
  'category',
  'images',
  'imageAssetIds',
  'quantity',
  'sellerTier',
  'contactInfo',
  'rangeKm',
  'metadata',
  'status',
  'type',
  'showContactInfo',
] as const;

export type ListingPatchBody = Partial<{
  title: string;
  description: string;
  price: number;
  currency: string;
  category: string;
  images: string[];
  imageAssetIds: string[];
  quantity: number;
  sellerTier: string;
  contactInfo: Record<string, unknown>;
  rangeKm: number;
  metadata: Record<string, unknown>;
  status: string;
  type: string;
  showContactInfo: boolean;
  expiresAt: string;
}>;

export function buildListingUpdates(body: ListingPatchBody): Record<string, unknown> {
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  for (const field of UPDATABLE_LISTING_FIELDS) {
    if (body[field] !== undefined) {
      updates[field] = body[field];
    }
  }
  if (body.expiresAt !== undefined) {
    updates.expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
  }
  return updates;
}

/**
 * Build the listing's `.fair` manifest from this node's fee config. The
 * kernel version also threaded an acting-as scope (scopeDid / scopeFeeBps)
 * through here; `requireSessionOrAppToken` does not carry `actingAs`
 * (ima-jin/imajin-ai#2639), so every listing is built for the caller's own DID.
 */
export async function buildListingFairManifest(creatorDid: string, listingId: string): Promise<FairFeeManifest> {
  const nodeSelf = await fetchNodeSelf();
  return buildFairManifest({
    creatorDid,
    contentDid: listingId,
    contentType: 'listing',
    scopeDid: null,
    scopeFeeBps: null,
    nodeFeeBps: nodeSelf?.nodeFeeBps ?? undefined,
    buyerCreditBps: nodeSelf?.buyerCreditBps ?? undefined,
    nodeOperatorDid: nodeSelf?.nodeOperatorDid ?? undefined,
  });
}

/**
 * Recalculate the `.fair` manifest when price or tier changes. Returns
 * `undefined` when nothing relevant changed or the rebuild failed (non-fatal).
 */
export async function recalculateFairManifest(params: {
  did: string;
  listing: typeof listings.$inferSelect;
  listingId: string;
  price?: number;
  sellerTier?: string;
}): Promise<FairFeeManifest | undefined> {
  const { did, listing, listingId, price, sellerTier } = params;
  const priceChanged = price !== undefined && price !== listing.price;
  const tierChanged = sellerTier !== undefined && sellerTier !== listing.sellerTier;
  const sellerDidChanged = did !== listing.sellerDid;

  if (!priceChanged && !tierChanged && !sellerDidChanged) {
    return undefined;
  }

  try {
    return await buildListingFairManifest(did, listingId);
  } catch (manifestErr) {
    log.warn({ err: String(manifestErr) }, 'Failed to recalculate .fair manifest (non-fatal)');
    return undefined;
  }
}
