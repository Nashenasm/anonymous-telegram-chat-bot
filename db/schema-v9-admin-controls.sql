-- Additive migration v9: portable user-control and live-chat administration.
CREATE TABLE IF NOT EXISTS chat_metrics (
  user_id BIGINT PRIMARY KEY REFERENCES users(telegram_id) ON DELETE CASCADE,
  total_chat_seconds BIGINT NOT NULL DEFAULT 0,
  total_chats INTEGER NOT NULL DEFAULT 0,
  completed_chats INTEGER NOT NULL DEFAULT 0,
  total_messages BIGINT NOT NULL DEFAULT 0,
  longest_chat_seconds BIGINT NOT NULL DEFAULT 0,
  longest_chat_messages INTEGER NOT NULL DEFAULT 0,
  active_days INTEGER NOT NULL DEFAULT 0,
  last_active_day DATE,
  first_seen_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id BIGSERIAL PRIMARY KEY,
  admin_id BIGINT NOT NULL,
  target_user_id BIGINT,
  action TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS admin_audit_log_target_idx ON admin_audit_log(target_user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS gift_codes (
  code TEXT PRIMARY KEY,
  coins INTEGER NOT NULL DEFAULT 0 CHECK (coins >= 0),
  plus_days INTEGER NOT NULL DEFAULT 0 CHECK (plus_days >= 0),
  max_uses INTEGER,
  uses INTEGER NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ,
  created_by BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE gift_codes ADD COLUMN IF NOT EXISTS gift_type TEXT NOT NULL DEFAULT 'reward';
ALTER TABLE gift_codes ADD COLUMN IF NOT EXISTS discount_percent INTEGER NOT NULL DEFAULT 0;
ALTER TABLE gift_codes ADD COLUMN IF NOT EXISTS command_name TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS gift_codes_command_name_unique ON gift_codes(upper(command_name)) WHERE command_name IS NOT NULL;
CREATE TABLE IF NOT EXISTS gift_code_redemptions (
  code TEXT NOT NULL REFERENCES gift_codes(code) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  redeemed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (code, user_id)
);
CREATE TABLE IF NOT EXISTS contact_messages (
  id BIGSERIAL PRIMARY KEY,
  sender_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  recipient_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (sender_id <> recipient_id)
);
CREATE INDEX IF NOT EXISTS contact_messages_recipient_idx ON contact_messages(recipient_id, id DESC);
CREATE TABLE IF NOT EXISTS chat_gifts (
  id BIGSERIAL PRIMARY KEY,
  sender_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  recipient_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  gift_type TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS daily_coin_claims (
  user_id BIGINT PRIMARY KEY REFERENCES users(telegram_id) ON DELETE CASCADE,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS bot_games (
  id BIGSERIAL PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  paid BOOLEAN NOT NULL DEFAULT FALSE,
  coin_cost INTEGER NOT NULL DEFAULT 0 CHECK (coin_cost >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO bot_games(slug,name,prompt) VALUES ('truth-or-dare','حقیقت یا جرئت','انتخاب کن: حقیقت یا جرئت؟') ON CONFLICT (slug) DO NOTHING;
INSERT INTO bot_settings(key,value) VALUES
 ('chat_permissions','{"photo":true,"gif":true,"video":true,"text":true,"sticker":true,"emoji":true,"telegram_link":true,"mention":true,"english":true,"profanity":false,"voice":true,"music":true,"instagram_link":true,"website_link":true,"app":true,"file":true,"location":true,"contact":true}'),
 ('min_chat_duration','15S'), ('spam_consecutive_limit','3'), ('spam_delay','2S'), ('mid_chat_games_enabled','true'), ('mid_chat_ideas_enabled','true'), ('chat_cost_any','0'), ('chat_cost_male','0'), ('chat_cost_female','0'), ('daily_coin_amount','20'), ('daily_coin_command','/daily'), ('daily_coin_reset','24H')
ON CONFLICT (key) DO NOTHING;
ALTER TABLE users ADD COLUMN IF NOT EXISTS banned_until TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS ban_reason TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS discount_percent INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS discount_code TEXT;

-- Additive finance tables for wallet, price-source, card, gateway, order, and deposit management.
CREATE TABLE IF NOT EXISTS crypto_wallets (
  id BIGSERIAL PRIMARY KEY,
  asset TEXT NOT NULL CHECK (asset IN ('TRX','USDT_TRC20')),
  name TEXT NOT NULL,
  address TEXT NOT NULL,
  network TEXT NOT NULL DEFAULT 'TRON',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  monitor_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS crypto_price_sources (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  provider_type TEXT NOT NULL DEFAULT 'coingecko',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  priority INTEGER NOT NULL DEFAULT 100,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS fiat_price_sources (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  provider_type TEXT NOT NULL DEFAULT 'custom',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  priority INTEGER NOT NULL DEFAULT 100,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS payment_cards (
  id BIGSERIAL PRIMARY KEY,
  card_number TEXT NOT NULL,
  title TEXT,
  admin_id BIGINT,
  admin_label TEXT,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS payment_gateways (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  provider TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS coin_orders (
  id BIGSERIAL PRIMARY KEY,
  telegram_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  coins INTEGER NOT NULL CHECK (coins > 0),
  amount_toman BIGINT NOT NULL CHECK (amount_toman > 0),
  method TEXT NOT NULL CHECK (method IN ('gateway','card','crypto')),
  provider TEXT,
  asset TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','failed','cancelled')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  paid_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS crypto_deposits (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT REFERENCES coin_orders(id) ON DELETE SET NULL,
  telegram_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  wallet_id BIGINT REFERENCES crypto_wallets(id) ON DELETE SET NULL,
  asset TEXT NOT NULL CHECK (asset IN ('TRX','USDT_TRC20')),
  txid TEXT NOT NULL UNIQUE,
  from_address TEXT,
  to_address TEXT NOT NULL,
  amount NUMERIC(30,12) NOT NULL CHECK (amount > 0),
  confirmations INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'detected' CHECK (status IN ('detected','confirmed','credited','rejected')),
  raw JSONB NOT NULL DEFAULT '{}'::jsonb,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  credited_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS crypto_wallets_asset_enabled_idx ON crypto_wallets(asset, enabled, monitor_enabled);
CREATE INDEX IF NOT EXISTS crypto_deposits_status_idx ON crypto_deposits(status, detected_at DESC);
INSERT INTO crypto_price_sources(name,base_url,provider_type,priority)
VALUES ('CoinGecko','https://api.coingecko.com/api/v3','coingecko',10)
ON CONFLICT DO NOTHING;
INSERT INTO bot_settings(key,value) VALUES
 ('finance_enabled','false'), ('finance_coin_price','1000'), ('finance_card_enabled','false'),
 ('finance_card_button_name','کارت به کارت'), ('finance_card_admin_name','ارتباط با ادمین'),
 ('finance_fx_source','https://api.exchangerate.host/latest?base=USD&symbols=IRR')
ON CONFLICT (key) DO NOTHING;
