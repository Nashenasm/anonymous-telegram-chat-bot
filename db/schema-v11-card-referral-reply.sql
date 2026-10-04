-- Card-to-card admin management, referral controls, and reply/media permissions.
CREATE TABLE IF NOT EXISTS payment_cards (
  id BIGSERIAL PRIMARY KEY,
  card_number TEXT NOT NULL DEFAULT '',
  title TEXT,
  admin_id BIGINT,
  admin_label TEXT NOT NULL,
  admin_username TEXT,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  button_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE payment_cards ADD COLUMN IF NOT EXISTS admin_username TEXT;
ALTER TABLE payment_cards ADD COLUMN IF NOT EXISTS button_enabled BOOLEAN NOT NULL DEFAULT TRUE;
INSERT INTO bot_settings(key, value) VALUES
  ('finance_card_text', 'متن واریز کارت به کارت تنظیم نشده است.'),
  ('referral_reward_coins', '5'),
  ('referral_conditions', '{"join":false,"connect":false,"time":false,"purchase":false,"plus":false,"referral":false}')
ON CONFLICT (key) DO NOTHING;
UPDATE bot_settings
SET value = jsonb_set(jsonb_set(value::jsonb, '{reply}', 'true'), '{timed_photo}', 'true')::text
WHERE key = 'chat_permissions' AND value IS NOT NULL;
