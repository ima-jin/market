import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { createLogger } from '@ima-jin/logger';
import { db, sellerSettings } from '@/db';
import { authenticate } from '@/lib/auth/authenticate';
import { errorResponse, jsonResponse } from '@/lib/utils';

const log = createLogger('market');

/**
 * GET /api/seller/settings — Get settings for authenticated seller
 * Creates default row if none exists.
 */
export async function GET(request: NextRequest) {
  const authResult = await authenticate(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status);
  }

  const did = authResult.auth.did;

  try {
    let [settings] = await db.select().from(sellerSettings).where(eq(sellerSettings.did, did));

    if (!settings) {
      [settings] = await db.insert(sellerSettings).values({ did, showMarketItems: false }).returning();
    }

    return jsonResponse({ showMarketItems: settings.showMarketItems });
  } catch (error) {
    log.error({ err: String(error) }, 'Failed to fetch seller settings');
    return errorResponse('Failed to fetch settings', 500);
  }
}

/**
 * PATCH /api/seller/settings — Update settings for authenticated seller
 * Body: { showMarketItems: boolean }
 */
export async function PATCH(request: NextRequest) {
  const authResult = await authenticate(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status);
  }

  const did = authResult.auth.did;

  try {
    const body = await request.json();
    const { showMarketItems } = body;

    if (typeof showMarketItems !== 'boolean') {
      return errorResponse('showMarketItems must be a boolean');
    }

    const [settings] = await db
      .insert(sellerSettings)
      .values({ did, showMarketItems, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: sellerSettings.did,
        set: { showMarketItems, updatedAt: new Date() },
      })
      .returning();

    return jsonResponse({ showMarketItems: settings.showMarketItems });
  } catch (error) {
    log.error({ err: String(error) }, 'Failed to update seller settings');
    return errorResponse('Failed to update settings', 500);
  }
}
