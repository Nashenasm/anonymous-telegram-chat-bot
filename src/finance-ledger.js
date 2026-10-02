import crypto from 'node:crypto';

export const FINANCE_LEDGER_KINDS = Object.freeze({
  grant: 'grant',
  gift: 'gift',
  daily: 'daily',
  referral: 'referral',
  chat_cost: 'chat_cost',
  purchase: 'purchase',
  admin: 'admin',
  refund: 'refund',
});

export function newFinanceIdempotencyKey(prefix = 'finance') {
  return `${prefix}:${crypto.randomUUID()}`;
}

/**
 * Must be called inside a transaction. The ledger is authoritative for every
 * coin mutation; users.coins is kept as a fast read model and is locked first.
 */
export async function applyCoinDelta(client, { userId, delta, kind, idempotencyKey, metadata = {} }) {
  const amount = Number(delta);
  if (!Number.isInteger(amount) || amount === 0) throw new Error('invalid_coin_delta');
  if (!userId || !kind || !idempotencyKey) throw new Error('invalid_finance_entry');

  const existing = await client.query(
    'SELECT id, user_id, delta, balance_after FROM finance_ledger WHERE idempotency_key=$1',
    [idempotencyKey],
  );
  if (existing.rows[0]) return { ...existing.rows[0], replayed: true };

  const locked = await client.query('SELECT coins FROM users WHERE telegram_id=$1 FOR UPDATE', [userId]);
  if (!locked.rows[0]) throw new Error('finance_user_missing');
  const before = Number(locked.rows[0].coins || 0);
  const after = before + amount;
  if (after < 0) throw new Error('insufficient_coins');

  await client.query('UPDATE users SET coins=$2, updated_at=NOW() WHERE telegram_id=$1', [userId, after]);
  try {
    const inserted = await client.query(
      `INSERT INTO finance_ledger(user_id, delta, balance_before, balance_after, kind, idempotency_key, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
       RETURNING id,user_id,delta,balance_after`,
      [userId, amount, before, after, kind, idempotencyKey, JSON.stringify(metadata)],
    );
    return { ...inserted.rows[0], replayed: false };
  } catch (error) {
    if (error.code !== '23505') throw error;
    const replay = await client.query(
      'SELECT id,user_id,delta,balance_after FROM finance_ledger WHERE idempotency_key=$1',
      [idempotencyKey],
    );
    return { ...replay.rows[0], replayed: true };
  }
}

export async function createPaymentOrder(client, { userId, product, amount, currency = 'coin', provider = 'disabled', metadata = {} }) {
  const orderId = `ord_${crypto.randomUUID().replaceAll('-', '')}`;
  const result = await client.query(
    `INSERT INTO payment_orders(order_id,user_id,product,amount,currency,provider,status,metadata)
     VALUES ($1,$2,$3,$4,$5,$6,'pending',$7::jsonb) RETURNING *`,
    [orderId, userId, product, amount, currency, provider, JSON.stringify(metadata)],
  );
  return result.rows[0];
}

export async function triagePaymentWithJev({ state, apiKey = process.env.TYPESAFE_API_KEY, fetchImpl = fetch }) {
  if (!apiKey) return { status: 'unavailable', reason: 'TYPESAFE_API_KEY_missing' };
  const response = await fetchImpl('https://api.typesafe.ai/v1/systemone', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'jev-latest', state,
      questions: {
        needs_human_review: { type: 'noul', instructions: 'Does this payment evidence require human review before any deterministic provider verification can continue?', criteria: { true: 'Ambiguous, incomplete, conflicting, or suspicious evidence', false: 'Complete and internally consistent evidence' } },
        risk: { type: 'score', instructions: 'Rate operational risk for this payment evidence; this is triage only and must never authorize a credit.', criteria: ['low', 'medium', 'high', 'critical'] },
      },
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`typesafe_http_${response.status}`);
  const result = await response.json();
  return { status: 'ok', model: result.model, answers: result.answers, usage: result.usage };
}
