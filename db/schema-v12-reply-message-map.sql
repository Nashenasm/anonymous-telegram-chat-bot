-- Preserve Telegram message relationships across the two private chats.
-- A reply in the recipient chat must be translated back to the original
-- message ID in the sender's chat before forwarding it.
CREATE TABLE IF NOT EXISTS chat_reply_message_map (
  sender_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  sender_message_id BIGINT NOT NULL,
  recipient_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  recipient_message_id BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (sender_id, sender_message_id, recipient_id),
  UNIQUE (recipient_id, recipient_message_id)
);
CREATE INDEX IF NOT EXISTS chat_reply_message_map_recipient_idx
  ON chat_reply_message_map(recipient_id, recipient_message_id);
