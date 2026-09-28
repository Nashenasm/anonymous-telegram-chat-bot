BEGIN;

ALTER TABLE mandatory_sources
  ADD COLUMN IF NOT EXISTS audience JSONB NOT NULL
  DEFAULT '{"regular_female":true,"regular_male":true,"plus_female":true,"plus_male":true}'::jsonb;

INSERT INTO bot_settings(key, value) VALUES
  ('mandatory_join_message', 'برای استفاده از ربات، ابتدا در منابع اجباری عضو شو. با دکمه‌های عضویت وارد شو و سپس «بررسی عضویت» را بزن.'),
  ('mandatory_join_button_label', 'عضویت در منبع'),
  ('mandatory_verify_button_label', 'بررسی عضویت'),
  ('mandatory_join_button_layout', 'single'),
  ('mandatory_join_show_source_tags', 'true')
ON CONFLICT (key) DO NOTHING;

COMMIT;
