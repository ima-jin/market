import { pgSchema, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * This app owns exactly one Postgres schema, named by APP_DB_SCHEMA. It
 * never creates tables outside this schema and never reads/writes a kernel
 * schema or another app's schema — see docs/MIGRATIONS.md.
 */
const appSchemaName = process.env.APP_DB_SCHEMA;
if (!appSchemaName) {
  throw new Error('APP_DB_SCHEMA is not set — see .env.example and docs/MIGRATIONS.md.');
}

export const appSchema = pgSchema(appSchemaName);

/**
 * One example table — replace with your own domain tables. Every table this
 * app creates must live in `appSchema`, never in `public` or a kernel schema.
 */
export const examples = appSchema.table('examples', {
  id: uuid('id').primaryKey().defaultRandom(),
  label: text('label').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export type Example = typeof examples.$inferSelect;
export type NewExample = typeof examples.$inferInsert;
