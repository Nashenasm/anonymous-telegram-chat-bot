-- Additive migration for the appearance editor and owner-only technical tools.
-- Safe to run on an existing database; runtime initialization also applies these keys.
INSERT INTO bot_settings(key, value) VALUES
  ('appearance_public_enabled', 'true'),
  ('appearance_private_enabled', 'true'),
  ('appearance_public', '{}'),
  ('appearance_private', '{}')
ON CONFLICT (key) DO NOTHING;
