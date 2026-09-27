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
  starts_at TIMESTAMPTZ,
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

COMMIT;
