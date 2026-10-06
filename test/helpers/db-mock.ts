import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import * as schema from '../../src/db/schema';

/**
 * A minimal stand-in for the drizzle `db` handle used by route tests.
 *
 * Every `db.select()/insert()/update()` call consumes the next queued result
 * (in call order) and returns a chain whose builder methods
 * (`from/where/orderBy/limit/offset/set/values/returning/onConflictDoUpdate`)
 * all return the same chain. The chain is itself a real Promise, so it can
 * be awaited at any point (e.g. after `.where()` or after `.returning()`).
 * Every builder call is recorded in `calls` so tests can assert on the query
 * a route built, including the rendered SQL of its `where` conditions.
 */

const CHAIN_METHODS = [
  'from',
  'where',
  'orderBy',
  'limit',
  'offset',
  'set',
  'values',
  'returning',
  'onConflictDoUpdate',
] as const;

export interface RecordedCall {
  op: 'select' | 'insert' | 'update';
  method: string;
  args: unknown[];
}

type Chain = Promise<unknown> & Record<(typeof CHAIN_METHODS)[number], (...args: unknown[]) => Chain>;

const results: unknown[] = [];
const calls: RecordedCall[] = [];

function makeChain(op: RecordedCall['op']): Chain {
  const next = results.shift();
  const promise = next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  const chain = promise as Chain;
  for (const method of CHAIN_METHODS) {
    chain[method] = (...args: unknown[]) => {
      calls.push({ op, method, args });
      return chain;
    };
  }
  return chain;
}

export const mockDb = {
  select: () => makeChain('select'),
  insert: () => makeChain('insert'),
  update: () => makeChain('update'),
};

export const dbState = {
  /** Queue the results of the next db operations, in call order. A queued Error rejects. */
  queue(...next: unknown[]) {
    results.push(...next);
  },
  reset() {
    results.length = 0;
    calls.length = 0;
  },
  calls,
  /** Arguments of every recorded call to `method` (optionally narrowed to one `op`). */
  argsOf(method: string, op?: RecordedCall['op']): unknown[][] {
    return calls.filter((c) => c.method === method && (!op || c.op === op)).map((c) => c.args);
  },
  /** Number of db.select/insert/update chains that were created but whose queued result is still unused. */
  pending(): number {
    return results.length;
  },
};

/** Module shape for `vi.mock('@/db', ...)`: real schema + the mock handle. */
export const dbModule = { ...schema, db: mockDb };

const dialect = new PgDialect();

/** Renders a drizzle SQL condition to `{ sql, params }` for assertions. */
export function renderSql(condition: unknown) {
  const { sql, params } = dialect.sqlToQuery(condition as SQL);
  return { sql, params };
}
