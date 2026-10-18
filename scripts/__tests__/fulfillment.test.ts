import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const config = vi.hoisted(() => ({
  url: process.env.DATABASE_URL,
  database: `market_fulfillment_${process.pid}_${Date.now()}`,
}));

// A pool of independent connections exercises actual row locks, not the production pool's max:1 serialization.
vi.mock('@/db', async () => {
  const { drizzle } = await import('drizzle-orm/postgres-js');
  const { default: connect } = await import('postgres');
  const schema = await import('../../src/db/schema');
  let client;
  if (config.url) {
    const url = new URL(config.url);
    url.pathname = `/${config.database}`;
    client = connect(url.toString(), { max: 8, onnotice: () => {} });
  } else {
    client = connect({ max: 8 });
  }
  return { ...schema, db: drizzle(client, { schema }) };
});

import { checkouts, db, listings } from '@/db';
import { claimPaidCheckout, FulfillmentRejected, type PaidNotification } from '@/lib/fulfillment';
import { recordPendingCheckout, saveSettlementSnapshot } from '@/lib/pending-checkout';

const migrationsFolder = fileURLToPath(new URL('../../migrations', import.meta.url));
const ownership = {
  transactionId: 'tx_1', sellerDid: 'did:imajin:seller', buyerDid: 'did:imajin:buyer',
  quantity: 2, unitPrice: 5000, amountCents: 10000, currency: 'CAD', chain: [],
};
const notification: PaidNotification = {
  type: 'payment.succeeded', sessionId: 'cs_1', paymentId: 'pi_1', sellerDid: ownership.sellerDid,
  rail: 'stripe-byo',
  metadata: { listingId: 'lst_1', buyerDid: ownership.buyerDid, amount: 10000, currency: 'CAD' },
};

