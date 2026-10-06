import { NextRequest } from 'next/server';
import { and, eq, sql } from 'drizzle-orm';
import { createLogger } from '@ima-jin/logger';
import { db, listings } from '@/db';
import { authenticate } from '@/lib/auth/authenticate';
import { parsePagination, resolveListingsSortOrder } from '@/lib/listings';
import { errorResponse, jsonResponse } from '@/lib/utils';

const log = createLogger('market');

/**
 * GET /api/my/listings — Seller's own listings
 */
export async function GET(request: NextRequest) {
  const authResult = await authenticate(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status);
  }

  try {
    const { searchParams } = new URL(request.url);
    const status = searchParams.get('status');
    const sort = searchParams.get('sort') || 'newest';
    const { page, limit, offset } = parsePagination(searchParams);

    const conditions = [eq(listings.sellerDid, authResult.auth.did)];
    if (status) {
      conditions.push(eq(listings.status, status));
    }

    const whereClause = and(...conditions);
    const orderBy = resolveListingsSortOrder(sort);

    const [rows, countResult] = await Promise.all([
      db.select().from(listings).where(whereClause).orderBy(orderBy).limit(limit).offset(offset),
      db.select({ count: sql<number>`count(*)` }).from(listings).where(whereClause),
    ]);

    const total = Number(countResult[0]?.count ?? 0);

    return jsonResponse({
      listings: rows,
      total,
      page,
      limit,
      hasMore: offset + rows.length < total,
    });
  } catch (error) {
    log.error({ err: String(error) }, 'Failed to fetch listings');
    return errorResponse('Failed to fetch listings', 500);
  }
}
