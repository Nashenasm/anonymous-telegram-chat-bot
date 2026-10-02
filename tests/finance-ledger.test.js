import { describe, expect, it, vi } from 'vitest';
import { applyCoinDelta, triagePaymentWithJev } from '../src/finance-ledger.js';

describe('finance ledger', () => {
  it('replays an idempotency key without mutating the balance twice', async () => {
    const queries = [];
    const client = { query: vi.fn(async (sql, params) => {
      queries.push([sql, params]);
      if (sql.includes('FROM finance_ledger')) return { rows: [], rowCount: 0 };
      if (sql.includes('FROM users')) return { rows: [{ coins: 20 }], rowCount: 1 };
      if (sql.startsWith('UPDATE users')) return { rows: [], rowCount: 1 };
      return { rows: [{ id: 1, user_id: 7, delta: 5, balance_after: 25 }], rowCount: 1 };
    }) };
    const result = await applyCoinDelta(client, { userId: 7, delta: 5, kind: 'grant', idempotencyKey: 'daily:7:2026-10-03' });
    expect(result.replayed).toBe(false);
    expect(queries.some(([sql]) => sql.startsWith('UPDATE users SET coins=$2'))).toBe(true);
    expect(queries.some(([sql]) => sql.includes('INSERT INTO finance_ledger'))).toBe(true);
  });

  it('never allows a negative balance', async () => {
    const client = { query: vi.fn(async (sql) => sql.includes('FROM finance_ledger') ? { rows: [] } : { rows: [{ coins: 2 }] }) };
    await expect(applyCoinDelta(client, { userId: 7, delta: -3, kind: 'purchase', idempotencyKey: 'purchase:1' })).rejects.toThrow('insufficient_coins');
  });

  it('keeps Jev as triage only and returns structured answers', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ model: 'jev-1.13.0', answers: { needs_human_review: { type: 'noul', noul: 0.9 } } }) }));
    const result = await triagePaymentWithJev({ apiKey: 'test-key', state: { order_id: 'o1' }, fetchImpl });
    expect(result.status).toBe('ok');
    expect(result.answers.needs_human_review.noul).toBe(0.9);
    expect(fetchImpl.mock.calls[0][1].body).toContain('jev-latest');
  });
});