describe.skipIf(!config.url)('fulfillment binding against real Postgres (#30)', () => {
  let admin: postgres.Sql;

  beforeAll(async () => {
    admin = postgres(config.url as string, { max: 1, onnotice: () => {} });
    await admin.unsafe(`CREATE DATABASE ${config.database}`);
    await migrate(db, { migrationsFolder, migrationsSchema: 'market' });
  });

  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
    await admin.unsafe(`DROP DATABASE ${config.database} WITH (FORCE)`);
    await admin.end({ timeout: 5 });
  });

  beforeEach(async () => {
    // Only this suite's throwaway database is reset.
    await db.$client`TRUNCATE market.checkouts, market.listings CASCADE`;
    await db.insert(listings).values({
      id: 'lst_1', sellerDid: ownership.sellerDid, title: 'Chair', price: 5000,
      currency: 'CAD', quantity: 10, status: 'active',
    });
    await recordPendingCheckout('lst_1', 'cs_1', ownership);
  });

  async function stock() {
    const [listing] = await db.select().from(listings).where(eq(listings.id, 'lst_1'));
    return listing.quantity;
  }

  it('fulfills one of eight concurrent deliveries, then ignores fresh redeliveries', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => claimPaidCheckout(notification)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await stock()).toBe(8);
    await saveSettlementSnapshot('lst_1', 'cs_1', { rail: 'stripe-byo', totalAmount: 100 });
    // Removing/replacing editable metadata must not remove the fulfillment claim.
    await db.update(listings).set({ metadata: {} }).where(eq(listings.id, 'lst_1'));
    expect(await claimPaidCheckout(notification)).toBeNull();
    expect(await stock()).toBe(8);
  });

  it('serializes different buyers on the same listing without losing a decrement', async () => {
    await recordPendingCheckout('lst_1', 'cs_2', { ...ownership, transactionId: 'tx_2' });
    const results = await Promise.all([
      claimPaidCheckout(notification),
      claimPaidCheckout({ ...notification, sessionId: 'cs_2', paymentId: 'pi_2' }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(2);
    expect(await stock()).toBe(6);
  });

  it('rejects one payment reused across concurrent sessions before a second inventory mutation', async () => {
    await recordPendingCheckout('lst_1', 'cs_2', { ...ownership, transactionId: 'tx_2' });
    const results = await Promise.allSettled([
      claimPaidCheckout(notification),
      claimPaidCheckout({ ...notification, sessionId: 'cs_2' }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({ reason: { code: 'PAYMENT_ID_CONFLICT' } });
    if (rejected?.status === 'rejected') expect(rejected.reason).toBeInstanceOf(FulfillmentRejected);
    expect(await stock()).toBe(8);
    const fulfilled = await db.select().from(checkouts);
    expect(fulfilled.filter((row) => row.fulfilledAt)).toHaveLength(1);
  });

  it('does not oversell when concurrent paid checkouts exhaust the remaining stock', async () => {
    await db.update(listings).set({ quantity: 2 }).where(eq(listings.id, 'lst_1'));
    await recordPendingCheckout('lst_1', 'cs_2', { ...ownership, transactionId: 'tx_2' });
    const results = await Promise.allSettled([
      claimPaidCheckout(notification),
      claimPaidCheckout({ ...notification, sessionId: 'cs_2', paymentId: 'pi_2' }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await stock()).toBe(0);
    expect((await db.select().from(checkouts)).filter((row) => row.fulfilledAt)).toHaveLength(1);
  });

  it('enforces payment uniqueness across different listings too', async () => {
    await claimPaidCheckout(notification);
    await db.insert(listings).values({ id: 'lst_2', sellerDid: ownership.sellerDid, title: 'Other', price: 5000, quantity: 10 });
    await recordPendingCheckout('lst_2', 'cs_2', { ...ownership, transactionId: 'tx_2' });
    await expect(claimPaidCheckout({
      ...notification, sessionId: 'cs_2', metadata: { ...notification.metadata, listingId: 'lst_2' },
    })).rejects.toMatchObject({ code: 'PAYMENT_ID_CONFLICT' });
    const [other] = await db.select().from(listings).where(eq(listings.id, 'lst_2'));
    expect(other.quantity).toBe(10);
    const [unclaimed] = await db.select().from(checkouts).where(eq(checkouts.sessionId, 'cs_2'));
    expect(unclaimed.paymentId).toBeNull();
    expect(unclaimed.fulfilledAt).toBeNull();
    // A different payment can safely retry the losing checkout.
    expect(await claimPaidCheckout({
      ...notification, sessionId: 'cs_2', paymentId: 'pi_2',
      metadata: { ...notification.metadata, listingId: 'lst_2' },
    })).not.toBeNull();
  });

  it('rolls the payment claim back when inventory fails, allowing a safe retry', async () => {
    await db.$client`ALTER TABLE market.listings ADD CONSTRAINT test_stock_failure CHECK (quantity = 10)`;
    try {
      await expect(claimPaidCheckout(notification)).rejects.toThrow();
      const [checkout] = await db.select().from(checkouts);
      expect(checkout.fulfilledAt).toBeNull();
      expect(checkout.paymentId).toBeNull();
      expect(await stock()).toBe(10);
    } finally {
      await db.$client`ALTER TABLE market.listings DROP CONSTRAINT test_stock_failure`;
    }
    expect(await claimPaidCheckout(notification)).not.toBeNull();
    expect(await stock()).toBe(8);
  });

  it('fulfills legacy lowercase listing and checkout currencies with a mixed-case notification', async () => {
    await db.update(listings).set({ currency: 'cad' }).where(eq(listings.id, 'lst_1'));
    await db.update(checkouts).set({ currency: 'cad' }).where(eq(checkouts.sessionId, 'cs_1'));
    expect(await claimPaidCheckout({
      ...notification, metadata: { ...notification.metadata, currency: 'cAd' },
    })).not.toBeNull();
    expect(await stock()).toBe(8);
  });

  it('does not trust a forged legacy pending checkout in seller-editable metadata', async () => {
    await db.update(listings).set({
      metadata: { pendingCheckouts: { cs_forged: { ...ownership, at: new Date().toISOString() } } },
    }).where(eq(listings.id, 'lst_1'));
    await expect(claimPaidCheckout({ ...notification, sessionId: 'cs_forged' })).rejects.toBeInstanceOf(FulfillmentRejected);
    expect(await stock()).toBe(10);
  });

  it('refuses underpayment, wrong seller and wrong currency without claiming the payment', async () => {
    for (const override of [
      { sellerDid: 'did:imajin:other' },
      { metadata: { ...notification.metadata, amount: 1 } },
      { metadata: { ...notification.metadata, currency: 'USD' } },
    ]) {
      await expect(claimPaidCheckout({ ...notification, ...override })).rejects.toBeInstanceOf(FulfillmentRejected);
    }
    expect(await stock()).toBe(10);
    const [checkout] = await db.select().from(checkouts);
    expect(checkout.fulfilledAt).toBeNull();
  });

  it('does not overwrite ownership on duplicate session or kernel transaction ids', async () => {
    await expect(recordPendingCheckout('lst_1', 'cs_1', { ...ownership, transactionId: 'tx_new' })).rejects.toThrow();
    await expect(recordPendingCheckout('lst_1', 'cs_new', ownership)).rejects.toThrow();
    expect(await db.select().from(checkouts)).toHaveLength(1);
  });

  it('runs the guarded checkout DDL repeatedly without losing checkout data or deduplication', async () => {
    await claimPaidCheckout(notification);
    const migration = readFileSync(`${migrationsFolder}/0001_checkout_ownership.sql`, 'utf8');
    await db.$client.unsafe(migration);
    await db.$client.unsafe(migration);
    await migrate(db, { migrationsFolder, migrationsSchema: 'market' });
    expect(await claimPaidCheckout(notification)).toBeNull();
    expect(await stock()).toBe(8);
  });
});
