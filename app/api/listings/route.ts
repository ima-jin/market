import { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { createLogger } from '@ima-jin/logger';
import { db, listings } from '@/db';
import { authenticate, authenticateOptional } from '@/lib/auth/authenticate';
import { emitEvent } from '@/lib/kernel/events';
import {
  MAX_IMAGES,
  VALID_SELLER_TIERS,
  andAll,
  buildListingFairManifest,
  buildListingsWhereConditions,
  parseListingsQuery,
  resolveListingsSortOrder,
} from '@/lib/listings';
import { resolveMediaRef } from '@/lib/media';
import { errorResponse, generateId, jsonResponse } from '@/lib/utils';

const log = createLogger('market');

interface ContactInfo {
  phone?: string;
  email?: string;
  whatsapp?: string;
}

function hasContactInfo(contactInfo: ContactInfo | null | undefined): boolean {
  return Boolean(contactInfo && (contactInfo.phone || contactInfo.email || contactInfo.whatsapp));
}

/**
 * Validates a create-listing body. Returns an error message, or null when valid.
 */
function validateCreateBody(body: {
  title?: string;
  price?: number;
  images?: unknown;
  sellerTier?: string;
  contactInfo?: ContactInfo | null;
}): string | null {
  if (!body.title) {
    return 'title is required';
  }
  if (!body.price || body.price <= 0) {
    return 'price must be greater than 0';
  }
  if (body.images && (!Array.isArray(body.images) || body.images.length > MAX_IMAGES)) {
    return `images must be an array with at most ${MAX_IMAGES} items`;
  }
  if (body.sellerTier && !(VALID_SELLER_TIERS as readonly string[]).includes(body.sellerTier)) {
    return `sellerTier must be one of: ${VALID_SELLER_TIERS.join(', ')}`;
  }
  // Tier 1 requires contact info
  const isOffPlatform = body.sellerTier === 'public_offplatform' || !body.sellerTier;
  if (isOffPlatform && !hasContactInfo(body.contactInfo)) {
    return 'contactInfo must include at least one of: phone, email, whatsapp for public_offplatform tier';
  }
  return null;
}

/**
 * POST /api/listings — Create listing
 */
export async function POST(request: NextRequest) {
  const authResult = await authenticate(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status);
  }

  const did = authResult.auth.did;

  try {
    const body = await request.json();

    const validationError = validateCreateBody(body);
    if (validationError) {
      return errorResponse(validationError);
    }

    const {
      title,
      description,
      price,
      currency,
      category,
      images,
      quantity,
      sellerTier,
      contactInfo,
      trustThreshold,
      rangeKm,
      metadata,
      imageAssetIds,
      type,
      showContactInfo,
      expiresAt,
    } = body;

    const listingId = generateId('lst');
    const fairManifest = await buildListingFairManifest(did, listingId);

    const [listing] = await db
      .insert(listings)
      .values({
        id: listingId,
        sellerDid: did,
        title,
        description: description || null,
        price,
        currency: currency || 'CAD',
        category: category || null,
        images: images || [],
        imageAssetIds: imageAssetIds || [],
        quantity: quantity ?? 1,
        sellerTier: sellerTier || 'public_offplatform',
        contactInfo: contactInfo || null,
        trustThreshold: trustThreshold || null,
        rangeKm: rangeKm ?? 50,
        metadata: metadata || {},
        type: type || 'sale',
        showContactInfo: showContactInfo ?? false,
        expiresAt: expiresAt ? new Date(expiresAt) : null,
        fairManifest,
      })
      .returning();

    // Fire and forget — never block the response
    void emitEvent('listing.create', {
      issuer: did,
      subject: did,
      scope: 'market',
      payload: { listingId: listing.id, title, price },
    });
    void emitEvent('listing.created', {
      issuer: did,
      subject: did,
      scope: 'market',
      payload: {
        context_id: listing.id,
        context_type: 'market',
        title,
        price,
        currency: listing.currency ?? 'CAD',
        interestDids: [did],
      },
    });

    return jsonResponse(listing, 201);
  } catch (error) {
    log.error({ err: String(error) }, 'Failed to create listing');
    return errorResponse('Failed to create listing', 500);
  }
}

/**
 * GET /api/listings — Browse/search listings
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const query = parseListingsQuery(searchParams);

    // Check if requester is the seller (can see all their own statuses)
    const caller = await authenticateOptional(request);
    const authSellerDid = caller ? caller.did : null;

    const conditions = buildListingsWhereConditions({
      searchParams,
      status: query.status,
      sellerDid: query.sellerDid,
      authSellerDid,
      hasSession: caller !== null,
      exclude: query.exclude,
      category: query.category,
      currency: query.currency,
      sellerTier: query.sellerTier,
    });

    const whereClause = andAll(conditions);
    const orderBy = resolveListingsSortOrder(query.sort);

    const [rows, countResult] = await Promise.all([
      db.select().from(listings).where(whereClause).orderBy(orderBy).limit(query.limit).offset(query.offset),
      db.select({ count: sql<number>`count(*)` }).from(listings).where(whereClause),
    ]);

    const total = Number(countResult[0]?.count ?? 0);

    // Resolve asset IDs to full URLs so consumers don't need to know about media internals
    const resolved = rows.map((row) => ({
      ...row,
      images: Array.isArray(row.images)
        ? (row.images as string[]).map((ref) => resolveMediaRef(ref, 'card'))
        : row.images,
    }));

    return jsonResponse({
      listings: resolved,
      total,
      page: query.page,
      limit: query.limit,
      hasMore: query.offset + rows.length < total,
    });
  } catch (error) {
    log.error({ err: String(error) }, 'Failed to fetch listings');
    return errorResponse('Failed to fetch listings', 500);
  }
}
