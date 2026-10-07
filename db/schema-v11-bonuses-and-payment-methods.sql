BEGIN;

CREATE TABLE IF NOT EXISTS bonus_settings (
  bonus_key TEXT PRIMARY KEY,
  amount INTEGER NOT NULL DEFAULT 0 CHECK (amount >= 0),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS bonus_claims (
  id BIGSERIAL PRIMARY KEY,
  bonus_key TEXT NOT NULL,
  user_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  amount INTEGER NOT NULL CHECK (amount > 0),
  idempotency_key TEXT NOT NULL UNIQUE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (bonus_key, user_id)
);
CREATE INDEX IF NOT EXISTS bonus_claims_user_time_idx ON bonus_claims(user_id, created_at DESC);

INSERT INTO bonus_settings(bonus_key,amount,enabled) VALUES
  ('new_user',20,FALSE),
  ('first_purchase',0,FALSE),
  ('first_plus',0,FALSE),
  ('first_connection',0,FALSE),
  ('first_referral',0,FALSE)
ON CONFLICT (bonus_key) DO NOTHING;

INSERT INTO bot_settings(key,value) VALUES
  ('finance_crypto_text','برای واریز ارز دیجیتال، شبکه و آدرس کیف پول را از مدیریت دریافت کنید.'),
  ('finance_stars_text','پرداخت با Telegram Stars پس از انتخاب این روش و راهنمایی مدیریت انجام می‌شود.')
ON CONFLICT (key) DO NOTHING;

COMMIT;
