BEGIN;

CREATE TABLE IF NOT EXISTS finance_ledger (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  delta INTEGER NOT NULL CHECK (delta <> 0),
  balance_before INTEGER NOT NULL CHECK (balance_before >= 0),
  balance_after INTEGER NOT NULL CHECK (balance_after >= 0),
  kind TEXT NOT NULL CHECK (kind IN ('opening_balance','grant','gift','daily','referral','chat_cost','purchase','admin','refund')),
  idempotency_key TEXT NOT NULL UNIQUE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS finance_ledger_user_time_idx ON finance_ledger(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS finance_ledger_kind_time_idx ON finance_ledger(kind, created_at DESC);

CREATE TABLE IF NOT EXISTS payment_orders (
  order_id TEXT PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  product TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  currency TEXT NOT NULL DEFAULT 'coin',
  provider TEXT NOT NULL DEFAULT 'disabled',
  provider_reference TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','failed','cancelled','review')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  paid_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS payment_orders_user_time_idx ON payment_orders(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS payment_orders_status_time_idx ON payment_orders(status, created_at DESC);

CREATE TABLE IF NOT EXISTS finance_review_queue (
  id BIGSERIAL PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES payment_orders(order_id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  jev_result JSONB,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','approved','rejected')),
  reviewed_by BIGINT REFERENCES users(telegram_id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS finance_review_queue_status_idx ON finance_review_queue(status, created_at);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='finance_ledger_kind_check') THEN
    ALTER TABLE finance_ledger ADD CONSTRAINT finance_ledger_kind_check CHECK (kind IN ('opening_balance','grant','gift','daily','referral','chat_cost','purchase','admin','refund'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='payment_orders_status_check') THEN
    ALTER TABLE payment_orders ADD CONSTRAINT payment_orders_status_check CHECK (status IN ('pending','paid','failed','cancelled','review'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='finance_review_queue_status_check') THEN
    ALTER TABLE finance_review_queue ADD CONSTRAINT finance_review_queue_status_check CHECK (status IN ('open','approved','rejected'));
  END IF;
END $$;

INSERT INTO bot_settings(key,value) VALUES
  ('finance_enabled','false'),
  ('finance_coin_price',''),
  ('finance_gateways',''),
  ('finance_wallets',''),
  ('finance_cards','')
ON CONFLICT (key) DO NOTHING;

INSERT INTO finance_ledger(user_id, delta, balance_before, balance_after, kind, idempotency_key, metadata)
SELECT u.telegram_id, u.coins, 0, u.coins, 'opening_balance', 'opening-balance:' || u.telegram_id,
       jsonb_build_object('source','pre_ledger_users_coins','migrated_at',NOW())
FROM users u
WHERE u.coins > 0
  AND NOT EXISTS (SELECT 1 FROM finance_ledger l WHERE l.idempotency_key='opening-balance:' || u.telegram_id);

COMMIT;
