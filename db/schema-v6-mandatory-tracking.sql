BEGIN;

ALTER TABLE mandatory_sources ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;
ALTER TABLE mandatory_sources ADD COLUMN IF NOT EXISTS paused_at TIMESTAMPTZ;
UPDATE mandatory_sources
SET started_at = COALESCE(starts_at, created_at)
WHERE status = 'active' AND started_at IS NULL;

CREATE INDEX IF NOT EXISTS mandatory_sources_started_idx
  ON mandatory_sources(status, started_at);

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
CREATE INDEX IF NOT EXISTS mandatory_source_history_source_idx
  ON mandatory_source_history(source_id, id DESC);
CREATE INDEX IF NOT EXISTS mandatory_source_history_notifications_idx
  ON mandatory_source_history(id)
  WHERE event_type='started' AND notified_at IS NULL AND notify_admin_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS mandatory_source_reports (
  source_id BIGINT NOT NULL REFERENCES mandatory_sources(id) ON DELETE RESTRICT,
  channel_chat_id BIGINT NOT NULL,
  message_id BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (source_id, channel_chat_id)
);
CREATE INDEX IF NOT EXISTS mandatory_source_reports_channel_idx
  ON mandatory_source_reports(channel_chat_id, updated_at);

COMMIT;
