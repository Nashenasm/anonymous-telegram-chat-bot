import { describe, expect, it, vi } from 'vitest';
import { BONUS_DEFINITIONS, claimBonus } from '../src/bonus-service.js';

describe('bonus service', () => {
  it('defines exactly the five requested bonuses', () => {
    expect(Object.keys(BONUS_DEFINITIONS)).toEqual(['new_user', 'first_purchase', 'first_plus', 'first_connection', 'first_referral']);
  });

  it('claims an enabled bonus once and preserves idempotency', async () => {
    const queries = [];
    const client = { query: vi.fn(async (sql, params) => {
      queries.push([sql, params]);
      if (sql.includes('FROM bonus_settings')) return { rows: [{ amount: 15, enabled: true }] };
      if (sql.includes('INSERT INTO bonus_claims')) return { rows: [{ id: 1, amount: 15 }], rowCount: 1 };
      if (sql.includes('FROM finance_ledger')) return { rows: [], rowCount: 0 };
      if (sql.includes('FROM users')) return { rows: [{ coins: 20 }], rowCount: 1 };
      if (sql.startsWith('UPDATE users')) return { rows: [], rowCount: 1 };
      return { rows: [{ id: 1, user_id: 7, delta: 15, balance_after: 35 }], rowCount: 1 };
    }) };
    const result = await claimBonus(client, { bonusKey: 'first_connection', userId: 7 });
    expect(result.granted).toBe(true);
    expect(queries.some(([sql]) => sql.includes('INSERT INTO bonus_claims'))).toBe(true);
  });
});
