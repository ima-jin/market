import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';
import { getServerConfig } from '../lib/self-secrets';

type Database = ReturnType<typeof drizzle<typeof schema>>;
const DATABASE_KEY = Symbol.for('imajin.market.database');
const store = globalThis as { [DATABASE_KEY]?: Database };

/** Only the delayed server initializer may construct the client. Never read env. */
export function initializeDatabase(): void {
  const { DATABASE_URL } = getServerConfig();
  store[DATABASE_KEY] ??= drizzle(postgres(DATABASE_URL, { max: 1 }), { schema });
}

function getDatabase(): Database {
  // Even a previously initialized client is inaccessible after failed boot.
  getServerConfig();
  const database = store[DATABASE_KEY];
  if (!database) throw new Error('Database unavailable before vault boot.');
  return database;
}

// Next imports route modules during build and in unclaimed mode. Importing this
// facade is inert: neither constructs a client nor needs a credential.
export const db = new Proxy({} as Database, {
  get(_target, property) {
    const database = getDatabase();
    const value = Reflect.get(database, property, database);
    return typeof value === 'function' ? value.bind(database) : value;
  },
});
export * from './schema';
