import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbState, renderSql } from '../../../test/helpers/db-mock';

vi.mock('@/db', async () => (await import('../../../test/helpers/db-mock')).dbModule);

import { recordPendingCheckout, saveSettlementSnapshot } from '../pending-checkout';

const ENTRY = {
  transactionId: 'tx_abc', amountCents: 1000, chain: [],
  sellerDid: 'did:imajin:seller', buyerDid: '', quantity: 2, unitPrice: 500, currency: 'CAD',
};

beforeEach(() => dbState.reset());

describe('recordPendingCheckout', () => {
  it('inserts server-owned checkout data even without a payee chain', async () => {
    await recordPendingCheckout('lst_1', 'cs_1', ENTRY);
    expect(dbState.argsOf('values', 'insert')).toEqual([[{ listingId: 'lst_1', sessionId: 'cs_1', ...ENTRY }]]);
    expect(dbState.argsOf('onConflictDoUpdate')).toHaveLength(0);
    expect(dbState.argsOf('set', 'update')).toHaveLength(0);
  });

  it('propagates storage or duplicate ownership failures instead of exposing an unbound checkout', async () => {
    dbState.queue(new Error('duplicate session'));
    await expect(recordPendingCheckout('lst_1', 'cs_1', ENTRY)).rejects.toThrow('duplicate session');
  });
});

describe('saveSettlementSnapshot', () => {
  it('merges the receipt atomically and clears legacy pending metadata without deleting ledger deduplication', async () => {
    await saveSettlementSnapshot('lst_1', 'cs_1', { totalAmount: 10, chain: [] });
    const [values] = dbState.argsOf('set', 'update')[0] as [{ metadata: unknown }];
    const { sql, params } = renderSql(values.metadata);
    expect(sql).toContain("jsonb_build_object('fairSettlement'");
    expect(sql).toContain("#- array['pendingCheckouts'");
    expect(params).toContain('cs_1');
    expect(params).toContain(JSON.stringify({ totalAmount: 10, chain: [] }));
  });
});
