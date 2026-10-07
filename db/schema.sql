CREATE TABLE IF NOT EXISTS users (
  telegram_id BIGINT PRIMARY KEY,
  username TEXT,
  status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle','waiting','chatting')),
  gender TEXT NULL CHECK (gender IN ('male','female')),
  coins INTEGER NOT NULL DEFAULT 20 CHECK (coins >= 0),
  discount_percent INTEGER NOT NULL DEFAULT 0,
  discount_code TEXT,
  plus_expires_at TIMESTAMPTZ NULL,
  plus_emoji TEXT NOT NULL DEFAULT '✨',
  role TEXT NOT NULL DEFAULT 'user',
  referral_code TEXT UNIQUE,
  referred_by BIGINT NULL REFERENCES users(telegram_id) ON DELETE SET NULL,
  start_completed BOOLEAN NOT NULL DEFAULT FALSE,
  match_preference TEXT NULL CHECK (match_preference IN ('male','female','any')),
  partner_id BIGINT NULL,
  last_partner_id BIGINT NULL,
  blocked_ids BIGINT[] NOT NULL DEFAULT '{}',
  action_state TEXT NULL,
  conversation_started_at TIMESTAMPTZ NULL,
  last_action_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS gender TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS discount_percent INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS discount_code TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS coins INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS match_preference TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_partner_id BIGINT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS action_state TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS conversation_started_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_action_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS users_waiting_idx ON users(status, updated_at) WHERE status = 'waiting';

CREATE TABLE IF NOT EXISTS processed_updates (
  update_id BIGINT PRIMARY KEY,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS processed_updates_time_idx ON processed_updates(processed_at);

CREATE TABLE IF NOT EXISTS bot_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO bot_settings(key, value) VALUES
  ('connect_button', 'وصل کن به ناشناس'),
  ('cancel_button', 'انصراف'),
  ('disconnect_button', 'قطع مکالمه'),
  ('profile_button', 'پروفایل من'),
  ('back_button', 'بازگشت'),
  ('welcome_message', 'به چت ناشناس خوش آمدی.'),
  ('connected_message', 'وصل شدی؛ سلام کن و گفت‌وگو را شروع کن.'),
  ('mandatory_join_message', 'برای استفاده از ربات، ابتدا در منابع اجباری عضو شو. با دکمه‌های عضویت وارد شو و سپس «بررسی عضویت» را بزن.'),
  ('mandatory_join_button_label', 'عضویت در منبع'),
  ('mandatory_verify_button_label', 'بررسی عضویت'),
  ('mandatory_join_button_layout', 'single'),
  ('mandatory_join_show_source_tags', 'true'),
  ('mid_chat_ad_enabled', 'false'),
  ('mid_chat_ad_minutes', '15'),
  ('appearance_public_enabled', 'true'),
  ('appearance_private_enabled', 'true'),
  ('appearance_public', '{}'),
  ('appearance_private', '{}'),
  ('bot_enabled', 'true')
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS reports (
  id BIGSERIAL PRIMARY KEY,
  reporter_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  target_id BIGINT NULL REFERENCES users(telegram_id) ON DELETE SET NULL,
  reason VARCHAR(200) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'open',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT reports_status_check CHECK (status IN ('open', 'reviewing', 'resolved', 'dismissed'))
);
CREATE INDEX IF NOT EXISTS reports_status_idx ON reports(status, created_at);

CREATE TABLE IF NOT EXISTS anon_links (
  token_hash BYTEA PRIMARY KEY,
  telegram_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NULL,
  revoked_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_anon_links_one_active
  ON anon_links(telegram_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_anon_links_expiry ON anon_links(expires_at);

-- Multi-link anonymous inbox migration. Existing links remain usable and receive a default name.
ALTER TABLE anon_links ADD COLUMN IF NOT EXISTS link_name TEXT;
ALTER TABLE anon_links ADD COLUMN IF NOT EXISTS token_value TEXT;
ALTER TABLE anon_links ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE anon_links ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;
UPDATE anon_links SET link_name = COALESCE(link_name, 'لینک اصلی'), status = CASE WHEN revoked_at IS NULL THEN 'active' ELSE 'revoked' END WHERE link_name IS NULL OR status IS NULL;
ALTER TABLE anon_links DROP CONSTRAINT IF EXISTS anon_links_status_check;
ALTER TABLE anon_links ADD CONSTRAINT anon_links_status_check CHECK (status IN ('active','closed','revoked'));
DROP INDEX IF EXISTS uq_anon_links_one_active;
CREATE INDEX IF NOT EXISTS idx_anon_links_user_status ON anon_links(telegram_id,status,created_at);

CREATE TABLE IF NOT EXISTS anonymous_inbox_messages (
  id BIGSERIAL PRIMARY KEY,
  sender_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  recipient_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  link_hash BYTEA NOT NULL REFERENCES anon_links(token_hash) ON DELETE CASCADE,
  body TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('incoming','outgoing')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','replied','blocked')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  responded_at TIMESTAMPTZ,
  CHECK (sender_id <> recipient_id)
);
CREATE INDEX IF NOT EXISTS anonymous_inbox_recipient_idx ON anonymous_inbox_messages(recipient_id,direction,status,id DESC);
CREATE INDEX IF NOT EXISTS anonymous_inbox_sender_idx ON anonymous_inbox_messages(sender_id,direction,status,id DESC);

CREATE TABLE IF NOT EXISTS anonymous_pair_permissions (
  sender_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  recipient_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (sender_id, recipient_id),
  CHECK (sender_id <> recipient_id)
);

CREATE TABLE IF NOT EXISTS anonymous_pending_messages (
  id BIGSERIAL PRIMARY KEY,
  sender_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  recipient_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  message_body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (recipient_id),
  CHECK (sender_id <> recipient_id)
);
CREATE INDEX IF NOT EXISTS idx_anonymous_pending_messages_sender
  ON anonymous_pending_messages(sender_id);

CREATE TABLE IF NOT EXISTS anonymous_blocks (
  user_low BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  user_high BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),
  blocker_id BIGINT REFERENCES users(telegram_id) ON DELETE CASCADE,
  PRIMARY KEY (user_low, user_high),
  CHECK (user_low < user_high)
);
ALTER TABLE anonymous_blocks ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE anonymous_blocks ADD COLUMN IF NOT EXISTS blocker_id BIGINT REFERENCES users(telegram_id) ON DELETE CASCADE;
UPDATE anonymous_blocks SET expires_at = created_at + INTERVAL '7 days' WHERE expires_at IS NULL;
ALTER TABLE anonymous_blocks ALTER COLUMN expires_at SET DEFAULT (NOW() + INTERVAL '7 days');
ALTER TABLE anonymous_blocks ALTER COLUMN expires_at SET NOT NULL;

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

-- Optional cleanup job: DELETE FROM processed_updates WHERE processed_at < NOW() - INTERVAL '14 days';

CREATE TABLE IF NOT EXISTS plus_purchases (id BIGSERIAL PRIMARY KEY, telegram_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE, months INTEGER NOT NULL CHECK (months IN (1,3,6,12)), price INTEGER NOT NULL CHECK (price IN (100,250,450,800)), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE INDEX IF NOT EXISTS users_plus_expiry_idx ON users(plus_expires_at);
BEGIN;

CREATE TABLE IF NOT EXISTS mandatory_sources (
  id BIGSERIAL PRIMARY KEY,
  tracking_code TEXT NOT NULL UNIQUE,
  source_type TEXT NOT NULL CHECK (source_type IN ('channel','group','bot','web_app','website')),
  visibility TEXT CHECK (visibility IN ('private','public')),
  title TEXT NOT NULL,
  target TEXT NOT NULL,
  join_url TEXT,
  mode TEXT NOT NULL CHECK (mode IN ('time','count','start','click')),
  quota INTEGER,
  duration_seconds INTEGER,
  audience JSONB NOT NULL DEFAULT '{"regular_female":true,"regular_male":true,"plus_female":true,"plus_male":true}'::jsonb,
  starts_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  paused_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('scheduled','active','paused','completed','failed','cancelled')),
  created_by BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((mode IN ('count','start','click') AND quota IS NOT NULL AND quota > 0) OR (mode = 'time' AND duration_seconds IS NOT NULL AND duration_seconds > 0))
);
CREATE INDEX IF NOT EXISTS mandatory_sources_active_idx ON mandatory_sources(status, starts_at);

CREATE TABLE IF NOT EXISTS mandatory_source_events (
  source_id BIGINT NOT NULL REFERENCES mandatory_sources(id) ON DELETE CASCADE,
  telegram_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN ('join','start','click')),
  confirmed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (source_id, telegram_id)
);

CREATE TABLE IF NOT EXISTS mandatory_source_queue (
  id BIGSERIAL PRIMARY KEY,
  source_id BIGINT NOT NULL REFERENCES mandatory_sources(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  queued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_id),
  UNIQUE (position)
);

CREATE INDEX IF NOT EXISTS mandatory_sources_started_idx ON mandatory_sources(status, started_at);
CREATE TABLE IF NOT EXISTS mandatory_source_history (
  id BIGSERIAL PRIMARY KEY,
  source_id BIGINT NOT NULL REFERENCES mandatory_sources(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  notify_admin_id BIGINT REFERENCES users(telegram_id) ON DELETE SET NULL,
  notification_attempts INTEGER NOT NULL DEFAULT 0,
  last_notification_error TEXT,
  notified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS mandatory_source_history_source_idx ON mandatory_source_history(source_id, id DESC);
CREATE INDEX IF NOT EXISTS mandatory_source_history_notifications_idx ON mandatory_source_history(id) WHERE event_type='started' AND notified_at IS NULL AND notify_admin_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS mandatory_source_reports (
  source_id BIGINT NOT NULL REFERENCES mandatory_sources(id) ON DELETE RESTRICT,
  channel_chat_id BIGINT NOT NULL,
  message_id BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (source_id, channel_chat_id)
);
CREATE INDEX IF NOT EXISTS mandatory_source_reports_channel_idx ON mandatory_source_reports(channel_chat_id, updated_at);

COMMIT;
