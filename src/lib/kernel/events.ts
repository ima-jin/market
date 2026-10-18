import { createLogger } from '@ima-jin/logger';
import { getAppServiceToken, resetAppServiceTokenCache } from '@/lib/app-token';
import { kernelUrl } from '@/lib/env';

const log = createLogger('market');

export type MarketEventType =
  | 'listing.created'
  | 'listing.updated'
  | 'listing.purchased';

export interface MarketEvent {
  issuer?: string;
  subject: string;
  scope: 'market';
  payload: Record<string, unknown>;
  correlationId?: string;
}

/**
 * Public app-service-token surface: notify and audit only, never settlement
 * or attestations. The kernel owns issuer, origin and scope; the caller cannot
 * set them on the wire. Types must be operator-approved after declaration.
 *
 * Always resolves, never rejects — emission is fire-and-forget by contract.
 */
export async function emitEvent(type: MarketEventType, event: MarketEvent): Promise<void> {
  const base = kernelUrl();
  if (!base) {
    log.error({ type, setting: 'IMAJIN_KERNEL_URL' }, 'Domain event delivery unavailable — IMAJIN_KERNEL_URL is not set');
    return;
  }
  if (!process.env.IMAJIN_APP_DID) {
    log.error({ type, setting: 'IMAJIN_APP_DID' }, 'Domain event delivery unavailable — IMAJIN_APP_DID is not set');
    return;
  }

  let stage = 'app-service token mint';
  try {
    const token = await getAppServiceToken();
    stage = 'POST /api/events';
    const response = await fetch(`${base}/api/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        type,
        subject: event.subject,
        payload: event.payload,
        correlationId: event.correlationId,
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      if (response.status === 401) resetAppServiceTokenCache();
      log.error(
        { type, status: response.status, retryAfter: response.headers.get('Retry-After') },
        'Kernel refused domain event — check app identity and operator-approved emittableEvents; no automatic retry',
      );
    }
  } catch {
    // Never log the token, signing material, payload, or an untrusted response/error body.
    log.error(
      { type, stage },
      'Domain event delivery failed — check IMAJIN_KERNEL_URL, IMAJIN_APP_DID and claimed identity (IMAJIN_APP_KEYSTORE)',
    );
  }
}
