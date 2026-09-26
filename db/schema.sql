CREATE TABLE IF NOT EXISTS users (
  telegram_id BIGINT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle','waiting','chatting')),
  gender TEXT NULL CHECK (gender IN ('male','female')),
  coins INTEGER NOT NULL DEFAULT 0 CHECK (coins >= 0),
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
  ('mid_chat_ad_enabled', 'false'),
  ('mid_chat_ad_minutes', '15'),
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
  PRIMARY KEY (user_low, user_high),
  CHECK (user_low < user_high)
);
ALTER TABLE anonymous_blocks ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
UPDATE anonymous_blocks SET expires_at = created_at + INTERVAL '7 days' WHERE expires_at IS NULL;
ALTER TABLE anonymous_blocks ALTER COLUMN expires_at SET DEFAULT (NOW() + INTERVAL '7 days');
ALTER TABLE anonymous_blocks ALTER COLUMN expires_at SET NOT NULL;

-- Optional cleanup job: DELETE FROM processed_updates WHERE processed_at < NOW() - INTERVAL '14 days';
