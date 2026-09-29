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
CREATE TABLE IF NOT EXISTS gift_code_redemptions (
  code TEXT NOT NULL REFERENCES gift_codes(code) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  redeemed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (code, user_id)
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
 ('min_chat_duration','15S'), ('spam_consecutive_limit','3'), ('spam_delay','2S'), ('mid_chat_games_enabled','true'), ('mid_chat_ideas_enabled','true'), ('daily_coin_amount','20'), ('daily_coin_command','/daily'), ('daily_coin_reset','24H')
ON CONFLICT (key) DO NOTHING;
ALTER TABLE users ADD COLUMN IF NOT EXISTS banned_until TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS ban_reason TEXT;
