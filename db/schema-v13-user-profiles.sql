BEGIN;
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_photo_file_id TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS age INTEGER CHECK (age IS NULL OR age BETWEEN 15 AND 80);
ALTER TABLE users ADD COLUMN IF NOT EXISTS country_code TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS province_code TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS county_code TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_updated_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_viewed_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_gender_locked BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_initial_fields JSONB NOT NULL DEFAULT '{}'::jsonb;
CREATE TABLE IF NOT EXISTS profile_view_events (
  viewer_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  viewed_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  context TEXT NOT NULL DEFAULT 'chat',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (viewer_id, viewed_id, context, created_at)
);
CREATE INDEX IF NOT EXISTS profile_view_events_viewed_idx ON profile_view_events(viewed_id, created_at DESC);
INSERT INTO bot_settings(key,value) VALUES
 ('regular_profile_mode','optional'),('plus_profile_mode','optional'),('admin_profile_mode','optional'),('owner_profile_mode','optional'),
 ('profile_edit_cost','1'),('profile_view_button_label','مشاهده پروفایل'),('profile_viewed_notice','پروفایل شما دیده شد.'),
 ('profile_setup_title','پروفایل خودت را تکمیل کن'),('profile_setup_message','برای استفاده بهتر از ربات، اطلاعات پروفایلت را ثبت کن.'),
 ('profile_skip_label','فعلاً رد می‌کنم'),('profile_country_label','ایران'),('profile_name_prompt','نامت را بفرست.'),
 ('profile_photo_prompt','عکس پروفایلت را بفرست یا دکمه رد کردن را بزن.'),('profile_age_prompt','سنت را انتخاب کن.'),
 ('profile_province_prompt','استانت را انتخاب کن.'),('profile_county_prompt','شهرستانت را انتخاب کن.'),('profile_gender_prompt','جنسیتت را انتخاب کن؛ این گزینه بعداً قابل تغییر نیست.'),
 ('profile_saved_message','اطلاعات پروفایل ذخیره شد.')
ON CONFLICT (key) DO NOTHING;
COMMIT;
