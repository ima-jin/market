import { createLogger } from '@ima-jin/logger';

const log = createLogger('market');

export type MarketEventType =
  | 'listing.create'
  | 'listing.created'
  | 'listing.update'
  | 'listing.purchase'
  | 'listing.purchased';

export interface MarketEvent {
  issuer: string;
  subject: string;
  scope: 'market';
  payload: Record<string, unknown>;
}

/**
 * The single seam through which this app emits domain events.
 *
 * The kernel version publishes through the in-process `@imajin/bus`, which
 * an arms-length app can neither import nor reach (AGENTS.md §2). The kernel
 * has no public, app-token-gated route that accepts these events yet —
 * tracked in ima-jin/imajin-ai#2638 — so for now this logs and resolves.
 * Consequence: post-purchase reactors (attestation, settlement, notify) do
 * not fire for sales made through this app until that gap is closed. When it
 * is, only this function changes.
 *
 * Always resolves, never rejects — emission is fire-and-forget by contract.
 */
export async function emitEvent(type: MarketEventType, event: MarketEvent): Promise<void> {
  log.debug({ type, scope: event.scope, subject: event.subject }, 'Domain event not forwarded (kernel gap #2638)');
}
