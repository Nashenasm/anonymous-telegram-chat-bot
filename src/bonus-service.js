import { applyCoinDelta } from './finance-ledger.js';

export const BONUS_DEFINITIONS = Object.freeze({
  new_user: { title: 'بونوس کاربر جدید', description: 'پاداش اولین ورود کاربر به ربات.', defaultAmount: 20 },
  first_purchase: { title: 'بونوس اولین خرید', description: 'پاداش اولین خرید مانوکوین یا محصول مالی.', defaultAmount: 0 },
  first_plus: { title: 'بونوس اولین مانوپلاس', description: 'پاداش اولین خرید مانوپلاس.', defaultAmount: 0 },
  first_connection: { title: 'بونوس اولین اتصال', description: 'پاداش اولین اتصال موفق به یک هم‌صحبت.', defaultAmount: 0 },
  first_referral: { title: 'بونوس اولین زیرمجموعه', description: 'پاداش اولین کاربر معرفی‌شده توسط هر معرف.', defaultAmount: 0 },
});

export const BONUS_KEYS = Object.freeze(Object.keys(BONUS_DEFINITIONS));

export async function ensureBonusDefaults(client) {
  await client.query(`CREATE TABLE IF NOT EXISTS bonus_settings (
    bonus_key TEXT PRIMARY KEY,
    amount INTEGER NOT NULL DEFAULT 0 CHECK (amount >= 0),
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await client.query(`CREATE TABLE IF NOT EXISTS bonus_claims (
    id BIGSERIAL PRIMARY KEY,
    bonus_key TEXT NOT NULL,
    user_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
    amount INTEGER NOT NULL CHECK (amount > 0),
    idempotency_key TEXT NOT NULL UNIQUE,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (bonus_key, user_id)
  )`);
  await client.query('CREATE INDEX IF NOT EXISTS bonus_claims_user_time_idx ON bonus_claims(user_id, created_at DESC)');
  for (const [bonusKey, definition] of Object.entries(BONUS_DEFINITIONS)) {
    await client.query(
      'INSERT INTO bonus_settings(bonus_key,amount,enabled) VALUES ($1,$2,FALSE) ON CONFLICT (bonus_key) DO NOTHING',
      [bonusKey, definition.defaultAmount],
    );
  }
}

export async function bonusRows(client) {
  await ensureBonusDefaults(client);
  const result = await client.query('SELECT bonus_key, amount, enabled, updated_at FROM bonus_settings ORDER BY bonus_key');
  return result.rows.map(row => ({ ...row, ...BONUS_DEFINITIONS[row.bonus_key] }));
}

export async function bonusRow(client, bonusKey) {
  if (!BONUS_DEFINITIONS[bonusKey]) return null;
  await ensureBonusDefaults(client);
  const result = await client.query('SELECT bonus_key, amount, enabled, updated_at FROM bonus_settings WHERE bonus_key=$1', [bonusKey]);
  return result.rows[0] ? { ...result.rows[0], ...BONUS_DEFINITIONS[bonusKey] } : null;
}

export async function claimBonus(client, { bonusKey, userId, metadata = {} }) {
  if (!BONUS_DEFINITIONS[bonusKey]) throw new Error('invalid_bonus_key');
  await ensureBonusDefaults(client);
  const setting = await client.query('SELECT amount, enabled FROM bonus_settings WHERE bonus_key=$1', [bonusKey]);
  const row = setting.rows[0];
  if (!row?.enabled || Number(row.amount) <= 0) return { granted: false, reason: 'disabled' };
  const idempotencyKey = `bonus:${bonusKey}:${userId}`;
  const claim = await client.query(
    `INSERT INTO bonus_claims(bonus_key,user_id,amount,idempotency_key,metadata)
     VALUES ($1,$2,$3,$4,$5::jsonb)
     ON CONFLICT (bonus_key,user_id) DO NOTHING RETURNING id,amount`,
    [bonusKey, userId, Number(row.amount), idempotencyKey, JSON.stringify(metadata)],
  );
  if (!claim.rowCount) return { granted: false, reason: 'already_claimed' };
  const entry = await applyCoinDelta(client, {
    userId,
    delta: Number(row.amount),
    kind: 'grant',
    idempotencyKey,
    metadata: { bonusKey, ...metadata },
  });
  return { granted: true, amount: Number(row.amount), entry };
}
