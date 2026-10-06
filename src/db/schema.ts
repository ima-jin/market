import { boolean, index, integer, jsonb, pgSchema, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * This app owns exactly one Postgres schema, named by APP_DB_SCHEMA (`market`
 * for this app). It never creates tables outside this schema and never
 * reads/writes a kernel schema or another app's schema — see
 * docs/MIGRATIONS.md.
 */
const appSchemaName = process.env.APP_DB_SCHEMA;
if (!appSchemaName) {
  throw new Error('APP_DB_SCHEMA is not set — see .env.example and docs/MIGRATIONS.md.');
}

export const appSchema = pgSchema(appSchemaName);

/**
 * Market listings — items and services for sale.
 */
export const listings = appSchema.table(
  'listings',
  {
    id: text('id').primaryKey(), // lst_xxx
    sellerDid: text('seller_did').notNull(), // Seller DID
    title: text('title').notNull(),
    description: text('description'),
    price: integer('price').notNull(), // smallest currency unit
    currency: text('currency').default('CAD'), // ISO 4217
    category: text('category'), // freeform
    images: jsonb('images').default([]), // legacy: URL strings
    imageAssetIds: jsonb('image_asset_ids').default([]), // asset_xxx IDs (max 8)
    quantity: integer('quantity').default(1), // null = unlimited/service
    type: text('type').notNull().default('sale'), // sale | rental
    status: text('status').default('active'), // active | paused | sold | rented | unavailable | removed
    sellerTier: text('seller_tier').notNull().default('public_offplatform'), // public_offplatform | public_onplatform | trust_gated
    showContactInfo: boolean('show_contact_info').default(false),
    expiresAt: timestamp('expires_at', { withTimezone: true }), // optional listing expiry
    contactInfo: jsonb('contact_info'), // required for tier 1: { phone, email, whatsapp }
    trustThreshold: jsonb('trust_threshold'), // trust-gated tier (phase 2)
    rangeKm: integer('range_km').default(50), // discovery radius in km
    metadata: jsonb('metadata').default({}), // tags, condition, etc.
    fairManifest: jsonb('fair_manifest'), // .fair attribution for the sale
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index('idx_market_listings_seller_did').on(table.sellerDid),
    index('idx_market_listings_category_status').on(table.category, table.status),
    index('idx_market_listings_status_created').on(table.status, table.createdAt),
  ],
);

/**
 * Market disputes — phase 2 dispute resolution.
 */
export const disputes = appSchema.table('disputes', {
  id: text('id').primaryKey(),
  listingId: text('listing_id')
    .references(() => listings.id)
    .notNull(),
  transactionId: text('transaction_id').notNull(),
  buyerDid: text('buyer_did').notNull(),
  sellerDid: text('seller_did').notNull(),
  type: text('type').notNull(), // chargeback | not_received | not_as_described
  status: text('status').notNull().default('open'), // open | evidence | resolved
  resolution: text('resolution'), // buyer_favor | seller_favor | split | inconclusive
  buyerEvidence: jsonb('buyer_evidence').default([]),
  sellerEvidence: jsonb('seller_evidence').default([]),
  evidenceDeadline: timestamp('evidence_deadline', { withTimezone: true }),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

/**
 * Seller settings — profile integration preferences.
 */
export const sellerSettings = appSchema.table('seller_settings', {
  did: text('did').primaryKey(),
  showMarketItems: boolean('show_market_items').default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

export type Listing = typeof listings.$inferSelect;
export type NewListing = typeof listings.$inferInsert;
export type Dispute = typeof disputes.$inferSelect;
export type NewDispute = typeof disputes.$inferInsert;
export type SellerSettings = typeof sellerSettings.$inferSelect;
export type NewSellerSettings = typeof sellerSettings.$inferInsert;
