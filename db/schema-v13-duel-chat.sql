-- Telegram-like message controls for multiplayer duel-room chat.
ALTER TABLE duel_game_messages
  ADD COLUMN IF NOT EXISTS reply_to_id BIGINT REFERENCES duel_game_messages(id) ON DELETE SET NULL;
ALTER TABLE duel_game_messages ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;
ALTER TABLE duel_game_messages ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS duel_game_message_reactions (
  message_id BIGINT NOT NULL REFERENCES duel_game_messages(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  emoji TEXT NOT NULL CHECK (char_length(emoji) <= 16),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (message_id, user_id)
);

CREATE INDEX IF NOT EXISTS duel_game_message_reactions_message_idx
  ON duel_game_message_reactions(message_id);
