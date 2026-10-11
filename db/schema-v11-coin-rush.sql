-- Additive migration v11: competitive Coin Rush rooms.
CREATE TABLE IF NOT EXISTS coin_rush_sessions (
  room_id TEXT PRIMARY KEY,
  access_token TEXT NOT NULL,
  player_one BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  player_two BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  ready_one BOOLEAN NOT NULL DEFAULT FALSE,
  ready_two BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'waiting' CHECK(status IN ('waiting','active','finished','cancelled')),
  start_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  score_one INTEGER NOT NULL DEFAULT 0,
  score_two INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK(player_one <> player_two)
);
CREATE INDEX IF NOT EXISTS coin_rush_player_idx ON coin_rush_sessions(player_one, player_two, status, created_at DESC);
