import { Pool } from 'pg';
import crypto from 'node:crypto';
import dns from 'node:dns';

dns.setDefaultResultOrder('ipv4first');
import fs from 'node:fs/promises';
import { createAnonymousFlow } from '../src/anonymous-flow.js';
import { decodeTrackingCode, formatMandatorySourceDetails, getMandatorySourceDetails, getMandatorySourceHistory, mandatorySourceKeyboard, mandatoryTrackingListKeyboard, parseTrackingCommand, processMandatoryLifecycle, recordMandatorySourceHistory, syncMandatoryReport, trackingCommand } from '../src/mandatory-service.js';
import { DEFAULT_MANDATORY_AUDIENCE, mandatoryAudienceIncludesUser, mandatoryAudienceLabels, mandatoryAudienceReviewKeyboard, mandatoryAudienceSelectionKeyboard, normalizeMandatoryAudience, toggleMandatoryAudience } from '../src/mandatory-audience.js';
import { encryptMandatoryTrackingUserId } from '../src/mandatory-tracking-token.js';
import { APPEARANCE_SECTIONS, appearanceButton, appearanceFeedback, appearanceItems, appearanceKeyboard, normalizeAppearance, screenKeyboard, screenText, setAppearancePath, templateAppearance, templateIdFromText, templateListText } from '../src/appearance.js';
import { collectServerStatus, createDatabaseBackup, createSourceArchive, removeTempFile } from '../src/technical-tools.js';
import { adminUserSummary, CHAT_PERMISSION_LABELS, DEFAULT_CHAT_PERMISSIONS, durationLabel, parseDuration, permissionKeyboard } from '../src/admin-control.js';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.DB_POOL_MAX || 5),
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 5_000,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});
let runtimeSchemaPromise;
async function ensureRuntimeSchema() {
  if (!runtimeSchemaPromise) {
    runtimeSchemaPromise = (async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS coins INTEGER NOT NULL DEFAULT 20');
        await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS plus_expires_at TIMESTAMPTZ");
        await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS plus_emoji TEXT NOT NULL DEFAULT '✨'");
        await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user'");
        await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code TEXT");
        await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by BIGINT REFERENCES users(telegram_id) ON DELETE SET NULL");
        await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS start_completed BOOLEAN NOT NULL DEFAULT TRUE");
        await client.query(`CREATE TABLE IF NOT EXISTS mandatory_sources (id BIGSERIAL PRIMARY KEY, tracking_code TEXT NOT NULL UNIQUE, source_type TEXT NOT NULL CHECK (source_type IN ('channel','group','bot','web_app','website')), visibility TEXT CHECK (visibility IN ('private','public')), title TEXT NOT NULL, target TEXT NOT NULL, join_url TEXT, mode TEXT NOT NULL CHECK (mode IN ('time','count','start','click')), quota INTEGER, duration_seconds INTEGER, audience JSONB NOT NULL DEFAULT '{"regular_female":true,"regular_male":true,"plus_female":true,"plus_male":true}'::jsonb, starts_at TIMESTAMPTZ, started_at TIMESTAMPTZ, paused_at TIMESTAMPTZ, status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('scheduled','active','paused','completed','failed','cancelled')), created_by BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE RESTRICT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
        await client.query(`CREATE TABLE IF NOT EXISTS mandatory_source_events (source_id BIGINT NOT NULL REFERENCES mandatory_sources(id) ON DELETE CASCADE, telegram_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE, event_type TEXT NOT NULL, confirmed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (source_id, telegram_id))`);
        await client.query(`CREATE TABLE IF NOT EXISTS mandatory_source_queue (id BIGSERIAL PRIMARY KEY, source_id BIGINT NOT NULL REFERENCES mandatory_sources(id) ON DELETE CASCADE, position INTEGER NOT NULL, queued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(source_id), UNIQUE(position))`);
        await client.query("ALTER TABLE mandatory_sources ADD COLUMN IF NOT EXISTS audience JSONB NOT NULL DEFAULT '{\"regular_female\":true,\"regular_male\":true,\"plus_female\":true,\"plus_male\":true}'::jsonb");
        await client.query('ALTER TABLE mandatory_sources ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ');
        await client.query('ALTER TABLE mandatory_sources ADD COLUMN IF NOT EXISTS paused_at TIMESTAMPTZ');
        await client.query("UPDATE mandatory_sources SET started_at=COALESCE(starts_at,created_at) WHERE status='active' AND started_at IS NULL");
        await client.query('CREATE INDEX IF NOT EXISTS mandatory_sources_started_idx ON mandatory_sources(status, started_at)');
        await client.query(`CREATE TABLE IF NOT EXISTS mandatory_source_history (id BIGSERIAL PRIMARY KEY, source_id BIGINT NOT NULL REFERENCES mandatory_sources(id) ON DELETE RESTRICT, event_type TEXT NOT NULL, from_status TEXT, to_status TEXT, details JSONB NOT NULL DEFAULT '{}'::jsonb, notify_admin_id BIGINT REFERENCES users(telegram_id) ON DELETE SET NULL, notification_attempts INTEGER NOT NULL DEFAULT 0, last_notification_error TEXT, notified_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
        await client.query('CREATE INDEX IF NOT EXISTS mandatory_source_history_source_idx ON mandatory_source_history(source_id, id DESC)');
        await client.query("CREATE INDEX IF NOT EXISTS mandatory_source_history_notifications_idx ON mandatory_source_history(id) WHERE event_type='started' AND notified_at IS NULL AND notify_admin_id IS NOT NULL");
        await client.query(`CREATE TABLE IF NOT EXISTS mandatory_source_reports (source_id BIGINT NOT NULL REFERENCES mandatory_sources(id) ON DELETE RESTRICT, channel_chat_id BIGINT NOT NULL, message_id BIGINT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (source_id, channel_chat_id))`);
        await client.query('CREATE INDEX IF NOT EXISTS mandatory_source_reports_channel_idx ON mandatory_source_reports(channel_chat_id, updated_at)');
        await client.query('CREATE UNIQUE INDEX IF NOT EXISTS users_referral_code_unique ON users(referral_code) WHERE referral_code IS NOT NULL');
        await client.query("CREATE TABLE IF NOT EXISTS plus_purchases (id BIGSERIAL PRIMARY KEY, telegram_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE, months INTEGER NOT NULL CHECK (months IN (1,3,6,12)), price INTEGER NOT NULL CHECK (price IN (100,250,450,800)), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
        await client.query('ALTER TABLE plus_purchases DROP CONSTRAINT IF EXISTS plus_purchases_price_check');
        await client.query(`CREATE TABLE IF NOT EXISTS anonymous_blocks (
          user_low BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
          user_high BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),
          blocker_id BIGINT REFERENCES users(telegram_id) ON DELETE CASCADE,
          PRIMARY KEY (user_low, user_high), CHECK (user_low < user_high)
        )`);
        await client.query('ALTER TABLE anonymous_blocks ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ');
        await client.query('ALTER TABLE anonymous_blocks ADD COLUMN IF NOT EXISTS blocker_id BIGINT REFERENCES users(telegram_id) ON DELETE CASCADE');
        await client.query(`UPDATE anonymous_blocks ab SET blocker_id = r.reporter_id FROM (SELECT DISTINCT ON (LEAST(reporter_id,target_id), GREATEST(reporter_id,target_id)) reporter_id, target_id FROM reports WHERE target_id IS NOT NULL ORDER BY LEAST(reporter_id,target_id), GREATEST(reporter_id,target_id), created_at DESC) r WHERE ab.blocker_id IS NULL AND ab.user_low=LEAST(r.reporter_id,r.target_id) AND ab.user_high=GREATEST(r.reporter_id,r.target_id)`);
        await client.query("UPDATE anonymous_blocks SET expires_at = created_at + INTERVAL '7 days' WHERE expires_at IS NULL");
        await client.query("ALTER TABLE anonymous_blocks ALTER COLUMN expires_at SET DEFAULT (NOW() + INTERVAL '7 days')");
        await client.query('ALTER TABLE anonymous_blocks ALTER COLUMN expires_at SET NOT NULL');
        await client.query("INSERT INTO bot_settings(key, value) VALUES ('unblock_all_v1', 'pending') ON CONFLICT (key) DO NOTHING");
        await client.query(`CREATE TABLE IF NOT EXISTS chat_metrics (user_id BIGINT PRIMARY KEY REFERENCES users(telegram_id) ON DELETE CASCADE, total_chat_seconds BIGINT NOT NULL DEFAULT 0, total_chats INTEGER NOT NULL DEFAULT 0, completed_chats INTEGER NOT NULL DEFAULT 0, total_messages BIGINT NOT NULL DEFAULT 0, longest_chat_seconds BIGINT NOT NULL DEFAULT 0, longest_chat_messages INTEGER NOT NULL DEFAULT 0, active_days INTEGER NOT NULL DEFAULT 0, last_active_day DATE, first_seen_at TIMESTAMPTZ, last_seen_at TIMESTAMPTZ)`);
        await client.query(`CREATE TABLE IF NOT EXISTS admin_audit_log (id BIGSERIAL PRIMARY KEY, admin_id BIGINT NOT NULL, target_user_id BIGINT, action TEXT NOT NULL, details JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
        await client.query(`CREATE TABLE IF NOT EXISTS gift_codes (code TEXT PRIMARY KEY, coins INTEGER NOT NULL DEFAULT 0 CHECK (coins >= 0), plus_days INTEGER NOT NULL DEFAULT 0 CHECK (plus_days >= 0), max_uses INTEGER, uses INTEGER NOT NULL DEFAULT 0, expires_at TIMESTAMPTZ, created_by BIGINT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
        await client.query(`CREATE TABLE IF NOT EXISTS gift_code_redemptions (code TEXT NOT NULL REFERENCES gift_codes(code) ON DELETE CASCADE, user_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE, redeemed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (code, user_id))`);
        await client.query("ALTER TABLE gift_codes ADD COLUMN IF NOT EXISTS max_uses INTEGER");
        await client.query("ALTER TABLE gift_codes ADD COLUMN IF NOT EXISTS gift_type TEXT NOT NULL DEFAULT 'reward'");
        await client.query("ALTER TABLE gift_codes ADD COLUMN IF NOT EXISTS discount_percent INTEGER NOT NULL DEFAULT 0");
        await client.query("ALTER TABLE gift_codes ADD COLUMN IF NOT EXISTS command_name TEXT");
        await client.query("CREATE UNIQUE INDEX IF NOT EXISTS gift_codes_command_name_unique ON gift_codes(upper(command_name)) WHERE command_name IS NOT NULL");
        await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS discount_percent INTEGER NOT NULL DEFAULT 0");
        await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS discount_code TEXT");
        await client.query(`CREATE TABLE IF NOT EXISTS contact_messages (id BIGSERIAL PRIMARY KEY, sender_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE, recipient_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE, body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), CHECK (sender_id <> recipient_id))`);
        await client.query(`CREATE INDEX IF NOT EXISTS contact_messages_recipient_idx ON contact_messages(recipient_id, id DESC)`);
        await client.query(`CREATE TABLE IF NOT EXISTS chat_gifts (id BIGSERIAL PRIMARY KEY, sender_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE, recipient_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE, gift_type TEXT NOT NULL, amount INTEGER NOT NULL CHECK (amount > 0), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
        await client.query(`CREATE TABLE IF NOT EXISTS daily_coin_claims (user_id BIGINT PRIMARY KEY REFERENCES users(telegram_id) ON DELETE CASCADE, claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
        await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS banned_until TIMESTAMPTZ');
        await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT');
        await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS ban_reason TEXT');
        await client.query("INSERT INTO bot_settings(key,value) VALUES ('chat_permissions',$1),('min_chat_duration','15S'),('spam_consecutive_limit','3'),('spam_delay','2S') ON CONFLICT (key) DO NOTHING", [JSON.stringify(DEFAULT_CHAT_PERMISSIONS)]);
        const unblock = await client.query("SELECT value FROM bot_settings WHERE key='unblock_all_v1'");
        if (unblock.rows[0]?.value === 'pending') {
          await client.query('DELETE FROM anonymous_blocks');
          await client.query("UPDATE users SET blocked_ids='{}'::bigint[] WHERE blocked_ids <> '{}'::bigint[]");
          await client.query("UPDATE bot_settings SET value='applied', updated_at=NOW() WHERE key='unblock_all_v1'");
        }
        await client.query(`INSERT INTO bot_settings(key, value) VALUES
          ('profile_button', 'پروفایل من'), ('back_button', 'بازگشت'),
          ('welcome_message', 'به چت ناشناس خوش آمدی.'),
          ('connected_message', 'وصل شدی؛ سلام کن و گفت‌وگو را شروع کن.'),
          ('mandatory_join_message','برای استفاده از ربات، ابتدا در منابع اجباری عضو شو. با دکمه‌های عضویت وارد شو و سپس «بررسی عضویت» را بزن.'),
          ('mandatory_join_button_label','عضویت در منبع'), ('mandatory_verify_button_label','بررسی عضویت'),
          ('mandatory_join_button_layout','single'), ('mandatory_join_show_source_tags','true'),
          ('mid_chat_ad_enabled', 'false'), ('mid_chat_ad_minutes', '15'), ('mid_chat_games_enabled', 'true'), ('mid_chat_ideas_enabled', 'true'), ('block_duration', '7D'), ('chat_cost_any', '0'), ('chat_cost_male', '0'), ('chat_cost_female', '0'), ('daily_coin_amount', '20'), ('daily_coin_command', '/daily'), ('daily_coin_reset', '24H'), ('appearance_public_enabled', 'true'), ('appearance_private_enabled', 'true'), ('appearance_public', '{}'), ('appearance_private', '{}')
          ON CONFLICT (key) DO NOTHING`);
        await client.query("ALTER TABLE mandatory_sources ADD COLUMN IF NOT EXISTS audience JSONB NOT NULL DEFAULT '{\"regular_female\":true,\"regular_male\":true,\"plus_female\":true,\"plus_male\":true}'::jsonb");
        await client.query(`INSERT INTO bot_settings(key,value) VALUES
          ('mandatory_join_button_label','عضویت در منبع'),
          ('mandatory_verify_button_label','بررسی عضویت'),
          ('mandatory_join_button_layout','single'),
          ('mandatory_join_show_source_tags','true')
          ON CONFLICT (key) DO NOTHING`);
        await client.query('INSERT INTO bot_settings(key,value) VALUES ($1,$2) ON CONFLICT (key) DO NOTHING', ['mandatory_join_message', DEFAULTS.mandatory_join_message]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        runtimeSchemaPromise = undefined;
        throw error;
      } finally { client.release(); }
    })();
  }
  return runtimeSchemaPromise;
}

const DEFAULTS = {
  connect_button: 'وصل کن به ناشناس',
  cancel_button: 'انصراف',
  disconnect_button: 'قطع مکالمه',
  profile_button: 'پروفایل من',
  back_button: 'بازگشت',
  welcome_message: 'به چت ناشناس خوش آمدی.',
  connected_message: 'وصل شدی؛ سلام کن و گفت‌وگو را شروع کن.',
  increase_coins_button: 'افزایش مانو کوین',
  free_coins_button: 'افزایش مانو کوین رایگان',
  plus_button: 'اکانت پلاس',
  mandatory_join_message: 'برای استفاده از ربات، ابتدا در منابع اجباری عضو شو. با دکمه‌های عضویت وارد شو و سپس «بررسی عضویت» را بزن.',
  mandatory_join_button_label: 'عضویت در منبع',
  mandatory_verify_button_label: 'بررسی عضویت',
  mandatory_join_button_layout: 'single',
  mandatory_join_show_source_tags: 'true',
};
const GENDER_LABELS = { male: 'پسرم', female: 'دخترم' };
const PREF_LABELS = { female: 'دختر', male: 'پسر', any: 'مهم نیست' };
const OWN_GENDER_PROMPT = 'انتخابت ثبت شد. برای اتصال سازگار و دوطرفه، جنسیت خودت را هم انتخاب کن:';
const BLOCK_REASONS = {
  rude: 'باهاش حال نکردم',
  abusive: 'بی ادب بود',
  wrong_gender: 'جنسیتش اشتباه بود',
  advertising: 'تبلیغ فرستاد',
};
const STOP_MIN_SECONDS = 15;
const FA_CHAR_MAP = { 'ي': 'ی', 'ك': 'ک', 'ى': 'ی', 'أ': 'ا', 'إ': 'ا', 'ؤ': 'و', 'ئ': 'ی', 'ة': 'ه' };
function normalizeFa(value) {
  return String(value || '')
    .replace(/[يكىأإؤئة]/g, ch => FA_CHAR_MAP[ch] || ch)
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g, '')
    .replace(/\u200C/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function preferenceFromText(value) {
  const key = normalizeFa(value).replace(/\s+/g, '');
  if (key === 'دختر') return 'female';
  if (key === 'پسر') return 'male';
  if (key === 'مهمنیست') return 'any';
  return null;
}

export function arePreferencesCompatible(requesterGender, requesterPreference, candidateGender, candidatePreference) {
  const validGenders = ['male', 'female'];
  const validPreferences = ['male', 'female', 'any'];
  if (!validGenders.includes(requesterGender) || !validGenders.includes(candidateGender)) return false;
  if (!validPreferences.includes(requesterPreference) || !validPreferences.includes(candidatePreference)) return false;
  return (requesterPreference === 'any' || requesterPreference === candidateGender)
    && (candidatePreference === 'any' || candidatePreference === requesterGender);
}

function adminIds() {
  return new Set((process.env.ADMIN_TELEGRAM_IDS || '').split(',').map(x => x.trim()).filter(Boolean));
}
function isAdmin(id) { return adminIds().has(String(id)) || (process.env.OWNER_TELEGRAM_ID && String(id) === String(process.env.OWNER_TELEGRAM_ID)); }
function ownerId() { return String(process.env.OWNER_TELEGRAM_ID || [...adminIds()][0] || ''); }
function isOwner(id) { return String(id) === ownerId(); }
function button(text, data) { return { text, callback_data: data }; }
function replyKeyboard(rows, oneTime = false) { return { keyboard: rows, resize_keyboard: true, one_time_keyboard: oneTime, selective: true }; }
const ANONYMOUS_LINK_BUTTON = 'لینک ناشناس من';
const PLUS_PRICES = { 1: 100, 3: 250, 6: 450, 12: 800 };
function mainKeyboard(settings) { const a = publicAppearance(settings); return replyKeyboard([...appearanceKeyboard(a), ['اتصال به مخاطب خاص']]); }
function profileKeyboard(settings, telegramId) { const numericId = String(telegramId); return { reply_markup: { inline_keyboard: [[{ text: numericId, copy_text: { text: numericId } }], [{ text: settings.back_button || 'بازگشت', callback_data: 'profile:back' }]] } }; }
function increaseCoinsKeyboard(settings) { return { reply_markup: { inline_keyboard: [[{ text: 'مانو کوین روزانه👍', callback_data: 'coins:daily' }], [{ text: 'مانو کوین رایگان🟡', callback_data: 'coins:free' }], [{ text: 'کد هدیه🎁', callback_data: 'coins:gift' }], [{ text: 'خرید مانوکوین🛍', callback_data: 'coins:buy' }], [{ text: 'برگشت', callback_data: 'coins:back' }]] } }; }
function emojiKeyboard(settings) { return replyKeyboard(screenKeyboard(publicAppearance(settings), 'emoji', [['ریست ایموجی'], [settings.back_button]]), true); }
function plusKeyboard(settings) { return replyKeyboard(screenKeyboard(publicAppearance(settings), 'plus', [[settings.back_button]]), true); }
function plusPurchaseKeyboard() { return { reply_markup: { inline_keyboard: [[{ text: 'پلاس 1 ماهه⭐', callback_data: 'plus:buy:1' }], [{ text: 'پلاس 3 ماهه🌟', callback_data: 'plus:buy:3' }], [{ text: 'پلاس 6 ماهه✨', callback_data: 'plus:buy:6' }], [{ text: 'پلاس 12 ماهه💎', callback_data: 'plus:buy:12' }]] } }; }
function plusConfirmKeyboard() { return { reply_markup: { inline_keyboard: [[{ text: 'بله تایید میکنم', callback_data: 'plus:confirm' }, { text: 'خیر بعدا میخرم', callback_data: 'plus:cancel' }]] } }; }
function adminMainKeyboard(settings = {}) { const a = privateAppearance(settings); return replyKeyboard(appearanceKeyboard(a)); }
function reportsKeyboard() { return replyKeyboard([['گزارش‌های کاربران', 'کانال های گزارش دهی'], ['بخش فنی'], ['بازگشت پنل']], true); }
function reportChannelKeyboard() { return replyKeyboard([['اتصال/تغییر کانال'], ['قطع اتصال کانال گزارش‌دهی'], ['بازگشت']], true); }
function adsKeyboard(settings = {}) { return replyKeyboard(screenKeyboard(privateAppearance(settings), 'ads', [['جویین اجباری', 'پیام همگانی'], ['پیام خوش‌آمد', 'تبلیغ اتصال'], ['تبلیغ میان مکالمه'], ['بازگشت پنل']]), true); }
function controlKeyboard() { return replyKeyboard([['امور [آرایش زیبایی]'], ['امور مالی'], ['روشن/خاموش کردن ربات'], ['بازگشت پنل']], true); }
function genderKeyboard(settings = {}) { return replyKeyboard(screenKeyboard(publicAppearance(settings), 'gender', [[GENDER_LABELS.male, GENDER_LABELS.female]]), true); }
export function preferenceKeyboard(settings = {}) { return replyKeyboard(screenKeyboard(publicAppearance(settings), 'preference', [[PREF_LABELS.male, PREF_LABELS.female, PREF_LABELS.any]]), true); }
function waitingKeyboard(settings) { return replyKeyboard(screenKeyboard(publicAppearance(settings), 'waiting', [[appearanceButton(publicAppearance(settings), 'cancel', settings.cancel_button)]])); }
function chatKeyboard(settings, liveControl = false) { const base = screenKeyboard(publicAppearance(settings), 'chat', [[appearanceButton(publicAppearance(settings), 'disconnect', settings.disconnect_button)] ]); const extras = []; if (settings.mid_chat_games_enabled !== 'false') extras.push('بازی'); if (settings.mid_chat_ideas_enabled !== 'false') extras.push('ایده صحبت'); extras.push('هدیه دادن'); if (liveControl) extras.push('کنترل این کاربر'); return replyKeyboard([...base, ...(extras.length ? [extras] : [])]); }
function entertainmentKeyboard(kind) { return { reply_markup: { inline_keyboard: kind === 'games' ? [[{ text: '✅ حقیقت یا جرئت', callback_data: 'game:truth-or-dare' }]] : [[{ text: 'اتفاق امروز', callback_data: 'idea:today' }, { text: 'خاطره بچگی', callback_data: 'idea:childhood' }], [{ text: 'عجیب‌ترین اتفاق اخیرت', callback_data: 'idea:recent' }]] } }; }
function confirmStopKeyboard(settings = {}) { return replyKeyboard(screenKeyboard(publicAppearance(settings), 'confirm_stop', [['اره مطمئنم', 'نه ادامه میدم']]), true); }
function afterStopKeyboard(settings = {}) { return replyKeyboard(screenKeyboard(publicAppearance(settings), 'after_stop', [['بلاکش کن'], ['بعدا وصلش کن']]), true); }
function blockKeyboard(settings = {}) { return replyKeyboard(screenKeyboard(publicAppearance(settings), 'block_reason', [[BLOCK_REASONS.rude], [BLOCK_REASONS.abusive], [BLOCK_REASONS.wrong_gender], [BLOCK_REASONS.advertising], ['بذار بعدا هم وصل بشم']]), true); }
function adminKeyboard(enabled) { return adminMainKeyboard(); }
function userControlKeyboard() { return replyKeyboard([['کنترل مکالمات'], ['کنترل مالی'], ['لیست بن شده ها'], ['لیست بلاکی ها'], ['دریافت وضعیت کاربران'], ['کد هدیه'], ['بازگشت پنل']], true); }
function userFinanceKeyboard() { return replyKeyboard([['گزارش مالی'], ['هزینه اتصال'], ['تنظیم دیلی کوین'], ['بازگشت کنترل کاربران']], true); }
function financeKeyboard() { return userFinanceKeyboard(); }
function botFinanceKeyboard() { return replyKeyboard([['وضعیت', 'قیمت مانوکوین'], ['درگاه ها', 'ولت ها'], ['شماره کارت ها'], ['کنترل ظاهری'], ['بازگشت کنترل ربات']], true); }
function financeAppearanceKeyboard() { return replyKeyboard([['فعال/غیرفعال کردن پرداخت'], ['بازگشت امور مالی']], true); }
function conversationControlKeyboard() { return replyKeyboard([['مجوز های چت'], ['سرگرمی میان چت'], ['هزینه هر چت'], ['حداقل تایم چت'], ['تایم بلاکی'], ['پیام اسپم'], ['بازگشت کنترل کاربران']], true); }
function chatCostInlineKeyboard(settings = {}) { return { reply_markup: { inline_keyboard: [[{ text: `مهم نیست: ${settings.chat_cost_any || 0}`, callback_data: 'conversation:cost:any' }], [{ text: `پسر: ${settings.chat_cost_male || 0}`, callback_data: 'conversation:cost:male' }], [{ text: `دختر: ${settings.chat_cost_female || 0}`, callback_data: 'conversation:cost:female' }], [{ text: 'بازگشت', callback_data: 'conversation:back' }]] } }; }
function contactNoticeKeyboard(messageId) { return { reply_markup: { inline_keyboard: [[{ text: 'دیدن پیام', callback_data: `contact:view:${messageId}` }]] } }; }
function contactMessageKeyboard(messageId) { return { reply_markup: { inline_keyboard: [[{ text: 'پاسخ✅', callback_data: `contact:reply:${messageId}` }, { text: 'بلاک❌', callback_data: `contact:block:${messageId}` }]] } }; }
function contactBlockReasonKeyboard(messageId) { return { reply_markup: { inline_keyboard: [[{ text: 'مزاحمت', callback_data: `contact:block_reason:${messageId}:مزاحمت` }], [{ text: 'محتوای توهین‌آمیز', callback_data: `contact:block_reason:${messageId}:محتوای توهین‌آمیز` }], [{ text: 'تبلیغات', callback_data: `contact:block_reason:${messageId}:تبلیغات` }], [{ text: 'بازگشت', callback_data: `contact:view:${messageId}` }]] } }; }
function contactTargetKeyboard() { return replyKeyboard([['بازگشت']], true); }
function contactReplyKeyboard() { return replyKeyboard([['بازگشت']], true); }
function chatGiftTypeKeyboard() { return { reply_markup: { inline_keyboard: [[{ text: 'مانو کوین🐝', callback_data: 'chatgift:type:coins' }, { text: 'مانو پلاس', callback_data: 'chatgift:type:plus' }], [{ text: 'بازگشت', callback_data: 'chatgift:back' }]] } }; }
function chatGiftCoinKeyboard(amount = 10) { return { reply_markup: { inline_keyboard: [[{ text: '1⃣➖', callback_data: 'chatgift:coin:-1' }, { text: `${amount} مانو کوین`, callback_data: 'chatgift:noop' }, { text: '1⃣➕', callback_data: 'chatgift:coin:1' }], [{ text: '🔟➖', callback_data: 'chatgift:coin:-10' }, { text: 'میزان دلخواه👁‍🗨', callback_data: 'chatgift:coin:custom' }, { text: '🔟➕', callback_data: 'chatgift:coin:10' }], [{ text: 'ارسال هدیه🎁', callback_data: 'chatgift:send' }], [{ text: 'بازگشت', callback_data: 'chatgift:back' }]] } }; }
function chatGiftPlusKeyboard() { return { reply_markup: { inline_keyboard: [[{ text: '1M', callback_data: 'chatgift:plus:1' }, { text: '3M', callback_data: 'chatgift:plus:3' }], [{ text: '6M', callback_data: 'chatgift:plus:6' }, { text: '1Y', callback_data: 'chatgift:plus:12' }], [{ text: 'بازگشت', callback_data: 'chatgift:back' }]] } }; }
function contactTargetIdFromMessage(message) { return Number(message?.forward_origin?.sender_user?.id || message?.forward_from?.id || 0) || null; }
async function sendContactNotice(client, recipientId, messageId) { return send(recipientId, '📨 یک کاربر از داخل ربات برایت پیامی فرستاده است. اگر مایل بودی پیام را ببین و پاسخ بده.', contactNoticeKeyboard(messageId)); }
async function contactPanelFor(client, id, messageId, callbackQuery = null) { const row = (await client.query('SELECT body FROM contact_messages WHERE id=$1 AND recipient_id=$2', [messageId, id])).rows[0]; if (!row) return send(id, 'این پیام دیگر در دسترس نیست.'); return callbackQuery ? editAudienceCallback(callbackQuery, id, row.body, contactMessageKeyboard(messageId)) : send(id, row.body, contactMessageKeyboard(messageId)); }
async function startContactFlow(client, id) { await updateAction(client, id, 'contact:target'); return send(id, '🔎 اتصال به مخاطب خاص\n\nآیدی عددی تلگرام او را بفرست یا یک پیام مستقیم از همان کاربر فوروارد کن.\n\nنگران نباش؛ تا زمانی که پیام را تأیید نکنی چیزی برای او ارسال نمی‌شود.', contactTargetKeyboard()); }
async function sendChatGift(client, senderId, recipientId, type, amount) {
  if (senderId === recipientId) throw new Error('self_gift');
  await client.query('BEGIN');
  try {
    const sender = (await client.query('SELECT coins FROM users WHERE telegram_id=$1 FOR UPDATE', [senderId])).rows[0];
    const recipient = (await client.query('SELECT telegram_id FROM users WHERE telegram_id=$1', [recipientId])).rows[0];
    const coinCost = type === 'coins' ? amount : 0;
    if (!recipient) { await client.query('ROLLBACK'); throw new Error('recipient_missing'); }
    if (type === 'coins' && (!sender || Number(sender.coins) < amount)) { await client.query('ROLLBACK'); throw new Error('insufficient_coins'); }
    if (type === 'coins') await client.query('UPDATE users SET coins=coins-$2,updated_at=NOW() WHERE telegram_id=$1', [senderId, amount]);
    else await client.query("UPDATE users SET plus_expires_at=CASE WHEN $2::int > 0 THEN GREATEST(COALESCE(plus_expires_at,NOW()),NOW()) + ($2 || ' months')::interval ELSE plus_expires_at END,updated_at=NOW() WHERE telegram_id=$1", [recipientId, amount]);
    await client.query('INSERT INTO chat_gifts(sender_id,recipient_id,gift_type,amount) VALUES ($1,$2,$3,$4)', [senderId, recipientId, type, amount]); await client.query('COMMIT');
    const label = type === 'coins' ? `${amount} مانو کوین🐝` : `${amount === 12 ? '۱ سال' : `${amount} ماه`} مانو پلاس`;
    await send(recipientId, `🎁 طرف مکالمه‌ات برایت ${label} هدیه فرستاد. مبارکت باشد!`);
  } catch (error) { if (error.message !== 'recipient_missing' && error.message !== 'insufficient_coins') await client.query('ROLLBACK'); if (error.message === 'insufficient_coins') throw error; if (error.message === 'recipient_missing') throw error; throw error; }
}
function permissionInlineKeyboard(permissions = DEFAULT_CHAT_PERMISSIONS) { return { reply_markup: { inline_keyboard: permissionKeyboard(permissions).map(item => [{ text: item.label, callback_data: `conversation:permission:${item.key}` }]).concat([[{ text: 'بازگشت', callback_data: 'conversation:back' }]]) } }; }
function entertainmentAdminKeyboard(settings = {}) { return { reply_markup: { inline_keyboard: [[{ text: `${settings.mid_chat_games_enabled !== 'false' ? '✅' : '❌'} بازی`, callback_data: 'conversation:entertainment:games' }, { text: `${settings.mid_chat_ideas_enabled !== 'false' ? '✅' : '❌'} ایده صحبت`, callback_data: 'conversation:entertainment:ideas' }], [{ text: 'بازگشت', callback_data: 'conversation:back' }]] } }; }
function spamAdminKeyboard() { return replyKeyboard([['تعداد پیام متوالی'], ['تاخیر بین پیام‌ها'], ['بازگشت کنترل مکالمات']], true); }
function spamInlineKeyboard(settings = {}) { return { reply_markup: { inline_keyboard: [[{ text: `تعداد متوالی: ${settings.spam_consecutive_limit || 3}`, callback_data: 'conversation:spam:limit' }, { text: `تاخیر: ${settings.spam_delay || '2S'}`, callback_data: 'conversation:spam:delay' }], [{ text: 'بازگشت', callback_data: 'conversation:back' }]] } }; }
function giftManagementKeyboard() { return replyKeyboard([['ایجاد'], ['دیلی کوین'], ['برگشت']], true); }
function giftTypeKeyboard() { return { reply_markup: { inline_keyboard: [[{ text: 'مانو کوین', callback_data: 'gift:type:coins' }, { text: 'مانو پلاس', callback_data: 'gift:type:plus' }], [{ text: 'تخفیف خرید (%)', callback_data: 'gift:type:discount' }]] } }; }
function giftPlanKeyboard() { return { reply_markup: { inline_keyboard: [[1, 3, 6, 12].map(months => ({ text: `پلاس ${months} ماهه`, callback_data: `gift:plan:${months}` }))] } }; }
function giftCodeKeyboard(code) { return { reply_markup: { inline_keyboard: [[{ text: 'افزایش مقدار', callback_data: `gift:increase:${code}` }, { text: 'لغو کد', callback_data: `gift:cancel:${code}` }], [{ text: 'بازگشت به فهرست', callback_data: 'gift:list' }]] } }; }
function userActionsInlineKeyboard(targetId, banned = false) { return { reply_markup: { inline_keyboard: [[{ text: 'افزایش/کسر مانو کوین', callback_data: `admin:user:coin:${targetId}` }, { text: 'مانو پلاس', callback_data: `admin:user:plus:${targetId}` }], [{ text: banned ? 'رفع بن' : 'بن کاربر', callback_data: `admin:user:ban:${targetId}` }, { text: 'بن تایمری', callback_data: `admin:user:ban_timer:${targetId}` }], [{ text: 'پیام اختصاصی', callback_data: `admin:user:message:${targetId}` }], [{ text: 'بازگشت', callback_data: `admin:user:back:${targetId}` }]] } }; }
function plusAdjustInlineKeyboard(targetId) { return { reply_markup: { inline_keyboard: [[{ text: '1M', callback_data: `admin:user:plus_select:${targetId}:1` }, { text: '3M', callback_data: `admin:user:plus_select:${targetId}:3` }], [{ text: '6M', callback_data: `admin:user:plus_select:${targetId}:6` }, { text: '1Y', callback_data: `admin:user:plus_select:${targetId}:12` }], [{ text: 'مقدار دلخواه', callback_data: `admin:user:plus_custom:${targetId}` }], [{ text: 'بازگشت', callback_data: `admin:user:back:${targetId}` }]] } }; }
function plusDirectionInlineKeyboard(targetId, months) { return { reply_markup: { inline_keyboard: [[{ text: 'افزایش', callback_data: `admin:user:plus_delta:${targetId}:${months}:1` }, { text: 'کسر', callback_data: `admin:user:plus_delta:${targetId}:${months}:-1` }], [{ text: 'بازگشت', callback_data: `admin:user:plus:${targetId}` }]] } }; }
function parsePlusPeriod(value) { const m = String(value || '').trim().match(/^([+-]?)(\d+)\s*([MY])$/i); if (!m) return null; return Number(m[2]) * (m[3].toUpperCase() === 'Y' ? 12 : 1) * (m[1] === '-' ? -1 : 1); }
function renameKeyboard() { return replyKeyboard([['دکمه اتصال'], ['دکمه انصراف'], ['دکمه قطع مکالمه']], true); }
export function mandatoryJoinKeyboard() { return replyKeyboard([['افزودن', 'وضعیت'], ['کنترل ظاهری'], ['بازگشت پنل']], true); }
function mandatoryTypeKeyboard() { return replyKeyboard([['کانال', 'گروه'], ['ربات', 'وب اپ'], ['وب سایت'], ['بازگشت']], true); }
function mandatoryVisibilityKeyboard() { return replyKeyboard([['خصوصی', 'عمومی'], ['بازگشت']], true); }
function mandatoryModeKeyboard(type) { return replyKeyboard(type === 'bot' ? [['براساس زمان', 'براساس استارت'], ['بازگشت']] : [['براساس زمان', 'براساس میزان'], ['بازگشت']], true); }
function mandatoryActivationKeyboard() { return replyKeyboard([['زمان بندی کردن', 'شروع از الان'], ['ارسال به صف'], ['بازگشت']], true); }
function mandatoryConfirmKeyboard() { return replyKeyboard([['تایید نهایی'], ['بازگشت']], true); }
export function mandatoryScheduleListKeyboard() { return replyKeyboard([['الان ست کن', 'تغییر تایم'], ['کنسل کردن'], ['بازگشت']], true); }
export function mandatoryStatusKeyboard() { return replyKeyboard([['لیست زمان بندی', 'صف انتظار'], ['درحال انجام'], ['بازگشت']], true); }
function mandatoryAppearanceKeyboard() { return replyKeyboard([['ویرایش متن جویین', 'نام دکمه عضویت'], ['نام دکمه بررسی', 'چیدمان دکمه‌ها'], ['نمایش/پنهان‌کردن برچسب منبع'], ['بازگشت']], true); }
function mandatoryAppearanceLayoutKeyboard() { return replyKeyboard([['تک‌ردیفه', 'فشرده'], ['بازگشت']], true); }

async function telegram(method, body, { timeoutMs = 12_000 } = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is missing');
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(`Telegram ${method}: ${result.description || response.status}`);
  return result.result;
}
async function send(chatId, text, replyMarkup) {
  const markup = replyMarkup?.reply_markup || replyMarkup;
  return telegram('sendMessage', { chat_id: chatId, text, protect_content: true, ...(markup ? { reply_markup: markup } : {}) });
}
async function sendLink(chatId, text, replyMarkup) {
  const markup = replyMarkup?.reply_markup || replyMarkup;
  return telegram('sendMessage', { chat_id: chatId, text, protect_content: false, ...(markup ? { reply_markup: markup } : {}) });
}
async function sendDocument(chatId, filePath, filename, caption = '') {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const form = new FormData();
  form.append('chat_id', String(chatId));
  if (caption) form.append('caption', caption);
  form.append('document', new Blob([await fs.readFile(filePath)]), filename);
  const response = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, { method: 'POST', body: form, signal: AbortSignal.timeout(30_000) });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(`Telegram sendDocument: ${result.description || response.status}`);
  return result.result;
}

function flowFor(settings) {
  const sendAsUser = async (senderId, recipientId, text, replyMarkup) => {
    const c = await pool.connect();
    try { const sender = await user(c, senderId); return send(recipientId, formatPremiumMessage(sender, senderId, text), replyMarkup); }
    finally { c.release(); }
  };
  const appearance = publicAppearance(settings);
  return createAnonymousFlow({ pool, send, sendLink, sendAsUser, connectButton: appearanceButton(appearance, 'connect', settings.connect_button), disconnectButton: appearanceButton(appearance, 'disconnect', settings.disconnect_button) });
}
async function answerCallback(id) { try { await telegram('answerCallbackQuery', { callback_query_id: id }); } catch (e) { console.error('callback_answer_error', e.message); } }

async function activeMandatorySources(client) {
  await processMandatoryLifecycle(client, { telegramCall: telegram, sendAdmin: (chatId, text, markup) => send(chatId, text, markup) });
  return client.query("SELECT * FROM mandatory_sources WHERE status='active' AND (started_at IS NULL OR started_at <= NOW()) ORDER BY id");
}
async function telegramChatMember(target, userId) {
  try { const member = await telegram('getChatMember', { chat_id: target, user_id: userId }); return isTelegramMember(member); }
  catch (error) { console.error('mandatory_membership_check_error', error.message); return false; }
}
export function isTelegramMember(member) {
  return ['creator', 'administrator', 'member'].includes(member?.status)
    || (member?.status === 'restricted' && member.is_member === true);
}
function normalizeTelegramTarget(value) {
  const raw = String(value || '').trim();
  if (/^-?\d+$/.test(raw) || raw.startsWith('@')) return raw;
  const match = raw.match(/^https?:\/\/(?:t\.me|telegram\.me)\/([^/?#]+)/i);
  if (!match) return raw;
  const privateMatch = raw.match(/^https?:\/\/(?:t\.me|telegram\.me)\/c\/(\d+)/i);
  if (privateMatch) return `-100${privateMatch[1]}`;
  if (match[1] === 'c') return raw;
  if (match[1].startsWith('+') || match[1] === 'joinchat') return raw;
  return `@${match[1]}`;
}
async function validateMandatoryTarget(type, target) {
  if (!['channel', 'group'].includes(type)) return {};
  try {
    const me = await telegram('getMe', {}); const normalized = normalizeTelegramTarget(target); const chat = await telegram('getChat', { chat_id: normalized }); const member = await telegram('getChatMember', { chat_id: chat.id || normalized, user_id: me.id });
    if (!['creator', 'administrator'].includes(member?.status)) return null;
    return { chatId: String(chat.id || normalized), title: String(chat.title || chat.username || chat.id || normalized) };
  } catch (error) { console.error('mandatory_target_validation_error', error.message); return false; }
}
async function validateMandatoryReportChannel(target) {
  try {
    const me = await telegram('getMe', {});
    const chat = await telegram('getChat', { chat_id: normalizeTelegramTarget(target) });
    if (chat.type !== 'channel') return null;
    const member = await telegram('getChatMember', { chat_id: chat.id, user_id: me.id });
    if (member?.status !== 'creator' && !(member?.status === 'administrator' && member.can_post_messages === true)) return null;
    return { id: String(chat.id), title: String(chat.title || chat.username || chat.id), isPrivate: !chat.username };
  } catch (error) {
    console.error('mandatory_report_channel_validation_error', String(error?.message || error).slice(0, 200));
    return false;
  }
}
async function mandatoryRequirements(id, client, { recordJoins = false, profile = null } = {}) {
  const sources = await activeMandatorySources(client);
  const audienceProfile = profile || await user(client, id);
  const missing = [];
  let recordedAny = false;
  for (const source of sources.rows) {
    if (!mandatoryAudienceIncludesUser(source.audience, audienceProfile)) continue;
    if (!['channel','group'].includes(source.source_type)) continue;
    const joined = await telegramChatMember(normalizeTelegramTarget(source.target), id);
    if (!joined) missing.push(source);
    else if (recordJoins) {
      const recorded = await client.query("INSERT INTO mandatory_source_events(source_id, telegram_id, event_type) VALUES ($1,$2,'join') ON CONFLICT DO NOTHING RETURNING source_id", [source.id, id]);
      if (recorded.rowCount) {
        recordedAny = true;
        await client.query('UPDATE mandatory_sources SET updated_at=NOW() WHERE id=$1', [source.id]);
        try { await syncMandatoryReport(client, source.id, telegram); }
        catch (error) { console.error('mandatory_report_sync_error', source.id, String(error?.message || error).slice(0, 200)); }
      }
    }
  }
  if (recordedAny) await processMandatoryLifecycle(client, { telegramCall: telegram, sendAdmin: (chatId, text, markup) => send(chatId, text, markup) });
  return missing;
}
async function recordMandatoryStart(id, payload, client, profile = null) {
  const code = String(payload || '').match(/^mj_([A-Za-z0-9_-]+)$/)?.[1];
  if (!code || isAdmin(id)) return;
  const source = await client.query("SELECT id,audience FROM mandatory_sources WHERE tracking_code=$1 AND source_type='bot'", [code]);
  const audienceProfile = profile || await user(client, id);
  if (!source.rows[0] || !mandatoryAudienceIncludesUser(source.rows[0].audience, audienceProfile)) return;
  const recorded = await client.query("INSERT INTO mandatory_source_events(source_id,telegram_id,event_type) SELECT id,$2,'start' FROM mandatory_sources WHERE id=$1 ON CONFLICT DO NOTHING RETURNING source_id", [source.rows[0].id, id]);
  if (recorded.rows[0]) {
    await client.query('UPDATE mandatory_sources SET updated_at=NOW() WHERE id=$1', [recorded.rows[0].source_id]);
    try { await syncMandatoryReport(client, recorded.rows[0].source_id, telegram); }
    catch (error) { console.error('mandatory_report_sync_error', recorded.rows[0].source_id, String(error?.message || error).slice(0, 200)); }
    await processMandatoryLifecycle(client, { telegramCall: telegram, sendAdmin: (chatId, text, markup) => send(chatId, text, markup) });
  }
}
export function mandatoryJoinMessage(missing = [], displaySettings = {}) {
  const template = String(displaySettings.mandatory_join_message || DEFAULTS.mandatory_join_message);
  return template.replace(/\{count\}/g, String(Array.isArray(missing) ? missing.length : 0));
}
export function mandatoryJoinMarkup(missing, displaySettings = {}, telegramId = null) {
  const sources = (Array.isArray(missing) ? missing : []).filter(x => /^https?:\/\//i.test(String(x.join_url || '')));
  const showTags = displaySettings.mandatory_join_show_source_tags !== 'false';
  const baseLabel = String(displaySettings.mandatory_join_button_label || DEFAULTS.mandatory_join_button_label).slice(0, 60);
  const buttons = sources.map((x, i) => {
    let url = x.join_url;
    try {
      const parsed = new URL(url);
      if (telegramId && parsed.pathname.endsWith('/api/mandatory-track')) {
        const token = encryptMandatoryTrackingUserId(telegramId, process.env.MANDATORY_TRACKING_SECRET || process.env.TELEGRAM_BOT_TOKEN);
        if (token) parsed.searchParams.set('uid', token);
        url = parsed.toString();
      }
    } catch {}
    return { text: showTags ? `${baseLabel} ${i + 1}` : baseLabel, url };
  });
  const rows = [];
  if (displaySettings.mandatory_join_button_layout === 'compact') {
    for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  } else {
    for (const item of buttons) rows.push([item]);
  }
  rows.push([{ text: String(displaySettings.mandatory_verify_button_label || DEFAULTS.mandatory_verify_button_label).slice(0, 60), callback_data: 'mandatory:verify' }]);
  return { reply_markup: { inline_keyboard: rows } };
}
async function settings(client) {
  const result = await client.query('SELECT key, value FROM bot_settings');
  const out = { ...DEFAULTS, bot_enabled: 'true' };
  for (const row of result.rows) out[row.key] = row.value;
  out.appearance_public = normalizeAppearance('public', out.appearance_public);
  out.appearance_private = normalizeAppearance('private', out.appearance_private);
  out.appearance_public_enabled = out.appearance_public_enabled !== 'false';
  out.appearance_private_enabled = out.appearance_private_enabled !== 'false';
  return { ...out, bot_enabled: out.bot_enabled !== 'false' };
}
function publicAppearance(s) { return s?.appearance_public_enabled === false ? normalizeAppearance('public', null) : normalizeAppearance('public', s?.appearance_public); }
function privateAppearance(s) { return s?.appearance_private_enabled === false ? normalizeAppearance('private', null) : normalizeAppearance('private', s?.appearance_private); }
function appearanceButtonLabel(s, section, id, fallback) { return appearanceButton(section === 'public' ? publicAppearance(s) : privateAppearance(s), id, fallback); }
function appearanceButtonId(value, section, s) {
  const appearance = section === 'public' ? publicAppearance(s) : privateAppearance(s);
  for (const row of appearance.buttons || []) for (const item of row || []) if (item.enabled !== false && item.label === value) return item.id;
  return null;
}
function beautySectionsKeyboard() { return { reply_markup: { inline_keyboard: [[{ text: 'آرایش (Public)', callback_data: 'beauty:section:public' }], [{ text: 'آرایش (Privacy)', callback_data: 'beauty:section:private' }], [{ text: 'بازگشت', callback_data: 'beauty:back' }]] } }; }
const BEAUTY_FLOW_NEXT = {
  root: { connect: 'preference', profile: 'profile', anonymous_link: 'anonymous_link', coins: 'coins', plus: 'plus', ads: 'ads', control: 'control', users: 'user_search', status: 'status', reports: 'reports', admins: 'admins', exit: 'root' },
  preference: { male: 'gender', female: 'gender', any: 'gender' },
  gender: { male: 'waiting', female: 'waiting' },
  waiting: { cancel: 'root' },
  chat: { disconnect: 'confirm_stop' },
  confirm_stop: { confirm: 'after_stop', continue: 'chat' },
  after_stop: { block: 'block_reason', later: 'root' },
  block_reason: { rude: 'root', abusive: 'root', wrong_gender: 'root', advertising: 'root', later: 'root' },
  profile: { emoji: 'emoji', back: 'root' },
  emoji: { reset: 'root', back: 'profile' },
  coins: { free_coins: 'root', back: 'root' },
  plus: { back: 'root' },
  anonymous_link: { back: 'root' },
  control: { public_appearance: 'appearance', private_appearance: 'appearance', templates: 'appearance', toggle: 'root', back: 'root' },
  appearance: { templates: 'appearance', edit: 'appearance', layout: 'appearance', reset: 'root', back: 'control' },
  reports: { technical: 'technical', user_reports: 'user_search', report_channels: 'root', back: 'root' },
  technical: { source: 'technical', database: 'technical', server: 'technical', back: 'reports' },
  ads: { join: 'root', broadcast: 'root', welcome: 'root', connection_ad: 'root', mid_ad: 'root', back: 'root' },
  user_search: { back: 'root' },
};
function beautyChildPath(path, itemId) { return BEAUTY_FLOW_NEXT[path]?.[itemId] || (path === 'root' && itemId) || null; }
function beautyParentPath(path) {
  for (const [parent, children] of Object.entries(BEAUTY_FLOW_NEXT)) if (Object.values(children).includes(path)) return parent;
  return 'root';
}
function beautyMessageTarget(appearance, path, itemId) {
  const nextPath = beautyChildPath(path, itemId);
  if (nextPath && nextPath !== path) {
    if (nextPath === 'root') return { parent: appearance, key: 'message' };
    if (appearance.screens?.[nextPath]) return { parent: appearance.screens[nextPath], key: 'message' };
  }
  if (path === 'root' && appearance.feedback && Object.prototype.hasOwnProperty.call(appearance.feedback, itemId)) return { parent: appearance.feedback, key: itemId };
  if (appearance.screens?.[itemId]) return { parent: appearance.screens[itemId], key: 'message' };
  if (appearance.screens?.[path]) return { parent: appearance.screens[path], key: 'message' };
  return null;
}
function beautyMessageText(appearance, path, itemId) {
  const target = beautyMessageTarget(appearance, path, itemId);
  return target?.parent?.[target.key] || '';
}

function beautyPathRows(appearance, path = 'root') {
  if (path === 'root') return Array.isArray(appearance.buttons) ? appearance.buttons : [];
  const buttons = appearance.screens?.[path]?.buttons || [];
  return Array.isArray(buttons) && buttons.some(row => Array.isArray(row)) ? buttons : [buttons];
}
function beautyPathItems(appearance, path = 'root') {
  return beautyPathRows(appearance, path).flatMap((row, rowIndex) => (row || []).map((item, colIndex) => ({ ...item, rowIndex, colIndex })));
}
function beautyItemRef(appearance, path, itemId) {
  for (const row of beautyPathRows(appearance, path)) for (const item of row || []) if (item?.id === itemId) return item;
  return null;
}
function beautySelected(appearance, path, itemId) { return beautyItemRef(appearance, path, itemId); }
function beautyKeyboard(section, appearance, path = 'root', selectedId = null) {
  const rows = beautyPathRows(appearance, path);
  const items = rows.flat().filter(item => item?.enabled !== false);
  if (!selectedId) {
    const keyboardRows = rows.map(row => (row || []).filter(item => item?.enabled !== false).map(item => ({ text: item.label || item.id, callback_data: `beauty:${section}:pick:${path}:${item.id}` }))).filter(row => row.length);
    keyboardRows.push([{ text: 'بازگشت', callback_data: path === 'root' ? 'beauty:back' : `beauty:${section}:open:${beautyParentPath(path)}` }]);
    return { reply_markup: { inline_keyboard: keyboardRows } };
  }
  const item = beautySelected(appearance, path, selectedId);
  if (!item) return beautyKeyboard(section, appearance, path);
  const status = item.enabled === false ? 'OFF🔴' : 'ON🟢';
  return { reply_markup: { inline_keyboard: [
    [{ text: '👆🏻', callback_data: `beauty:${section}:move:up:${path}:${item.id}` }],
    [{ text: '👈🏻', callback_data: `beauty:${section}:move:left:${path}:${item.id}` }, { text: item.label || item.id, callback_data: `beauty:${section}:noop` }, { text: '👉🏻', callback_data: `beauty:${section}:move:right:${path}:${item.id}` }],
    [{ text: '👇🏻', callback_data: `beauty:${section}:move:down:${path}:${item.id}` }],
    [{ text: 'Message❔', callback_data: `beauty:${section}:message:${path}:${item.id}` }, { text: 'Name⭕️', callback_data: `beauty:${section}:name:${path}:${item.id}` }],
    [{ text: 'Enter✔️', callback_data: `beauty:${section}:enter:${path}:${item.id}` }],
    [{ text: status, callback_data: `beauty:${section}:toggle:${path}:${item.id}` }],
    [{ text: 'بازگشت', callback_data: `beauty:${section}:open:${beautyParentPath(path)}` }]
  ] } };
}
function beautyPathLabel(path) { return path === 'root' ? 'صفحه اصلی' : `صفحه اصلی ← ${path}`; }
function beautyEditorText(section, appearance, path = 'root', selectedId = null, note = '') {
  const item = selectedId ? beautySelected(appearance, path, selectedId) : null;
  const title = section === 'public' ? 'Public' : 'Privacy';
  if (!item) { const screen = appearance.screens?.[path]; return path === 'root' ? `ویرایش آرایش زیبایی — ${title}\n\nدکمه‌های صفحه اصلی را انتخاب کن. فعلاً چیزی تغییر نمی‌کند تا یکی از گزینه‌های ویرایش را بزنی.` : `ویرایش آرایش زیبایی — ${title}\n\nصفحه داخلی: ${screen?.title || path}\n${screen?.message || ''}\n\nدکمه‌های داخل این بخش را انتخاب کن.`; }
  const response = beautyMessageText(appearance, path, item.id);
  return `${note ? `${note}\n\n` : ''}دکمه انتخاب‌شده: ${item.label || item.id}\nپیام پاسخ: ${response || 'پاسخ مستقیمی ثبت نشده است.'}\nنام نمایشی: ${item.label || item.id}\nمسیر: ${beautyPathLabel(path)}\nوضعیت: ${item.enabled === false ? 'خاموش' : 'روشن'}`;
}
function updateAppearanceSetting(client, section, appearance) { const [key, json] = saveAppearanceQuery(section, appearance); return client.query('INSERT INTO bot_settings(key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()', [key, json]); }
function moveBeautyItem(appearance, path, itemId, direction) {
  const out = JSON.parse(JSON.stringify(appearance));
  const rows = path === 'root' ? out.buttons : (out.screens?.[path]?.buttons || []);
  const normalized = path === 'root' ? rows : [rows.flat ? rows.flat() : rows];
  const grid = path === 'root' ? rows : (Array.isArray(rows[0]) ? rows : [rows]);
  let r = -1, c = -1;
  for (let i=0;i<grid.length;i++) for (let j=0;j<(grid[i]||[]).length;j++) if (grid[i][j]?.id === itemId) { r=i; c=j; }
  if (r < 0) return out;
  let nr=r, nc=c;
  if (direction === 'left') nc=Math.max(0,c-1);
  if (direction === 'right') nc=Math.min((grid[r]||[]).length-1,c+1);
  if (direction === 'up') nr=Math.max(0,r-1);
  if (direction === 'down') nr=Math.min(grid.length-1,r+1);
  if (direction === 'left' || direction === 'right') [grid[r][c],grid[nr][nc]]=[grid[nr][nc],grid[r][c]];
  else if (nr !== r) { const target = grid[nr] || (grid[nr]=[]); target.splice(Math.min(nc,target.length),0,grid[r].splice(c,1)[0]); if (!grid[r].length) grid.splice(r,1); }
  if (path === 'root') out.buttons = grid; else out.screens[path].buttons = Array.isArray(rows[0]) ? grid : grid[0];
  return out;
}
async function editBeautyMessage(callbackQuery, id, text, markup) { return editAudienceCallback(callbackQuery, id, text, markup); }
async function handleBeautyCallback(id, data, callbackQuery, client, s) {
  if (!isAdmin(id)) return send(id, 'این بخش فقط برای مدیران و ادمین‌ها فعال است.');
  if (data === 'beauty:back') { await updateAction(client, id, 'admin:control'); return editBeautyMessage(callbackQuery, id, 'کنترل ربات', controlKeyboard()); }
  if (data.startsWith('beauty:section:')) { const section=data.split(':')[2]; if (!['public','private'].includes(section)) return send(id, 'بخش نامعتبر است.'); const appearance=section==='public'?publicAppearance(s):privateAppearance(s); await updateAction(client,id,`beauty:${section}:root`); return editBeautyMessage(callbackQuery,id,beautyEditorText(section,appearance),beautyKeyboard(section,appearance)); }
  const parts=data.split(':'); const section=parts[1]; const action=parts[2]; const appearance=section==='public'?publicAppearance(s):privateAppearance(s);
  const path=parts[3] || 'root'; const itemId=parts[4] || null;
  if (!['public','private'].includes(section)) return send(id, 'بخش نامعتبر است.');
  if (action === 'noop') return false;
  if (action === 'pick') { const item=beautySelected(appearance,path,itemId); if (!item) return send(id,'دکمه پیدا نشد.'); return editBeautyMessage(callbackQuery,id,beautyEditorText(section,appearance,path,itemId),beautyKeyboard(section,appearance,path,itemId)); }
  if (action === 'open') return editBeautyMessage(callbackQuery,id,beautyEditorText(section,appearance,path),beautyKeyboard(section,appearance,path));
  if (action === 'move') { const direction=parts[3], movePath=parts[4] || 'root', moveId=parts[5]; const next=moveBeautyItem(appearance,movePath,moveId,direction); await updateAppearanceSetting(client,section,next); return editBeautyMessage(callbackQuery,id,beautyEditorText(section,next,movePath,moveId,'چینش ثبت شد.'),beautyKeyboard(section,next,movePath,moveId)); }
  if (action === 'toggle') { const next=JSON.parse(JSON.stringify(appearance)); const item=beautyItemRef(next,path,itemId); if (!item) return send(id,'دکمه پیدا نشد.'); item.enabled=item.enabled === false; await updateAppearanceSetting(client,section,next); return editBeautyMessage(callbackQuery,id,beautyEditorText(section,next,path,itemId,'وضعیت ثبت شد.'),beautyKeyboard(section,next,path,itemId)); }
  if (action === 'enter') { const nextPath=beautyChildPath(path,itemId); if (!nextPath || nextPath === path) return editBeautyMessage(callbackQuery,id,'این دکمه صفحهٔ داخلی دیگری ندارد.',beautyKeyboard(section,appearance,path,itemId)); return editBeautyMessage(callbackQuery,id,beautyEditorText(section,appearance,nextPath),beautyKeyboard(section,appearance,nextPath)); }
  if (action === 'name' || action === 'message') { const msgId=callbackQuery?.message?.message_id || ''; await updateAction(client,id,`beauty:${action}:${section}:${path}:${itemId}:${msgId}`); const item=beautySelected(appearance,path,itemId); const current=action==='name'?item?.label:(beautyMessageText(appearance,path,itemId) || item?.label || ''); return editBeautyMessage(callbackQuery,id,`مقدار فعلی:\n${current}\n\nمقدار جدید را بفرست.`,{reply_markup:{inline_keyboard:[[{text:'بازگشت',callback_data:`beauty:${section}:pick:${path}:${itemId}`}]]}}); }
  return false;
}
function appearanceEditorKeyboard(section) { return replyKeyboard([['قالب‌های آماده', 'ویرایش آیتم‌ها'], ['چیدمان', 'روشن/خاموش'], ['بازگردانی پیش‌فرض'], ['بازگشت کنترل ربات']], true); }
function appearanceTemplateKeyboard() { return replyKeyboard([['1 پیش‌فرض فعلی'], ['2 لوکس'], ['3 هالووینی'], ['4 فرندلی'], ['بازگشت']], true); }
function appearanceLayoutKeyboard() { return replyKeyboard([['چینش فعلی'], ['تک‌ستونه'], ['دو ستونه'], ['بازگشت']], true); }
function appearanceItemsKeyboard(section, appearance, page = 0) { const all = appearanceItems(section, appearance); const size = 24; const start = page * size; const rows = all.slice(start, start + size).map((item, index) => [`${start + index + 1}) ${item.label}`]); const navigation = []; if (page > 0) navigation.push('صفحه قبل'); if (start + size < all.length) navigation.push('صفحه بعد'); return replyKeyboard([...rows, ...(navigation.length ? [navigation] : []), ['بازگشت']], true); }
function appearanceEditorText(section, appearance) { const title = APPEARANCE_SECTIONS[section]?.title || section; return `کنترل ظاهر ${title}

عنوان: ${appearance.title}
متن: ${appearance.message}
چیدمان فعلی: ${appearance.layout}

از «قالب‌های آماده» یک ظاهر کامل انتخاب کن یا از «ویرایش آیتم‌ها» نام دکمه و متن پاسخ هر مرحله را جداگانه تغییر بده.`; }
function saveAppearanceQuery(section, appearance) { return [APPEARANCE_SECTIONS[section].key, JSON.stringify(appearance)]; }
function technicalKeyboard(settings = {}) { return replyKeyboard(screenKeyboard(privateAppearance(settings), 'technical', [['فایل اوپن سورس'], ['بک آپ دیتابیس'], ['وضعیت سرور'], ['بازگشت']]), true); }
function sourceFormatKeyboard() { return replyKeyboard([['ZIP'], ['TAR.GZ'], ['بازگشت']], true); }
function databaseFormatKeyboard() { return replyKeyboard([['ZIP چندفرمتی'], ['SQL'], ['JSON'], ['CSV (ZIP)'], ['بازگشت']], true); }

async function ensureUser(client, id) {
  await client.query("INSERT INTO users (telegram_id, coins, start_completed) VALUES ($1, 20, FALSE) ON CONFLICT (telegram_id) DO UPDATE SET updated_at=NOW()", [id]);
  const result = await client.query('SELECT * FROM users WHERE telegram_id=$1', [id]);
  return result.rows[0];
}
async function user(client, id) { const r = await client.query('SELECT * FROM users WHERE telegram_id=$1', [id]); return r.rows[0] || null; }
function iranDate(value) {
  return new Intl.DateTimeFormat('fa-IR', { timeZone: 'Asia/Tehran', dateStyle: 'short', timeStyle: 'short', hourCycle: 'h23', hour12: false }).format(new Date(value));
}
function isPlus(me, id) { return isAdmin(id) || (me?.plus_expires_at && new Date(me.plus_expires_at).getTime() > Date.now()); }
function premiumRole(me, id) {
  if (isOwner(id)) return 'owner';
  if (isAdmin(id)) return 'admin';
  if (isPlus(me, id)) return 'plus';
  return null;
}
function badgeFor(me, id) {
  const role = premiumRole(me, id);
  if (!role) return '';
  const fallback = role === 'owner' ? '✨✨✨' : role === 'admin' ? '✨✨' : '✨';
  const requiredCount = role === 'owner' ? 3 : role === 'admin' ? 2 : 1;
  return emojiSequence(me?.plus_emoji, requiredCount) ? String(me.plus_emoji).trim() : fallback;
}
function premiumMarker(role) { return role === 'owner' ? '/owner' : role === 'admin' ? '/admin' : '/plus'; }
function formatPremiumMessage(me, id, text) {
  const role = premiumRole(me, id);
  return role ? `${premiumMarker(role)} ${badgeFor(me, id)}\n${text}` : text;
}
function oneEmoji(value) {
  return emojiSequence(value, 1);
}
function emojiSequence(value, count) {
  const input = String(value || '').trim();
  if (!input || !Intl.Segmenter) return false;
  const parts = [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(input)].map(x => x.segment);
  return parts.length === count && parts.every(part => /\p{Extended_Pictographic}/u.test(part));
}
async function sendProfile(id, settings) {
  const client = await pool.connect();
  try {
    const me = await ensureUser(client, id);
    const gender = me.gender === 'male' ? 'پسر' : me.gender === 'female' ? 'دختر' : 'ثبت نشده';
    const plusText = isAdmin(id) ? 'نامحدود' : (isPlus(me, id) ? `${Math.max(0, Math.ceil((new Date(me.plus_expires_at).getTime() - Date.now()) / 86400000))} روز` : 'ندارد');
    const text = `پروفایل شما\n\n🪙 مانو کوین: ${Number(me.coins || 0)}\n✨ باقی مانده مانو پلاس: ${plusText} ${badgeFor(me, id)}\n📅 تاریخ عضویت: ${iranDate(me.created_at)}\n🆔 آیدی عددی: ${me.telegram_id}\n⚧ جنسیت: ${gender}`;
    return send(id, text, profileKeyboard(settings, me.telegram_id));
  } finally { client.release(); }
}
async function adminStats(client) {
  const r = await client.query(`SELECT
    COUNT(*) FILTER (WHERE gender='male' AND COALESCE(plus_expires_at,NOW()-INTERVAL '1 second') <= NOW()) AS regular_male,
    COUNT(*) FILTER (WHERE gender='female' AND COALESCE(plus_expires_at,NOW()-INTERVAL '1 second') <= NOW()) AS regular_female,
    COUNT(*) FILTER (WHERE gender='male' AND plus_expires_at > NOW()) AS plus_male,
    COUNT(*) FILTER (WHERE gender='female' AND plus_expires_at > NOW()) AS plus_female,
    COUNT(*) FILTER (WHERE gender='male') AS total_male, COUNT(*) FILTER (WHERE gender='female') AS total_female,
    COUNT(*) FILTER (WHERE status IN ('waiting','chatting') AND gender='male') AS online_male,
    COUNT(*) FILTER (WHERE status IN ('waiting','chatting') AND gender='female') AS online_female,
    COUNT(*) FILTER (WHERE status='waiting') AS waiting, COUNT(*) FILTER (WHERE status='chatting') AS chatting,
    (SELECT COUNT(DISTINCT telegram_id) FROM plus_purchases WHERE created_at >= NOW()-INTERVAL '30 days') AS revenue_users,
    (SELECT COUNT(*) FROM reports WHERE status='open') AS reports FROM users`);
  const x = r.rows[0];
  return `وضعیت کاربران\n\nکاربر معمولی پسر: ${x.regular_male}\nکاربر معمولی دختر: ${x.regular_female}\nکاربر پلاس پسر: ${x.plus_male}\nکاربر پلاس دختر: ${x.plus_female}\n\nچت‌های فعال: ${Math.floor(Number(x.chatting) / 2)}\nدر صف انتظار: ${x.waiting}\nکاربران درآمدزا در ۳۰ روز اخیر: ${x.revenue_users}\n\nجمع کل کاربران — پسر: ${x.total_male} | دختر: ${x.total_female}\nکاربران آنلاین — پسر: ${x.online_male} | دختر: ${x.online_female}\nگزارش‌های باز: ${x.reports}`;
}
async function botStatus(client) {
  const r = await client.query("SELECT COUNT(*) FILTER (WHERE status='waiting') AS waiting, COUNT(*) FILTER (WHERE status='chatting') AS chatting FROM users");
  const enabled = await botSettingValue(client, 'bot_enabled', 'true');
  return `وضعیت ربات\n\nروشن: ${enabled !== 'false' ? 'بله' : 'خیر'}\nمکالمه‌های فعال: ${Math.floor(Number(r.rows[0].chatting || 0) / 2)}\nدر صف انتظار: ${r.rows[0].waiting}`;
}
async function financialReport(client) {
  const [sales, coins, plus, active] = await Promise.all([
    client.query("SELECT COUNT(*)::int AS count, COALESCE(SUM(price),0)::int AS total FROM plus_purchases WHERE created_at >= NOW()-INTERVAL '30 days'"),
    client.query('SELECT COALESCE(SUM(coins),0)::int AS balance FROM users'),
    client.query("SELECT COUNT(*)::int AS active FROM users WHERE plus_expires_at > NOW()"),
    client.query("SELECT COUNT(*)::int AS active_chats FROM users WHERE status='chatting'")
  ]);
  return `گزارش مالی\n\nخرید پلاس در ۳۰ روز اخیر: ${sales.rows[0].count}\nدرآمد ثبت‌شده: ${sales.rows[0].total} مانو کوین\nموجودی کل کاربران: ${coins.rows[0].balance} مانو کوین\nکاربران پلاس فعال: ${plus.rows[0].active}\nچت‌های فعال: ${Math.floor(Number(active.rows[0].active_chats) / 2)}`;
}
async function financeStatusText(client) {
  const [enabled, price, gateways, wallets, cards, plus] = await Promise.all([
    botSettingValue(client, 'finance_enabled', 'false'), botSettingValue(client, 'finance_coin_price', 'تنظیم نشده'),
    botSettingValue(client, 'finance_gateways', 'تنظیم نشده'), botSettingValue(client, 'finance_wallets', 'تنظیم نشده'),
    botSettingValue(client, 'finance_cards', 'تنظیم نشده'), client.query("SELECT COUNT(*)::int AS n FROM plus_purchases WHERE created_at >= NOW()-INTERVAL '30 days'")
  ]);
  return `وضعیت بخش پرداختی‌ها\n\nفعال: ${enabled === 'true' ? 'بله' : 'خیر'}\nقیمت مانوکوین: ${price}\nدرگاه‌ها: ${gateways}\nولت‌ها: ${wallets}\nشماره کارت‌ها: ${cards}\nخریدهای ثبت‌شده در ۳۰ روز اخیر: ${plus.rows[0].n}`;
}
async function adminBanUser(client, targetId, seconds) {
  const result = await client.query('SELECT partner_id FROM users WHERE telegram_id=$1', [targetId]);
  const partnerId = result.rows[0]?.partner_id ? Number(result.rows[0].partner_id) : null;
  await client.query('BEGIN');
  try {
    await client.query("UPDATE users SET banned_until=NOW()+($2 || ' seconds')::interval,ban_reason='admin',status='idle',partner_id=NULL,conversation_started_at=NULL,action_state=NULL,updated_at=NOW() WHERE telegram_id=$1", [targetId, String(seconds)]);
    if (partnerId) await client.query("UPDATE users SET status='idle',partner_id=NULL,conversation_started_at=NULL,action_state=NULL,updated_at=NOW() WHERE telegram_id=$1", [partnerId]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  if (partnerId) { try { await send(partnerId, 'مکالمه به دلیل تغییر وضعیت طرف مقابل پایان یافت.', mainKeyboard(await settings(client))); } catch {} }
  return partnerId;
}
function bannedListKeyboard() { return replyKeyboard([['بازگشت کنترل کاربران'], ['بازگشت پنل']], true); }
async function bannedListText(client) {
  const banned = await client.query("SELECT telegram_id,ban_reason,banned_until FROM users WHERE banned_until IS NOT NULL AND banned_until > NOW() ORDER BY banned_until DESC LIMIT 50");
  return `لیست بن‌شده‌ها\n\n${banned.rows.map(x => `${x.telegram_id} — تا ${iranDate(x.banned_until)}${x.ban_reason ? ` — ${x.ban_reason}` : ''}`).join('\n') || 'لیست خالی است.'}`;
}
async function blockedListRows(client, blockerId) {
  const result = await client.query(`SELECT ab.user_low, ab.user_high, ab.expires_at, ab.blocker_id,
      low.username AS low_username, high.username AS high_username
    FROM anonymous_blocks ab
    JOIN users low ON low.telegram_id=ab.user_low
    JOIN users high ON high.telegram_id=ab.user_high
    WHERE ab.expires_at > NOW() AND ab.blocker_id=$1
    ORDER BY ab.expires_at DESC LIMIT 100`, [blockerId]);
  return result.rows;
}
function blockedListText(rows) {
  if (!rows.length) return 'لیست بلاکی‌ها\n\nمورد فعالی ثبت نشده است.';
  return `لیست بلاکی‌ها\n\n${rows.map((x, i) => `${i + 1}) ${x.user_low_username ? '@' + x.user_low_username : 'بدون آیدی نمایشی'} (${x.user_low}) ↔ ${x.high_username ? '@' + x.high_username : 'بدون آیدی نمایشی'} (${x.user_high})\nعدم اتصال تا: ${iranDate(x.expires_at)}`).join('\n\n')}`;
}
function blockedListKeyboard(rows) {
  const buttons = rows.map(x => [{ text: `رفع بلاک ${x.user_low} ↔ ${x.user_high}`, callback_data: `admin:block:unblock:${x.user_low}:${x.user_high}` }]);
  buttons.push([{ text: 'بازگشت کنترل کاربران', callback_data: 'admin:block:back' }]);
  return { reply_markup: { inline_keyboard: buttons } };
}
async function sendBlockedList(client, id, prefix = '') {
  const rows = await blockedListRows(client, id);
  return send(id, `${prefix}${blockedListText(rows)}`, blockedListKeyboard(rows));
}
async function audit(client, adminId, targetId, action, details = {}) {
  await client.query('INSERT INTO admin_audit_log(admin_id,target_user_id,action,details) VALUES ($1,$2,$3,$4)', [adminId, targetId || null, action, JSON.stringify(details)]);
}
async function adminUserPanel(client, viewerId, targetId) {
  const result = await client.query('SELECT * FROM users WHERE telegram_id=$1', [targetId]);
  if (!result.rows[0]) return { text: 'کاربری با این آیدی پیدا نشد.', markup: userControlKeyboard() };
  const u = result.rows[0];
  const metrics = (await client.query('SELECT * FROM chat_metrics WHERE user_id=$1', [targetId])).rows[0] || {};
  const purchase = await client.query('SELECT COALESCE(SUM(price),0)::int AS total, MAX(created_at) AS last FROM plus_purchases WHERE telegram_id=$1', [targetId]);
  const blockedByUser = await client.query('SELECT COUNT(*)::int AS n FROM anonymous_blocks WHERE user_low=$1 OR user_high=$1', [targetId]);
  const blockedUser = await client.query('SELECT COUNT(*)::int AS n FROM reports WHERE target_id=$1 AND reason ILIKE \'%block%\'', [targetId]);
  await audit(client, viewerId, targetId, 'view_user_panel');
  return { text: adminUserSummary(u, metrics, { totalPurchase: purchase.rows[0]?.total || 0, lastPurchase: purchase.rows[0]?.last ? iranDate(purchase.rows[0].last) : 'ندارد', membershipTime: iranDate(u.created_at), lastActivity: u.last_action_at ? iranDate(u.last_action_at) : '-', isPlus: isPlus(u, targetId), plusRemaining: isPlus(u, targetId) ? iranDate(u.plus_expires_at) : 'ندارد', blockedByUser: blockedByUser.rows[0]?.n || 0, blockedUser: blockedUser.rows[0]?.n || 0 }), markup: userActionsInlineKeyboard(targetId, u.banned_until && new Date(u.banned_until).getTime() > Date.now()) };
}
async function openAdminUserPanel(viewerId, targetId) {
  const client = await pool.connect();
  try {
    const identifier = String(targetId).replace(/^@/, ''); const resolved = (await client.query('SELECT telegram_id FROM users WHERE telegram_id::text=$1 OR lower(username)=lower($2) LIMIT 1', [identifier, identifier])).rows[0]?.telegram_id;
    const panel = await adminUserPanel(client, viewerId, resolved || targetId);
    await updateAction(client, viewerId, `admin:user_control:${resolved || targetId}`);
    return send(viewerId, panel.text, panel.markup);
  } finally { client.release(); }
}
async function giftRows(client) {
  await client.query('DELETE FROM gift_codes WHERE expires_at IS NOT NULL AND expires_at <= NOW()');
  const result = await client.query("SELECT code,command_name,gift_type,discount_percent,coins,plus_days,uses,max_uses,expires_at,created_at FROM gift_codes ORDER BY created_at DESC LIMIT 50");
  return result.rows;
}
function giftStatus(row) {
  if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) return 'منقضی';
  if (row.max_uses !== null && Number(row.uses) >= Number(row.max_uses)) return 'تمام‌شده';
  return 'فعال';
}
function giftListText(rows) {
  if (!rows.length) return 'کد هدیه‌ای ساخته نشده است.';
  return `کدهای هدیه\n\n${rows.map(row => `🎁 /${row.command_name || row.code}\nوضعیت: ${giftStatus(row)} | نوع: ${row.gift_type === 'discount' ? `${row.discount_percent}% تخفیف` : row.coins ? `${row.coins} کوین` : `${row.plus_days} روز پلاس`} | استفاده: ${row.uses}${row.max_uses ? `/${row.max_uses}` : '/∞'}${row.expires_at ? `\nانقضا: ${iranDate(row.expires_at)}` : ''}`).join('\n\n')}`;
}
function giftListMarkup(rows) { return { reply_markup: { inline_keyboard: rows.map(row => [{ text: `🎁 ${row.code} — ${giftStatus(row)}`, callback_data: `gift:view:${row.code}` }]) } }; }
async function sendGiftManagement(client, id) {
  const rows = await giftRows(client);
  await send(id, giftListText(rows), giftManagementKeyboard());
  if (rows.length) return send(id, 'برای مدیریت هر کد، دکمهٔ همان کد را انتخاب کن.', giftListMarkup(rows));
}
function dailyCoinKeyboard() { return replyKeyboard([['مقدار دیلی کوین'], ['دستور / دار دیلی کوین'], ['زمان ریست دیلی کوین'], ['برگشت']], true); }
async function redeemGift(client, id, code) {
  const normalized = String(code || '').trim().toUpperCase(); if (!normalized) return send(id, 'کد هدیه را بعد از دستور وارد کن؛ مثال: /gift MG-ABC123.');
  await client.query('BEGIN');
  try {
    const row = (await client.query('SELECT * FROM gift_codes WHERE upper(code)=upper($1) OR upper(command_name)=upper($1) FOR UPDATE', [normalized])).rows[0];
    if (!row || (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) || (row.max_uses !== null && Number(row.uses) >= Number(row.max_uses))) { await client.query('ROLLBACK'); return send(id, 'این کد هدیه منقضی شده، ظرفیتش تکمیل شده یا وجود ندارد.'); }
    const already = await client.query('SELECT 1 FROM gift_code_redemptions WHERE code=$1 AND user_id=$2', [row.code, id]); if (already.rowCount) { await client.query('ROLLBACK'); return send(id, 'این کد هدیه را قبلاً استفاده کرده‌ای.'); }
    await client.query('INSERT INTO gift_code_redemptions(code,user_id) VALUES ($1,$2)', [row.code, id]); await client.query('UPDATE gift_codes SET uses=uses+1 WHERE code=$1', [row.code]);
    await client.query('UPDATE users SET coins=coins+$2, plus_expires_at=CASE WHEN $3::int > 0 THEN GREATEST(COALESCE(plus_expires_at,NOW()),NOW()) + ($3 || \' days\')::interval ELSE plus_expires_at END, discount_percent=CASE WHEN $4::int > 0 THEN $4 ELSE discount_percent END, discount_code=CASE WHEN $4::int > 0 THEN $5 ELSE discount_code END,updated_at=NOW() WHERE telegram_id=$1', [id, row.coins, row.plus_days, row.discount_percent || 0, row.command_name || row.code]); await client.query('COMMIT');
    return send(id, row.gift_type === 'discount' ? `کد تخفیف فعال شد: ${row.discount_percent}% برای خریدهای بعدی.` : `کد هدیه با موفقیت استفاده شد.\nمانو کوین: +${row.coins}\nمانو پلاس: +${row.plus_days} روز`);
  } catch (error) { await client.query('ROLLBACK'); throw error; }
}
async function claimDailyCoins(client, id, callbackQuery = null) {
  const amount = Number(await botSettingValue(client, 'daily_coin_amount', '20')); const reset = parseDuration(await botSettingValue(client, 'daily_coin_reset', '24H')) || 86400;
  const result = await client.query(`INSERT INTO daily_coin_claims(user_id,claimed_at) VALUES ($1,NOW()) ON CONFLICT (user_id) DO UPDATE SET claimed_at=NOW() WHERE daily_coin_claims.claimed_at <= NOW() - ($2 || ' seconds')::interval RETURNING user_id`, [id, String(reset)]);
  let text = 'دیلی کوین امروز را قبلاً گرفته‌ای.';
  if (result.rowCount) { await client.query('UPDATE users SET coins=coins+$2,updated_at=NOW() WHERE telegram_id=$1', [id, amount]); text = `دیلی کوین دریافت شد: +${amount} مانو کوین`; }
  if (callbackQuery) return editAudienceCallback(callbackQuery, id, text, { reply_markup: { inline_keyboard: [] } });
  return send(id, text);
}

async function botSettingValue(client, key, fallback = '') { const r = await client.query('SELECT value FROM bot_settings WHERE key=$1', [key]); return r.rows[0]?.value ?? fallback; }
async function saveBotSetting(client, key, value) { await client.query('INSERT INTO bot_settings(key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()', [key, value]); }
function permissionText(value) { let p; try { p = { ...DEFAULT_CHAT_PERMISSIONS, ...(JSON.parse(value || '{}')) }; } catch { p = DEFAULT_CHAT_PERMISSIONS; } return `مجوزهای چت\n\n${permissionKeyboard(p).map(x => `${x.label}`).join('\n')}`; }
async function broadcastText(client, text, senderId) {
  const users = await client.query('SELECT telegram_id FROM users');
  let sent = 0;
  for (const row of users.rows) {
    try { await send(row.telegram_id, text); sent += 1; } catch { /* حساب‌های مسدودشده رد می‌شوند */ }
  }
  await send(senderId, `ارسال همگانی تمام شد.\nموفق: ${sent}\nکل هدف‌ها: ${users.rowCount}`, adminMainKeyboard());
}

async function updateAction(client, id, action) { await client.query('UPDATE users SET action_state=$2, updated_at=NOW() WHERE telegram_id=$1', [id, action]); }

async function findPair(id, preference) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const me = await ensureUser(client, id);
    if (me.status === 'chatting' && me.partner_id) { await client.query('COMMIT'); return { kind: 'already_chatting', partnerId: Number(me.partner_id) }; }
    if (!['male', 'female'].includes(me.gender)) { await client.query('COMMIT'); return { kind: 'missing_gender' }; }
    if (!['male', 'female', 'any'].includes(preference)) { await client.query('COMMIT'); return { kind: 'invalid_preference' }; }
    const costRow = (await client.query('SELECT value FROM bot_settings WHERE key=$1', [`chat_cost_${preference}`])).rows[0]; const connectionCost = Number(costRow?.value || 0);
    if (!isAdmin(id) && Number(me.coins || 0) < connectionCost) { await client.query('COMMIT'); return { kind: 'insufficient_coins', cost: connectionCost }; }
    // Serialize queue searches so two simultaneous searches do not each skip the other's locked row.
    await client.query('SELECT pg_advisory_xact_lock(20260925, 1)');
    await client.query('SELECT telegram_id FROM users WHERE telegram_id=$1 FOR UPDATE', [id]);
    await client.query('UPDATE users SET match_preference=$2, updated_at=NOW() WHERE telegram_id=$1', [id, preference]);
    const candidate = await client.query(`
      SELECT candidate.telegram_id, candidate.gender, candidate.match_preference, candidate.coins FROM users AS candidate
      WHERE candidate.status='waiting' AND candidate.telegram_id<>$1
        AND candidate.gender IN ('male','female')
        AND (candidate.banned_until IS NULL OR candidate.banned_until <= NOW())
        AND ($2='any' OR candidate.gender=$2)
        AND (COALESCE(candidate.match_preference, 'any')='any' OR candidate.match_preference=$3)
        AND NOT EXISTS (
          SELECT 1 FROM anonymous_blocks AS ab
          WHERE ab.expires_at > NOW()
            AND ((ab.user_low = LEAST($1::bigint, candidate.telegram_id) AND ab.user_high = GREATEST($1::bigint, candidate.telegram_id)))
        )
      ORDER BY
        CASE WHEN $2='any' AND COALESCE(candidate.match_preference, 'any')=$3 THEN 0 ELSE 1 END ASC,
        CASE WHEN $2='any' THEN random() ELSE 0 END,
        candidate.updated_at ASC
      LIMIT 1 FOR UPDATE`, [id, preference, me.gender]);
    if (!candidate.rows[0]) {
      await client.query("UPDATE users SET status='waiting', match_preference=$2, partner_id=NULL, action_state=NULL, updated_at=NOW() WHERE telegram_id=$1", [id, preference]);
      await client.query('COMMIT');
      return { kind: 'waiting' };
    }
    const other = Number(candidate.rows[0].telegram_id);
    const otherCostRow = (await client.query('SELECT value FROM bot_settings WHERE key=$1', [`chat_cost_${candidate.rows[0].match_preference || 'any'}`])).rows[0]; const otherCost = Number(otherCostRow?.value || 0);
    if (!isAdmin(other) && Number(candidate.rows[0].coins || 0) < otherCost) { await client.query("UPDATE users SET status='waiting', partner_id=NULL, updated_at=NOW() WHERE telegram_id=$1", [id]); await client.query('COMMIT'); return { kind: 'waiting' }; }
    await client.query("UPDATE users SET status='chatting', partner_id=$2, conversation_started_at=NOW(), action_state=NULL, updated_at=NOW() WHERE telegram_id=$1", [id, other]);
    await client.query("UPDATE users SET status='chatting', partner_id=$2, conversation_started_at=NOW(), action_state=NULL, updated_at=NOW() WHERE telegram_id=$1", [other, id]);
    await client.query('COMMIT');
    return { kind: 'paired', partnerId: other };
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
async function chargeSuccessfulConnection(userIds) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const costs = Object.fromEntries((await client.query("SELECT key,value FROM bot_settings WHERE key IN ('chat_cost_any','chat_cost_male','chat_cost_female')")).rows.map(row => [row.key, Number(row.value) || 0]));
    for (const userId of userIds.filter(Boolean)) {
      if (isAdmin(userId)) continue;
      const row = (await client.query('SELECT match_preference FROM users WHERE telegram_id=$1 FOR UPDATE', [userId])).rows[0]; const cost = costs[`chat_cost_${row?.match_preference || 'any'}`] || 0;
      if (cost > 0) await client.query('UPDATE users SET coins=GREATEST(0,coins-$2),updated_at=NOW() WHERE telegram_id=$1', [userId, cost]);
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
async function searchByPreference(id, preference, s) {
  if (!['male', 'female', 'any'].includes(preference)) return send(id, screenText(publicAppearance(s), 'preference', 'یکی از سه گزینهٔ پسر، دختر یا مهم نیست را انتخاب کن.'), preferenceKeyboard(s));
  const result = await findPair(id, preference);
  if (result.kind === 'missing_gender') {
    await pool.query('UPDATE users SET action_state=$2, updated_at=NOW() WHERE telegram_id=$1', [id, `choose_gender_for:${preference}`]);
    return send(id, screenText(publicAppearance(s), 'gender', OWN_GENDER_PROMPT), genderKeyboard(s));
  }
  if (result.kind === 'already_chatting') return send(id, 'هنوز در یک مکالمه هستی.', chatKeyboard(s, isAdmin(id)));
  if (result.kind === 'insufficient_coins') return send(id, `برای این اتصال حداقل ${result.cost} مانو کوین لازم داری. ابتدا موجودی‌ات را افزایش بده.`, mainKeyboard(s));
  if (result.kind === 'paired') {
    await chargeSuccessfulConnection([id, result.partnerId]);
    await sendConnectionNotice(id, s, chatKeyboard(s, isAdmin(id)));
    await sendConnectionNotice(result.partnerId, s, chatKeyboard(s, isAdmin(result.partnerId)));
    return;
  }
  return send(id, appearanceFeedback(publicAppearance(s), 'waiting', 'در صف انتظار قرار گرفتی؛ هنوز کسی با این انتخاب پیدا نشده است. به‌محض اتصال خبرت می‌دهم.'), waitingKeyboard(s));
}
async function sendConnectionNotice(id, s, keyboard) {
  const c = await pool.connect();
  try {
    const me = await user(c, id); const exempt = isPlus(me, id) || isAdmin(id) || isOwner(id);
    return send(id, appearanceFeedback(publicAppearance(s), 'connected', 'اتصال برقرار شد؛ گفت‌وگو را شروع کن.'), keyboard);
  } finally { c.release(); }
}
async function leaveWaiting(id) { await pool.query("UPDATE users SET status='idle', partner_id=NULL, action_state=NULL, updated_at=NOW() WHERE telegram_id=$1 AND status='waiting'", [id]); }
async function disconnect(id) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const me = await user(client, id); const partnerId = me?.partner_id ? Number(me.partner_id) : null;
    if (me?.conversation_started_at) {
      const seconds = Math.max(0, Math.floor((Date.now() - new Date(me.conversation_started_at).getTime()) / 1000));
      for (const metricUser of [id, partnerId].filter(Boolean)) await client.query(`INSERT INTO chat_metrics(user_id,total_chat_seconds,total_chats,longest_chat_seconds,first_seen_at,last_seen_at) VALUES ($1,$2,1,$2,NOW(),NOW()) ON CONFLICT (user_id) DO UPDATE SET total_chat_seconds=chat_metrics.total_chat_seconds+$2,total_chats=chat_metrics.total_chats+1,longest_chat_seconds=GREATEST(chat_metrics.longest_chat_seconds,$2),last_seen_at=NOW()`, [metricUser, seconds]);
    }
    if (partnerId) await client.query("UPDATE users SET status='idle', partner_id=NULL, last_partner_id=$3, conversation_started_at=NULL, action_state=NULL, updated_at=NOW() WHERE telegram_id IN ($1,$2)", [id, partnerId, partnerId]);
    else await client.query("UPDATE users SET status='idle', partner_id=NULL, conversation_started_at=NULL, action_state=NULL, updated_at=NOW() WHERE telegram_id=$1", [id]);
    await client.query('COMMIT'); return partnerId;
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
async function block(id, targetId, reason) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const configured = await botSettingValue(client, 'block_duration', '7D');
    const seconds = parseDuration(configured) || 7 * 86400;
    await client.query(
      `INSERT INTO anonymous_blocks (user_low, user_high, expires_at, blocker_id)
       VALUES (LEAST($1::bigint,$2::bigint), GREATEST($1::bigint,$2::bigint), NOW() + ($3 || ' seconds')::interval, $1)
       ON CONFLICT (user_low, user_high) DO UPDATE SET created_at=NOW(), expires_at=NOW() + ($3 || ' seconds')::interval, blocker_id=$1`,
      [id, targetId, String(seconds)]
    );
    await client.query('INSERT INTO reports (reporter_id, target_id, reason) VALUES ($1,$2,$3)', [id, targetId, reason]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

async function botUsername() {
  if (process.env.BOT_USERNAME) return process.env.BOT_USERNAME.replace(/^@/, '');
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return null;
  const result = await telegram('getMe', {});
  return result?.username || null;
}
async function referralCode(client, id) {
  const existing = await client.query('SELECT referral_code FROM users WHERE telegram_id=$1', [id]);
  if (existing.rows[0]?.referral_code) return existing.rows[0].referral_code;
  for (let i = 0; i < 3; i += 1) {
    const code = crypto.randomBytes(8).toString('base64url');
    try {
      const r = await client.query('UPDATE users SET referral_code=$2 WHERE telegram_id=$1 AND referral_code IS NULL RETURNING referral_code', [id, code]);
      if (r.rows[0]) return code;
    } catch (error) { if (i === 2) throw error; }
  }
  return null;
}
async function rewardFirstEntry(id, ownerId, reward, s) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const first = await client.query('UPDATE users SET start_completed=TRUE WHERE telegram_id=$1 AND start_completed=FALSE RETURNING telegram_id', [id]);
    if (!first.rowCount) { await client.query('COMMIT'); return false; }
    await client.query('UPDATE users SET coins=coins+20 WHERE telegram_id=$1', [id]);
    if (ownerId && Number(ownerId) !== Number(id)) {
      const owner = await client.query('UPDATE users SET coins=coins+$2 WHERE telegram_id=$1 RETURNING telegram_id', [ownerId, reward]);
      await client.query('UPDATE users SET referred_by=$2 WHERE telegram_id=$1', [id, ownerId]);
      await client.query('COMMIT');
      if (owner.rowCount) await send(Number(ownerId), `🎁 یک عضو جدید با لینک شما وارد شد و ${reward} مانو کوین هدیه گرفتی.`, mainKeyboard(s));
      return true;
    }
    await client.query('COMMIT');
    return true;
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
async function sendIncreaseCoins(id, settings) {
  return send(id, 'افزایش مانو کوین\n\nخرید مانو کوین در حال حاضر غیرفعال است. برای دریافت رایگان مانو کوین، گزینهٔ زیر را انتخاب کن.', increaseCoinsKeyboard(settings));
}
async function sendFreeCoins(id, settings) {
  const client = await pool.connect();
  try {
    const code = await referralCode(client, id); const username = await botUsername();
    if (!code || !username) return send(id, 'ساخت لینک اختصاصی موقتاً ممکن نیست؛ دوباره تلاش کن.', increaseCoinsKeyboard(settings));
    const url = `https://t.me/${username}?start=ref_${code}`;
    const text = `🔗 لینک اختصاصی شما:\n${url}\n\n🎁 متن پیشنهادی جذب کاربر:\nبا لینک اختصاصی من وارد ربات چت ناشناس شو و دوست‌های جدید پیدا کن!\n\nاگر کاربر جدیدی که قبلاً از ربات استفاده نکرده از این لینک وارد شود، ۵ مانو کوین رایگان می‌گیری. ورود از لینک ناشناس هم برای صاحب لینک ۳ مانو کوین هدیه دارد.\n\nهر کاربر جدید فقط یک‌بار برای ورود اول، ۲۰ مانو کوین هدیه می‌گیرد.`;
    return sendLink(id, text, increaseCoinsKeyboard(settings));
  } finally { client.release(); }
}
async function sendPlus(id, settings) {
  const text = `✨ اکانت پلاس\n\nبا اکانت پلاس:\n۱) تبلیغات مزاحم برایت نمایش داده نمی‌شود.\n۲) سریع‌تر به چت وصل می‌شوی.\n۳) نشان مخصوص پلاس در چت نمایش داده می‌شود.\n۴) می‌توانی نشان پلاس را تغییر بدهی.\n۵) از مزایای آیندهٔ کاربران پلاس بهره‌مند می‌شوی.\n\n💰 قیمت‌ها:\nپلاس ۱ ماهه ۱۰۰ مانو کوین\nپلاس ۳ ماهه ۲۵۰ مانو کوین\nپلاس ۶ ماهه ۴۵۰ مانو کوین\nپلاس ۱۲ ماهه ۸۰۰ مانو کوین`;
  return send(id, text, plusPurchaseKeyboard());
}
async function handlePlusCallback(id, data, client, s) {
  const me = await user(client, id);
  const match = data.match(/^plus:buy:(1|3|6|12)$/);
  if (match) {
    const months = Number(match[1]); const price = PLUS_PRICES[months]; const discount = Math.max(0, Math.min(100, Number(me.discount_percent || 0))); const finalPrice = Math.ceil(price * (100 - discount) / 100);
    await updateAction(client, id, `plus_confirm:${months}`);
    return send(id, `موجودی مانو کوین: ${Number(me.coins || 0)}\nمحصول: پلاس ${months} ماهه\nقیمت اصلی: ${price} مانو کوین${discount ? `\nتخفیف: ${discount}%\nقیمت نهایی: ${finalPrice} مانو کوین` : ''}\n\nخرید را تایید می‌کنید؟`, plusConfirmKeyboard());
  }
  if (data === 'plus:cancel') { await updateAction(client, id, null); return sendPlus(id, s); }
  if (data === 'plus:confirm') {
    const months = Number(String(me.action_state || '').split(':')[1]); const price = PLUS_PRICES[months];
    if (!price) return sendPlus(id, s);
    const tx = await pool.connect();
    try {
      await tx.query('BEGIN');
      const locked = await tx.query('SELECT coins, plus_expires_at, discount_percent, discount_code FROM users WHERE telegram_id=$1 FOR UPDATE', [id]);
      const row = locked.rows[0]; const discount = Math.max(0, Math.min(100, Number(row?.discount_percent || 0))); const finalPrice = Math.ceil(price * (100 - discount) / 100);
      if (!row || Number(row.coins) < finalPrice) { await tx.query('ROLLBACK'); await updateAction(client, id, null); return send(id, `موجودی مانو کوین شما برای این خرید کافی نیست. مبلغ لازم: ${finalPrice}`, plusPurchaseKeyboard()); }
      const base = row.plus_expires_at && new Date(row.plus_expires_at).getTime() > Date.now() ? new Date(row.plus_expires_at) : new Date();
      base.setUTCMonth(base.getUTCMonth() + months);
      await tx.query('UPDATE users SET coins=coins-$2, plus_expires_at=$3, discount_percent=0, discount_code=NULL, plus_emoji=COALESCE(NULLIF(plus_emoji, \'\'), \'✨\'), action_state=NULL, updated_at=NOW() WHERE telegram_id=$1', [id, finalPrice, base]);
      await tx.query('INSERT INTO plus_purchases(telegram_id, months, price) VALUES ($1,$2,$3)', [id, months, finalPrice]);
      await tx.query('COMMIT');
      return send(id, `🎉 تبریک! خرید پلاس ${months} ماهه با موفقیت انجام شد.\nمبلغ پرداخت‌شده: ${finalPrice} مانو کوین${discount ? `\nتخفیف اعمال‌شده: ${discount}%` : ''}\nاکانت شما به مدت ${months} ماه پلاس شد.`, plusKeyboard(s));
    } catch (error) { await tx.query('ROLLBACK'); throw error; } finally { tx.release(); }
  }
  return false;
}
async function handlePremiumVerification(viewerId, data, client) {
  const match = data.match(/^premium:verify:(plus|admin|owner):(\d+)$/);
  if (!match) return false;
  const expectedRole = match[1];
  const targetId = Number(match[2]);
  const target = await user(client, targetId);
  const actualRole = target ? premiumRole(target, targetId) : null;
  if (!actualRole || actualRole !== expectedRole) return send(viewerId, 'این نشان پلاس دیگر معتبر نیست یا وضعیت کاربر تغییر کرده است.');
  const label = expectedRole === 'owner' ? 'مالک ربات' : expectedRole === 'admin' ? 'ادمین ربات' : 'کاربر Plus';
  return send(viewerId, `✅ تأیید ربات\nاین حساب، ${label} است و نشان آن معتبر است.`);
}
async function handlePremiumRoleCommand(viewerId, command) {
  const expectedRole = command.slice(1);
  if (!['plus', 'admin', 'owner'].includes(expectedRole)) return false;
  const client = await pool.connect();
  try {
    const viewer = await user(client, viewerId);
    const targetId = viewer?.status === 'chatting' && viewer.partner_id ? Number(viewer.partner_id) : null;
    if (!targetId) return send(viewerId, 'این کد فقط داخل یک مکالمهٔ فعال قابل بررسی است.');
    const target = await user(client, targetId);
    const actualRole = target ? premiumRole(target, targetId) : null;
    if (!actualRole || actualRole !== expectedRole) return send(viewerId, `❌ تأیید نشد\nاین حساب ${expectedRole === 'plus' ? 'Plus' : expectedRole === 'admin' ? 'ادمین' : 'مالک'} نیست.`);
    const label = expectedRole === 'owner' ? 'مالک ربات' : expectedRole === 'admin' ? 'ادمین ربات' : 'کاربر Plus';
    return send(viewerId, `✅ تأیید ربات\nاین حساب، ${label} است و نشان آن معتبر است.`);
  } finally { client.release(); }
}
async function handleStart(id, payload = null) {
  const client = await pool.connect(); let released = false; try {
    const me = await ensureUser(client, id); const s = await settings(client);
    if (payload !== null) await recordMandatoryStart(id, payload, client, me);
    if (!isAdmin(id)) {
      const missing = await mandatoryRequirements(id, client, { profile: me });
      if (missing.length) return send(id, mandatoryJoinMessage(missing, s), mandatoryJoinMarkup(missing, s, id));
    }
    if (payload !== null) {
      if (me.status !== 'idle' || (me.action_state && me.action_state !== 'anon_done')) {
        return send(id, 'برای باز کردن لینک، ابتدا عملیات یا گفت‌وگوی فعلی را تمام کن.', mainKeyboard(s));
      }
      if (payload.startsWith('ref_')) {
        const found = await client.query('SELECT telegram_id FROM users WHERE referral_code=$1', [payload.slice(4)]);
        if (!found.rows[0]) return send(id, 'این لینک دعوت معتبر نیست.', mainKeyboard(s));
        const first = await rewardFirstEntry(id, Number(found.rows[0].telegram_id), 5, s);
        return send(id, first ? '🎁 خوش آمدی! ۲۰ مانو کوین هدیهٔ ورود اول به حسابت اضافه شد.' : 'خوش آمدی!', mainKeyboard(s));
      }
      client.release();
      released = true;
      const started = await flowFor(s).handleStartPayload(id, payload);
      if (!started) return send(id, 'این لینک ناشناس معتبر نیست یا دیگر در دسترس نیست.', mainKeyboard(s));
      return;
    }
    if (me.status === 'waiting') return send(id, 'وضعیت فعلی: در صف انتظار هستی. به‌محض پیدا شدن فرد سازگار خبر می‌دهم.', waitingKeyboard(s));
    if (me.status === 'chatting') return send(id, 'وضعیت فعلی: به یک ناشناس وصل هستی و مکالمه برقرار است.', chatKeyboard(s));
    const first = await rewardFirstEntry(id, null, 0, s);
    return send(id, first ? `${publicAppearance(s).message}\n\n🎁 برای ورود اول، ۲۰ مانو کوین هدیه گرفتی.` : publicAppearance(s).message, mainKeyboard(s));
  } finally { if (!released) client.release(); }
}

async function handleConnect(id) {
  const client = await pool.connect(); try {
    const me = await ensureUser(client, id); const s = await settings(client);
    if (!isAdmin(id)) {
      const missing = await mandatoryRequirements(id, client, { profile: me });
      if (missing.length) return send(id, mandatoryJoinMessage(missing, s), mandatoryJoinMarkup(missing, s, id));
    }
    if (!s.bot_enabled && !isAdmin(id)) return send(id, 'ربات موقتاً خاموش است.');
    if (me.status === 'chatting') return send(id, 'وضعیت فعلی: به یک ناشناس وصل هستی و مکالمه برقرار است.', chatKeyboard(s));
    await updateAction(client, id, 'choose_preference'); return send(id, screenText(publicAppearance(s), 'preference', appearanceFeedback(publicAppearance(s), 'connect_prompt', 'دوست داری به چه کسی وصل شوی؟')), preferenceKeyboard(s));
  } finally { client.release(); }
}

async function handleMandatoryTrackingCallback(id, data) {
  if (!isAdmin(id)) return send(id, 'این دکمه فقط برای مدیران ربات فعال است.');
  const [, action, encoded] = String(data).split(':');
  const trackingCode = decodeTrackingCode(encoded);
  if (!trackingCode) return send(id, 'کد پیگیری این دکمه معتبر نیست.');
  const client = await pool.connect();
  try {
    let source = await getMandatorySourceDetails(client, { trackingCode });
    if (!source) return send(id, 'سفارشی با این کد پیگیری پیدا نشد.');
    if (action === 'details') {
      const admin = await user(client, id);
      if (admin?.action_state?.startsWith('mandatory:tracking_schedule_at:')) await updateAction(client, id, null);
      return sendMandatoryTrackingDetails(client, id, { trackingCode });
    }
    if (action === 'schedule') {
      if (source.status !== 'scheduled') return send(id, 'فقط موردی که در صف یا زمان‌بندی است را می‌توان زمان‌بندی کرد.', mandatorySourceKeyboard(source));
      await updateAction(client, id, `mandatory:tracking_schedule_at:${encodeState(trackingCode)}`);
      return send(id, 'زمان جدید را با قالب 1405/6/10-17:10 بفرست.', mandatorySourceKeyboard(source));
    }

    let updated;
    if (action === 'activate' && ['scheduled', 'paused'].includes(source.status)) {
      updated = await client.query("UPDATE mandatory_sources SET status='active',started_at=CASE WHEN status='paused' AND paused_at IS NOT NULL THEN COALESCE(started_at,NOW()) + (NOW()-paused_at) ELSE COALESCE(started_at,NOW()) END,paused_at=NULL,updated_at=NOW() WHERE id=$1 AND status=$2 RETURNING *", [source.id, source.status]);
      if (updated.rowCount) {
        await client.query('DELETE FROM mandatory_source_queue WHERE source_id=$1', [source.id]);
        await recordMandatorySourceHistory(client, updated.rows[0], source.status === 'paused' ? 'resumed' : 'started', { fromStatus: source.status === 'scheduled' && source.queue_position ? 'queued' : source.status, toStatus: 'active', details: { note: 'با دکمهٔ کنترل پیگیری فعال شد.' }, notifyAdmin: source.status !== 'paused' });
      }
    } else if (action === 'pause' && source.status === 'active') {
      updated = await client.query("UPDATE mandatory_sources SET status='paused',paused_at=NOW(),updated_at=NOW() WHERE id=$1 AND status='active' RETURNING *", [source.id]);
      if (updated.rowCount) await recordMandatorySourceHistory(client, updated.rows[0], 'paused', { fromStatus: 'active', toStatus: 'paused', details: { note: 'منبع موقتاً متوقف شد.' } });
    } else if (action === 'resume' && source.status === 'paused') {
      updated = await client.query("UPDATE mandatory_sources SET status='active',started_at=CASE WHEN paused_at IS NOT NULL THEN COALESCE(started_at,NOW()) + (NOW()-paused_at) ELSE COALESCE(started_at,NOW()) END,paused_at=NULL,updated_at=NOW() WHERE id=$1 AND status='paused' RETURNING *", [source.id]);
      if (updated.rowCount) await recordMandatorySourceHistory(client, updated.rows[0], 'resumed', { fromStatus: 'paused', toStatus: 'active', details: { note: 'منبع دوباره فعال شد.' } });
    } else if (action === 'cancel' && ['scheduled', 'active', 'paused'].includes(source.status)) {
      updated = await client.query("UPDATE mandatory_sources SET status='cancelled',updated_at=NOW() WHERE id=$1 AND status=$2 RETURNING *", [source.id, source.status]);
      if (updated.rowCount) {
        await client.query('DELETE FROM mandatory_source_queue WHERE source_id=$1', [source.id]);
        await recordMandatorySourceHistory(client, updated.rows[0], 'cancelled', { fromStatus: source.status === 'scheduled' && source.queue_position ? 'queued' : source.status, toStatus: 'cancelled', details: { note: 'از کنترل پیگیری لغو شد.' } });
      }
    } else {
      return sendMandatoryTrackingDetails(client, id, { trackingCode });
    }

    if (!updated?.rowCount) return send(id, 'وضعیت سفارش تغییر نکرد؛ جزئیات فعلی را بررسی کن.', mandatorySourceKeyboard(source));
    try { await syncMandatoryReport(client, source.id, telegram); }
    catch (error) { console.error('mandatory_report_sync_error', source.id, String(error?.message || error).slice(0, 200)); }
    await processMandatoryLifecycle(client, { telegramCall: telegram, sendAdmin: (chatId, text, markup) => send(chatId, text, markup) });
    return sendMandatoryTrackingDetails(client, id, { trackingCode });
  } finally { client.release(); }
}

async function handleCallback(id, data, callbackQuery = null) {
  if (data.startsWith('mandatory:audience:')) return handleMandatoryAudienceCallback(id, data, callbackQuery);
  if (data === 'mandatory:verify') {
    const c = await pool.connect();
    try {
      const profile = await user(c, id);
      const displaySettings = await settings(c);
      const missing = await mandatoryRequirements(id, c, { recordJoins: true, profile });
      if (missing.length) return send(id, mandatoryJoinMessage(missing, displaySettings), mandatoryJoinMarkup(missing, displaySettings, id));
      return send(id, '✅ عضویت شما در همهٔ منابع فعالِ مربوط به پروفایلت تأیید شد. حالا می‌توانی از ربات استفاده کنی.', mainKeyboard(displaySettings));
    } finally { c.release(); }
  }
  if (data.startsWith('mandatory:details:') || data.startsWith('mandatory:activate:') || data.startsWith('mandatory:schedule:') || data.startsWith('mandatory:pause:') || data.startsWith('mandatory:cancel:') || data.startsWith('mandatory:resume:')) return handleMandatoryTrackingCallback(id, data);
  if (data.startsWith('anon:')) {
    const c = await pool.connect();
    let s;
    try { s = await settings(c); } finally { c.release(); }
    return flowFor(s).handleCallback(id, data);
  }
  const sClient = await pool.connect();
  try {
    const me = await ensureUser(sClient, id); const s = await settings(sClient);
    if (isAdmin(id) && data.startsWith('beauty:')) return handleBeautyCallback(id, data, callbackQuery, sClient, s);
    if (data === 'profile:back') return editAudienceCallback(callbackQuery, id, publicAppearance(s).message, { reply_markup: { inline_keyboard: [] } });
    if (data === 'coins:daily') return claimDailyCoins(sClient, id, callbackQuery);
    if (data === 'coins:free') return sendFreeCoins(id, s);
    if (data === 'coins:gift') { await updateAction(sClient, id, 'coins:gift'); return editAudienceCallback(callbackQuery, id, 'کد هدیه را با یا بدون /gift بفرست.', { reply_markup: { inline_keyboard: [[{ text: 'بازگشت', callback_data: 'coins:back' }]] } }); }
    if (data === 'coins:buy') return editAudienceCallback(callbackQuery, id, 'خرید مانو کوین فعلاً توسط مدیر فعال نشده است. به‌زودی درگاه‌های پرداخت به این بخش اضافه می‌شود.', { reply_markup: { inline_keyboard: [[{ text: 'بازگشت', callback_data: 'coins:back' }]] } });
    if (data === 'coins:back') { await updateAction(sClient, id, null); return editAudienceCallback(callbackQuery, id, publicAppearance(s).message, { reply_markup: { inline_keyboard: [] } }); }
    if (data.startsWith('contact:view:')) return contactPanelFor(sClient, id, Number(data.split(':')[2]), callbackQuery);
    if (data.startsWith('contact:reply:')) { const messageId = Number(data.split(':')[2]); const row = (await sClient.query('SELECT recipient_id FROM contact_messages WHERE id=$1 AND recipient_id=$2', [messageId, id])).rows[0]; if (!row) return send(id, 'این پیام دیگر در دسترس نیست.'); await updateAction(sClient, id, `contact:reply:${messageId}`); return editAudienceCallback(callbackQuery, id, 'پاسخت را بنویس؛ پس از ارسال پیام جدید، اعلان بعدی با دکمه‌های پاسخ و بلاک نمایش داده می‌شود.', { reply_markup: { inline_keyboard: [] } }); }
    if (data.startsWith('contact:block:')) { const messageId = Number(data.split(':')[2]); const row = (await sClient.query('SELECT sender_id FROM contact_messages WHERE id=$1 AND recipient_id=$2', [messageId, id])).rows[0]; if (!row) return send(id, 'این پیام دیگر در دسترس نیست.'); return editAudienceCallback(callbackQuery, id, 'دلیل بلاک را انتخاب کن:', contactBlockReasonKeyboard(messageId)); }
    if (data.startsWith('contact:block_reason:')) { const [, , messageId, ...reasonParts] = data.split(':'); const reason = reasonParts.join(':'); const row = (await sClient.query('SELECT sender_id FROM contact_messages WHERE id=$1 AND recipient_id=$2', [Number(messageId), id])).rows[0]; if (!row) return send(id, 'این پیام دیگر در دسترس نیست.'); await block(id, row.sender_id, reason || 'مزاحمت در پیام خصوصی'); await sClient.query("UPDATE contact_messages SET status='blocked' WHERE id=$1", [Number(messageId)]); await updateAction(sClient, id, null); return editAudienceCallback(callbackQuery, id, 'کاربر بلاک شد و گزارش آن مانند بلاک مکالمه ثبت شد.', { reply_markup: { inline_keyboard: [] } }); }
    if (data === 'chatgift:type:coins') { if (me.status !== 'chatting' || !me.partner_id) return send(id, 'هدیه فقط در مکالمهٔ فعال قابل ارسال است.'); await updateAction(sClient, id, 'chatgift:coins:10'); return editAudienceCallback(callbackQuery, id, 'چه مقدار مانو کوین می‌خواهی هدیه بدهی؟', chatGiftCoinKeyboard(10)); }
    if (data === 'chatgift:type:plus') { if (me.status !== 'chatting' || !me.partner_id) return send(id, 'هدیه فقط در مکالمهٔ فعال قابل ارسال است.'); return editAudienceCallback(callbackQuery, id, 'چند ماه مانو پلاس هدیه بدهی؟', chatGiftPlusKeyboard()); }
    if (data === 'chatgift:back') { await updateAction(sClient, id, null); return send(id, 'مکالمه برقرار است.', chatKeyboard(s, isAdmin(id))); }
    if (data === 'chatgift:noop') return false;
    if (data.startsWith('chatgift:coin:')) { const delta = data.split(':')[2]; if (delta === 'custom') { await updateAction(sClient, id, 'chatgift:coin_custom'); return send(id, 'مقدار دلخواه را به‌صورت عدد مثبت بفرست.'); } const current = Number(String(me.action_state || '').split(':')[2]) || 10; const next = Math.max(1, current + Number(delta)); await updateAction(sClient, id, `chatgift:coins:${next}`); return editAudienceCallback(callbackQuery, id, 'چه مقدار مانو کوین می‌خواهی هدیه بدهی؟', chatGiftCoinKeyboard(next)); }
    if (data === 'chatgift:send') { const amount = Number(String(me.action_state || '').split(':')[2]); if (!amount || me.status !== 'chatting' || !me.partner_id) return send(id, 'مکالمهٔ فعال برای ارسال هدیه پیدا نشد.'); try { await sendChatGift(sClient, id, Number(me.partner_id), 'coins', amount); } catch (error) { return send(id, error.message === 'insufficient_coins' ? 'موجودی مانو کوینت برای این هدیه کافی نیست.' : 'ارسال هدیه انجام نشد.'); } await updateAction(sClient, id, null); return editAudienceCallback(callbackQuery, id, `هدیهٔ ${amount} مانو کوین ارسال شد.`, { reply_markup: { inline_keyboard: [] } }); }
    if (data.startsWith('chatgift:plus:')) { const months = Number(data.split(':')[2]); if (![1,3,6,12].includes(months) || me.status !== 'chatting' || !me.partner_id) return send(id, 'هدیهٔ پلاس قابل ارسال نیست.'); try { await sendChatGift(sClient, id, Number(me.partner_id), 'plus', months); } catch { return send(id, 'ارسال هدیه انجام نشد.'); } await updateAction(sClient, id, null); return editAudienceCallback(callbackQuery, id, `هدیهٔ ${months === 12 ? '۱ سال' : `${months} ماه`} مانو پلاس ارسال شد.`, { reply_markup: { inline_keyboard: [] } }); }
    if (isAdmin(id) && data === 'conversation:back') { await updateAction(sClient, id, 'admin:conversation_control'); return send(id, 'کنترل مکالمات کلی ربات', conversationControlKeyboard()); }
    if (isAdmin(id) && data.startsWith('conversation:permission:')) {
      const key = data.slice('conversation:permission:'.length); const current = JSON.parse(await botSettingValue(sClient, 'chat_permissions', JSON.stringify(DEFAULT_CHAT_PERMISSIONS)) || '{}');
      if (!Object.hasOwn(CHAT_PERMISSION_LABELS, key)) return send(id, 'مجوز نامعتبر است.');
      current[key] = current[key] === false; await saveBotSetting(sClient, 'chat_permissions', JSON.stringify({ ...DEFAULT_CHAT_PERMISSIONS, ...current }));
      return editAudienceCallback(callbackQuery, id, 'مجوزهای چت', permissionInlineKeyboard({ ...DEFAULT_CHAT_PERMISSIONS, ...current }));
    }
    if (isAdmin(id) && data.startsWith('conversation:cost:')) { const preference = data.slice('conversation:cost:'.length); if (!['any','male','female'].includes(preference)) return send(id, 'نوع انتخاب نامعتبر است.'); await updateAction(sClient, id, `admin:chat_cost:${preference}`); return send(id, `هزینهٔ هر اتصال موفق برای «${preference === 'any' ? 'مهم نیست' : preference === 'male' ? 'پسر' : 'دختر'}» را به مانو کوین بفرست.`); }
    if (isAdmin(id) && data.startsWith('conversation:entertainment:')) {
      const kind = data.slice('conversation:entertainment:'.length); const key = kind === 'games' ? 'mid_chat_games_enabled' : kind === 'ideas' ? 'mid_chat_ideas_enabled' : null;
      if (!key) return send(id, 'گزینه نامعتبر است.'); const next = (await botSettingValue(sClient, key, 'true')) !== 'true'; await saveBotSetting(sClient, key, String(next));
      const updated = await settings(sClient); const active = await sClient.query("SELECT telegram_id FROM users WHERE status='chatting'"); for (const row of active.rows) { try { await send(row.telegram_id, 'منوی مکالمه به‌روزرسانی شد.', chatKeyboard(updated, isAdmin(row.telegram_id))); } catch {} } return send(id, 'تنظیمات سرگرمی میان چت', entertainmentAdminKeyboard(updated));
    }
    if (isAdmin(id) && data === 'conversation:spam:open') { await updateAction(sClient, id, 'admin:spam'); return send(id, 'تنظیمات پیام اسپم را انتخاب کن.', spamAdminKeyboard()); }
    if (isAdmin(id) && (data === 'conversation:spam:limit' || data === 'conversation:spam:delay')) { await updateAction(sClient, id, data.endsWith('limit') ? 'admin:spam:limit' : 'admin:spam:delay'); return send(id, data.endsWith('limit') ? 'تعداد پیام متوالی را بفرست.' : 'تاخیر را با قالب 2S، 1M یا 500S بفرست.'); }
    if (isAdmin(id) && data === 'admin:block:back') { await updateAction(sClient, id, 'admin:user_control_hub'); return send(id, 'کنترل کاربران', userControlKeyboard()); }
    if (isAdmin(id) && data.startsWith('admin:block:unblock:')) {
      const parts = data.split(':'); const low = Number(parts[3]); const high = Number(parts[4]);
      if (!low || !high || low >= high) return send(id, 'شناسه بلاک نامعتبر است.');
      await sClient.query('DELETE FROM anonymous_blocks WHERE user_low=$1 AND user_high=$2 AND blocker_id=$3', [low, high, id]);
      await audit(sClient, id, low, 'unblock_pair', { userLow: low, userHigh: high });
      const rows = await blockedListRows(sClient, id); return editAudienceCallback(callbackQuery, id, `رفع بلاک انجام شد.\n\n${blockedListText(rows)}`, blockedListKeyboard(rows));
    }
    if (isAdmin(id) && data.startsWith('admin:user:')) {
      const [, , action, targetRaw, extra] = data.split(':'); const targetId = Number(targetRaw);
      if (!targetId || !['coin','plus','plus_select','plus_delta','plus_custom','plus_apply','ban','ban_timer','message','history','back'].includes(action)) return send(id, 'عملیات کاربر نامعتبر است.');
      if (action === 'coin') { const messageId = callbackQuery?.message?.message_id || ''; await updateAction(sClient, id, `admin:coin:${targetId}:${messageId}`); return editAudienceCallback(callbackQuery, id, 'مقدار مانو کوین را با علامت بفرست؛ مثال: +100 یا -50.', { reply_markup: { inline_keyboard: [] } }); }
      if (action === 'plus') { return editAudienceCallback(callbackQuery, id, 'مدت مانو پلاس را انتخاب کن:', plusAdjustInlineKeyboard(targetId)); }
      if (action === 'plus_select') { const months = Number(extra); if (![1,3,6,12].includes(months)) return send(id, 'پلن نامعتبر است.'); return editAudienceCallback(callbackQuery, id, `برای ${months === 12 ? '۱ سال' : `${months} ماه`} نوع عملیات را انتخاب کن:`, plusDirectionInlineKeyboard(targetId, months)); }
      if (action === 'plus_custom') { const messageId = callbackQuery?.message?.message_id || ''; await updateAction(sClient, id, `admin:plus:${targetId}:${messageId}`); return editAudienceCallback(callbackQuery, id, 'مقدار دلخواه را با علامت و M یا Y بفرست؛ مثال: +2M یا -1Y.', { reply_markup: { inline_keyboard: [] } }); }
      if (action === 'plus_delta') { const months = Number(extra); const direction = Number(data.split(':')[5]); if (![1,3,6,12].includes(months) || ![1,-1].includes(direction)) return send(id, 'عملیات مانو پلاس نامعتبر است.'); const changed = await sClient.query("UPDATE users SET plus_expires_at=CASE WHEN $2::int > 0 THEN GREATEST(COALESCE(plus_expires_at,NOW()),NOW()) + ($2 || ' months')::interval ELSE GREATEST(COALESCE(plus_expires_at,NOW()) + ($2 || ' months')::interval,NOW()) END,updated_at=NOW() WHERE telegram_id=$1 RETURNING plus_expires_at", [targetId, String(months * direction)]); const sign = direction > 0 ? 'افزایش' : 'کسر'; await audit(sClient, id, targetId, 'plus_adjustment', { months: months * direction, expiresAt: changed.rows[0]?.plus_expires_at }); await send(targetId, `مانو پلاس شما ${sign} یافت: ${months === 12 ? '۱ سال' : `${months} ماه`}.`); const panel = await adminUserPanel(sClient, id, targetId); return editAudienceCallback(callbackQuery, id, `مانو پلاس ${sign} شد و اعلان برای کاربر ارسال شد.\n\n${panel.text}`, panel.markup); }
      if (action === 'ban_timer') { const messageId = callbackQuery?.message?.message_id || ''; await updateAction(sClient, id, `admin:ban_timer:${targetId}:${messageId}`); return editAudienceCallback(callbackQuery, id, 'مدت بن را با قالب 15M، 2H یا 7D بفرست.', { reply_markup: { inline_keyboard: [] } }); }
      if (action === 'message') { const messageId = callbackQuery?.message?.message_id || ''; await updateAction(sClient, id, `admin:message:${targetId}:${messageId}`); return editAudienceCallback(callbackQuery, id, 'پیام اختصاصی را بفرست.', { reply_markup: { inline_keyboard: [] } }); }
      if (action === 'back') { const panel = await adminUserPanel(sClient, id, targetId); return editAudienceCallback(callbackQuery, id, panel.text, panel.markup); }
      if (action === 'ban') { const row = (await sClient.query('SELECT banned_until FROM users WHERE telegram_id=$1', [targetId])).rows[0]; const active = row?.banned_until && new Date(row.banned_until).getTime() > Date.now(); if (active) { await sClient.query('UPDATE users SET banned_until=NULL,ban_reason=NULL,updated_at=NOW() WHERE telegram_id=$1', [targetId]); await send(targetId, 'بن حساب شما توسط مدیریت رفع شد.'); } else { await adminBanUser(sClient, targetId, 100 * 365 * 86400); await send(targetId, 'حساب شما توسط مدیریت بن شد.'); } await audit(sClient, id, targetId, active ? 'unban' : 'ban', { source: 'inline_toggle' }); const panel = await adminUserPanel(sClient, id, targetId); return editAudienceCallback(callbackQuery, id, panel.text, panel.markup); }
    }
    if (isAdmin(id) && data.startsWith('admin:user:plus_apply:')) {
      const [, , , targetRaw, monthsRaw] = data.split(':'); const targetId = Number(targetRaw); const months = Number(monthsRaw); if (![1,3,6,12].includes(months)) return send(id, 'پلن نامعتبر است.');
      const changed = await sClient.query("UPDATE users SET plus_expires_at=GREATEST(COALESCE(plus_expires_at,NOW()),NOW()) + ($2 || ' months')::interval,updated_at=NOW() WHERE telegram_id=$1 RETURNING plus_expires_at", [targetId, String(months)]);
      await audit(sClient, id, targetId, 'plus_adjustment', { months, expiresAt: changed.rows[0]?.plus_expires_at }); await send(targetId, `مانو پلاس شما به مدت ${months === 12 ? '۱ سال' : `${months} ماه`} توسط مدیریت افزایش یافت.`); const panel = await adminUserPanel(sClient, id, targetId); return send(id, `مانو پلاس اضافه شد و اعلان برای کاربر ارسال شد.\n\n${panel.text}`, panel.markup);
    }
    if (isAdmin(id) && data.startsWith('admin:user:back:')) { const targetId = Number(data.split(':')[3]); const panel = await adminUserPanel(sClient, id, targetId); return send(id, panel.text, panel.markup); }
    if (data === 'gift:list' && isAdmin(id)) { await updateAction(sClient, id, 'admin:gifts'); return sendGiftManagement(sClient, id); }
    if (data === 'gift:type:coins' && isAdmin(id)) { await updateAction(sClient, id, 'admin:gift:coins'); return send(id, 'مقدار مانو کوین هدیه را بفرست.'); }
    if (data === 'gift:type:plus' && isAdmin(id)) { await updateAction(sClient, id, 'admin:gift:plus:type'); return send(id, 'پلن مانو پلاس را انتخاب کن:', giftPlanKeyboard()); }
    if (data === 'gift:type:discount' && isAdmin(id)) { await updateAction(sClient, id, 'admin:gift:discount:percent'); return send(id, 'درصد تخفیف را بین 1 تا 100 بفرست.'); }
    if (data.startsWith('gift:plan:') && isAdmin(id)) { const plan = Number(data.split(':')[2]); if (![1, 3, 6, 12].includes(plan)) return send(id, 'پلن نامعتبر است.'); await updateAction(sClient, id, `admin:gift:plus:${plan}`); return send(id, `تعداد مانو پلاس ${plan} ماهه را بفرست.`); }
    if (data.startsWith('gift:view:') && isAdmin(id)) { const code = data.slice('gift:view:'.length); const row = (await sClient.query('SELECT * FROM gift_codes WHERE code=$1', [code])).rows[0]; if (!row) return send(id, 'این کد دیگر وجود ندارد.', giftManagementKeyboard()); return send(id, `کد هدیه: ${row.code}\nوضعیت: ${giftStatus(row)}\nمانو کوین: ${row.coins}\nمانو پلاس: ${row.plus_days} روز\nاستفاده: ${row.uses}${row.max_uses ? `/${row.max_uses}` : ''}\nانقضا: ${row.expires_at ? iranDate(row.expires_at) : 'بدون انقضا'}`, giftCodeKeyboard(code)); }
    if (data.startsWith('gift:cancel:') && isAdmin(id)) { const code = data.slice('gift:cancel:'.length); await sClient.query('UPDATE gift_codes SET expires_at=NOW() WHERE code=$1', [code]); await audit(sClient, id, null, 'gift_code_cancel', { code }); await updateAction(sClient, id, 'admin:gifts'); return sendGiftManagement(sClient, id); }
    if (data.startsWith('gift:increase:') && isAdmin(id)) { const code = data.slice('gift:increase:'.length); await updateAction(sClient, id, `admin:gift:increase:${code}`); return send(id, 'افزایش را با قالب «کوین,روز پلاس» بفرست؛ مثال: 100,0 یا 0,30.'); }
    if (data === 'game:truth-or-dare' && me.status === 'chatting' && me.partner_id) {
      await send(Number(me.partner_id), '🎲 طرف مقابل درخواست بازی «حقیقت یا جرئت» داده است. قبول می‌کنی؟', { reply_markup: { inline_keyboard: [[{ text: 'قبول', callback_data: `game:accept:${id}` }, { text: 'رد', callback_data: `game:reject:${id}` }]] } });
      return send(id, 'درخواست بازی برای طرف مقابل ارسال شد.', chatKeyboard(s, isAdmin(id)));
    }
    if (data.startsWith('game:accept:') || data.startsWith('game:reject:')) {
      const requester = Number(data.split(':')[2]); if (!me.partner_id || Number(me.partner_id) !== requester) return send(id, 'این درخواست دیگر معتبر نیست.', chatKeyboard(s, isAdmin(id)));
      if (data.startsWith('game:reject:')) { await send(requester, 'درخواست بازی رد شد.'); return send(id, 'درخواست بازی رد شد.', chatKeyboard(s, isAdmin(id))); }
      await send(requester, '🎲 بازی حقیقت یا جرئت شروع شد؛ نوبت با درخواست‌دهنده است.'); return send(id, '🎲 بازی شروع شد؛ نوبت طرف مقابل است.', chatKeyboard(s, isAdmin(id)));
    }
    if (data.startsWith('idea:')) {
      const ideas = { today: 'اتفاق امروزت چه چیزی بود که ارزش تعریف کردن داشته باشد؟', childhood: 'یک خاطره شیرین یا عجیب از کودکی تعریف کن.', recent: 'عجیب‌ترین اتفاق اخیرت چه بوده؟' };
      return send(id, `💬 ایده صحبت\n\n${ideas[data.slice(5)] || 'درباره هر چیزی که دوست دارید صحبت کنید.'}`, chatKeyboard(s, isAdmin(id)));
    }
    if (data === 'connect') return handleConnect(id);
    if (data === 'gender:male' || data === 'gender:female') {
      const pendingMatch = me.action_state?.match(/^choose_gender_for:(male|female|any)$/)?.[1];
      await sClient.query('UPDATE users SET gender=$2, action_state=$3, updated_at=NOW() WHERE telegram_id=$1', [id, data.split(':')[1], pendingMatch ? null : 'choose_preference']);
      if (pendingMatch) return searchByPreference(id, pendingMatch, s);
      return send(id, screenText(publicAppearance(s), 'preference', appearanceFeedback(publicAppearance(s), 'connect_prompt', 'دوست داری به چه کسی وصل شوی؟')), preferenceKeyboard(s));
    }
    if (data.startsWith('pref:')) {
      const preference = data.slice('pref:'.length);
      if (!['male', 'female', 'any'].includes(preference)) return send(id, 'گزینهٔ جستجو معتبر نیست.', mainKeyboard(s));
      if (!['male', 'female'].includes(me.gender)) {
        await updateAction(sClient, id, `choose_gender_for:${preference}`);
        return send(id, screenText(publicAppearance(s), 'gender', OWN_GENDER_PROMPT), genderKeyboard(s));
      }
      return searchByPreference(id, preference, s);
    }
    if (data === 'cancel_wait') { await leaveWaiting(id); return send(id, 'از صف انتظار خارج شدی.', mainKeyboard(s)); }
    if (data === 'stop') {
      const meNow = await user(sClient, id); if (!meNow?.partner_id) return send(id, 'در حال حاضر در مکالمه‌ای نیستی.', mainKeyboard(s));
      const started = meNow.conversation_started_at ? new Date(meNow.conversation_started_at).getTime() : Date.now(); const elapsed = (Date.now() - started) / 1000;
      if (elapsed < STOP_MIN_SECONDS) return send(id, `این مکالمه تا ${Math.ceil(STOP_MIN_SECONDS - elapsed)} ثانیه دیگر قابل قطع نیست.`, chatKeyboard(s));
      await updateAction(sClient, id, 'confirm_stop'); return send(id, screenText(publicAppearance(s), 'confirm_stop', 'مطمئنی مکالمه قطع بشه؟'), confirmStopKeyboard(s));
    }
    if (data === 'stop_no') { await updateAction(sClient, id, null); return send(id, 'ادامه بده؛ مکالمه برقرار است.', chatKeyboard(s)); }
    if (data === 'stop_yes') {
      const partnerId = await disconnect(id); await updateAction(sClient, id, 'after_stop'); if (partnerId) await send(partnerId, 'مکالمه از طرف مقابل شما بسته شد.', mainKeyboard(s)); return send(id, 'مکالمه بسته شد. دوست داری چه کار کنی؟', afterStopKeyboard(s));
    }
    if (data === 'later' || data === 'block:later') { await updateAction(sClient, id, null); return send(id, 'باشه؛ هر زمان خواستی دوباره وصل شو.', mainKeyboard(s)); }
    if (data === 'block') { await updateAction(sClient, id, 'choose_block_reason'); return send(id, screenText(publicAppearance(s), 'block_reason', 'به چه دلیلی بلاک بشه؟'), blockKeyboard(s)); }
    if (data.startsWith('block:')) {
      const reasonKey = data.split(':')[1]; const target = me.partner_id ? Number(me.partner_id) : (me.last_partner_id ? Number(me.last_partner_id) : null);
      if (!target) return send(id, 'این مکالمه قبلاً بسته شده است.', mainKeyboard(s));
      await block(id, target, BLOCK_REASONS[reasonKey] || reasonKey); await disconnect(id); await updateAction(sClient, id, null);
      await send(target, `مکالمه بسته شد و طرف مقابل شما را بلاک کرد. دلیل: ${BLOCK_REASONS[reasonKey] || reasonKey}`);
      return send(id, 'کاربر بلاک شد و دلیل ثبت گردید.', mainKeyboard(s));
    }
    if (data.startsWith('premium:verify:')) return handlePremiumVerification(id, data, sClient);
    if (data.startsWith('plus:')) return handlePlusCallback(id, data, sClient, s);
    if (data === 'admin:toggle' && isAdmin(id)) { const enabled = !s.bot_enabled; await sClient.query("INSERT INTO bot_settings(key,value) VALUES ('bot_enabled',$1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value", [String(enabled)]); return send(id, enabled ? 'ربات روشن شد.' : 'ربات خاموش شد.', adminKeyboard(enabled)); }
    if (data === 'admin:rename' && isAdmin(id)) return send(id, 'کدام دکمه را تغییر می‌دهی؟', renameKeyboard());
    if (data.startsWith('admin:rename:') && isAdmin(id)) { const key = data.slice('admin:rename:'.length); if (!DEFAULTS[key]) return send(id, 'گزینه نامعتبر است.'); await updateAction(sClient, id, `rename:${key}`); return send(id, 'نام جدید را در یک پیام بفرست.'); }
    return send(id, 'این گزینه دیگر معتبر نیست.', mainKeyboard(s));
  } finally { sClient.release(); }
}

function mandatoryTypeKey(value) { return ({'کانال':'channel','گروه':'group','ربات':'bot','وب اپ':'web_app','وب سایت':'website'})[value] || null; }
function mandatoryTypeLabel(type) { return ({channel:'کانال',group:'گروه',bot:'ربات',web_app:'وب اپ',website:'وب سایت'})[type] || type; }
function encodeState(value) { return Buffer.from(String(value), 'utf8').toString('base64url'); }
function decodeState(value) { return Buffer.from(String(value), 'base64url').toString('utf8'); }
function sourceTrackingCode() { return `MJ-${crypto.randomBytes(4).toString('hex').toUpperCase()}`; }
function publicBaseUrl() { return process.env.PUBLIC_BASE_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : ''); }
function trackedJoinUrl(type, target, tracking) {
  const base = publicBaseUrl();
  if (type === 'bot') {
    const handle = String(target).replace(/^https?:\/\/t\.me\//i, '').replace(/^@/, '').replace(/\/.*$/, '');
    return handle ? `https://t.me/${handle}?start=mj_${tracking}` : target;
  }
  return (['web_app', 'website'].includes(type) && base) ? `${base}/api/mandatory-track?code=${encodeURIComponent(tracking)}` : target;
}
async function createMandatoryInviteLink(type, target, tracking) {
  if (!['channel', 'group'].includes(type)) return trackedJoinUrl(type, target, tracking);
  const normalized = normalizeTelegramTarget(target); const chat = await telegram('getChat', { chat_id: normalized }); const chatId = chat.id || normalized;
  try {
    const invite = await telegram('createChatInviteLink', { chat_id: chatId, name: `MJ-${tracking}` });
    return invite.invite_link;
  } catch (createError) {
    try { const invite = await telegram('exportChatInviteLink', { chat_id: chatId }); return invite; }
    catch (exportError) { throw new Error(`ساخت لینک دعوت خصوصی ممکن نشد: ${exportError.message || createError.message}`); }
  }
}
function mandatoryDraftFromActionState(actionState) {
  const prefix = 'mandatory:audience:';
  if (!String(actionState || '').startsWith(prefix)) return null;
  try {
    const draft = JSON.parse(decodeState(String(actionState).slice(prefix.length)));
    if (!draft || !['channel','group','bot','web_app','website'].includes(draft.type) || !['time','count','start','click'].includes(draft.mode) || !['active','queued','scheduled'].includes(draft.activation) || !String(draft.target || '').trim()) return null;
    draft.audience = normalizeMandatoryAudience(draft.audience);
    return draft;
  } catch { return null; }
}
function encodeMandatoryDraft(draft) { return encodeState(JSON.stringify(draft)); }
function mandatoryAudiencePrompt(draft) {
  const activation = draft.activation === 'active' ? 'شروع از الان' : draft.activation === 'queued' ? 'قرارگیری در صف' : `زمان‌بندی برای ${iranDate(draft.startsAt)}`;
  return `مخاطبان این منبع را انتخاب کن. همهٔ گروه‌ها در شروع روشن هستند؛ هر دکمه را بزن تا روشن/خاموش شود.\n\nمنبع: ${mandatoryTypeLabel(draft.type)}\nروش: ${draft.mode}\nوضعیت شروع: ${activation}`;
}
function mandatoryAudienceReviewText(draft) {
  const activation = draft.activation === 'active' ? 'شروع از الان' : draft.activation === 'queued' ? 'صف انتظار' : `زمان‌بندی برای ${iranDate(draft.startsAt)}`;
  return `بازبینی نهایی جویین اجباری\n\nنوع: ${mandatoryTypeLabel(draft.type)}\nهدف: ${draft.target}\nروش: ${draft.mode}\nشروع: ${activation}\nمخاطبان: ${mandatoryAudienceLabels(draft.audience)}\n\nبا تأیید نهایی، منبع و لینک دعوت ساخته می‌شود.`;
}
async function beginMandatoryAudienceSelection(client, id, draft) {
  const normalized = { ...draft, audience: normalizeMandatoryAudience(draft.audience || DEFAULT_MANDATORY_AUDIENCE) };
  await updateAction(client, id, `mandatory:audience:${encodeMandatoryDraft(normalized)}`);
  return send(id, mandatoryAudiencePrompt(normalized), mandatoryAudienceSelectionKeyboard(normalized.audience));
}
async function editAudienceCallback(callbackQuery, id, text, markup) {
  const message = callbackQuery?.message;
  if (message?.chat?.id && message?.message_id) {
    try {
      await telegram('editMessageText', { chat_id: message.chat.id, message_id: message.message_id, text, reply_markup: markup?.reply_markup || markup });
      return;
    } catch (error) {
      if (/message is not modified/i.test(String(error?.message || error))) return;
      console.error('mandatory_audience_message_edit_error', String(error?.message || error).slice(0, 160));
    }
  }
  return send(id, text, markup);
}
async function editAdminPanelMessage(id, messageId, panel) {
  if (messageId) { try { await telegram('editMessageText', { chat_id: id, message_id: Number(messageId), text: panel.text, reply_markup: panel.markup?.reply_markup || panel.markup }); return; } catch (error) { console.error('admin_panel_edit_error', String(error?.message || error).slice(0, 160)); } }
  return send(id, panel.text, panel.markup);
}
async function clearAudienceCallback(callbackQuery) {
  const message = callbackQuery?.message;
  if (!message?.chat?.id || !message?.message_id) return;
  try { await telegram('editMessageReplyMarkup', { chat_id: message.chat.id, message_id: message.message_id, reply_markup: { inline_keyboard: [] } }); }
  catch (error) { console.error('mandatory_audience_keyboard_clear_error', String(error?.message || error).slice(0, 160)); }
}
async function persistMandatorySourceDraft(client, id, draft) {
  const audience = normalizeMandatoryAudience(draft.audience);
  if (!Object.values(audience).some(Boolean)) throw new Error('mandatory_audience_empty');
  if (draft.mode === 'time' ? !(Number(draft.duration) > 0) : !(Number(draft.quota) > 0)) throw new Error('mandatory_draft_invalid');
  const target = normalizeTelegramTarget(draft.target);
  const targetInfo = await validateMandatoryTarget(draft.type, target);
  if (targetInfo === false) throw new Error('mandatory_target_unavailable');
  if (!targetInfo) throw new Error('mandatory_target_not_admin');
  const storedTarget = targetInfo.chatId || target;
  const title = (targetInfo.title || storedTarget).replace(/^https?:\/\//, '').slice(0, 120);
  const tracking = sourceTrackingCode();
  let joinUrl;
  try { joinUrl = await createMandatoryInviteLink(draft.type, storedTarget, tracking); }
  catch { throw new Error('mandatory_invite_failed'); }
  const status = draft.activation === 'active' ? 'active' : 'scheduled';
  const startsAt = draft.activation === 'scheduled' ? new Date(draft.startsAt) : null;
  if (draft.activation === 'scheduled' && !Number.isFinite(startsAt?.getTime())) throw new Error('mandatory_draft_invalid');
  let source;
  try {
    await client.query('BEGIN');
    const created = await client.query(
      `INSERT INTO mandatory_sources(tracking_code,source_type,visibility,title,target,join_url,mode,quota,duration_seconds,status,starts_at,started_at,created_by,audience)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,CASE WHEN $10='active' THEN NOW() ELSE NULL END,$12,$13::jsonb) RETURNING *`,
      [tracking, draft.type, draft.visibility, title, storedTarget, joinUrl, draft.mode, draft.mode === 'time' ? null : Number(draft.quota), draft.mode === 'time' ? Number(draft.duration) : null, status, startsAt, id, JSON.stringify(audience)]
    );
    source = created.rows[0];
    await recordMandatorySourceHistory(client, source, 'created', { toStatus: status, details: { note: `ثبت نهایی؛ مخاطبان: ${mandatoryAudienceLabels(audience)}`, audience } });
    if (draft.activation === 'active') {
      await recordMandatorySourceHistory(client, source, 'started', { fromStatus: null, toStatus: 'active', details: { note: 'از همان ابتدا فعال شد.' }, notifyAdmin: true });
    } else if (draft.activation === 'queued') {
      const pos = await client.query('SELECT COALESCE(MAX(position),0)+1 AS next FROM mandatory_source_queue');
      await client.query('INSERT INTO mandatory_source_queue(source_id,position) VALUES ($1,$2)', [source.id, pos.rows[0].next]);
      await recordMandatorySourceHistory(client, source, 'queued', { fromStatus: null, toStatus: 'queued', details: { note: 'در صف انتظار قرار گرفت.' } });
    } else {
      await recordMandatorySourceHistory(client, source, 'scheduled', { fromStatus: null, toStatus: 'scheduled', details: { note: `شروع برنامه‌ریزی‌شده: ${draft.scheduleLabel || iranDate(startsAt)}` } });
    }
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  }
  try { await syncMandatoryReport(client, source.id, telegram); }
  catch (error) { console.error('mandatory_report_sync_error', source.id, String(error?.message || error).slice(0, 200)); }
  try { await processMandatoryLifecycle(client, { telegramCall: telegram, sendAdmin: (chatId, text, markup) => send(chatId, text, markup) }); }
  catch (error) { console.error('mandatory_source_post_commit_error', source.id, String(error?.message || error).slice(0, 200)); }
  const current = await getMandatorySourceDetails(client, { id: source.id });
  const history = await getMandatorySourceHistory(client, source.id);
  return { source: current, history };
}
async function handleMandatoryAudienceCallback(id, data, callbackQuery) {
  if (!isAdmin(id)) return send(id, 'این تنظیم فقط برای مدیران ربات فعال است.');
  const client = await pool.connect();
  try {
    const admin = await user(client, id);
    const draft = mandatoryDraftFromActionState(admin?.action_state);
    if (!draft) { await clearAudienceCallback(callbackQuery); return send(id, 'این مرحله منقضی شده است؛ منبع ثبت نشده.'); }
    const audience = normalizeMandatoryAudience(draft.audience);
    if (data.startsWith('mandatory:audience:toggle:')) {
      const key = data.slice('mandatory:audience:toggle:'.length);
      draft.audience = toggleMandatoryAudience(audience, key);
      await updateAction(client, id, `mandatory:audience:${encodeMandatoryDraft(draft)}`);
      return editAudienceCallback(callbackQuery, id, mandatoryAudiencePrompt(draft), mandatoryAudienceSelectionKeyboard(draft.audience));
    }
    if (data === 'mandatory:audience:edit') return editAudienceCallback(callbackQuery, id, mandatoryAudiencePrompt(draft), mandatoryAudienceSelectionKeyboard(audience));
    if (data === 'mandatory:audience:review') {
      if (!Object.values(audience).some(Boolean)) return editAudienceCallback(callbackQuery, id, 'حداقل یک گروه از کاربران را روشن کن.', mandatoryAudienceSelectionKeyboard(audience));
      return editAudienceCallback(callbackQuery, id, mandatoryAudienceReviewText(draft), mandatoryAudienceReviewKeyboard());
    }
    if (data === 'mandatory:audience:cancel') {
      await updateAction(client, id, null);
      await clearAudienceCallback(callbackQuery);
      return send(id, 'تنظیم منبع لغو شد و چیزی ثبت نشد.', mandatoryJoinKeyboard());
    }
    if (data === 'mandatory:audience:confirm') {
      if (!Object.values(audience).some(Boolean)) return editAudienceCallback(callbackQuery, id, 'حداقل یک گروه از کاربران را انتخاب کن.', mandatoryAudienceSelectionKeyboard(audience));
      try {
        const result = await persistMandatorySourceDraft(client, id, { ...draft, audience });
        await updateAction(client, id, null);
        await clearAudienceCallback(callbackQuery);
        const verb = draft.activation === 'scheduled' ? 'منبع زمان‌بندی شد.' : draft.activation === 'queued' ? 'منبع به صف اضافه شد.' : 'منبع ثبت و فعال شد.';
        return send(id, `${verb}\n${formatMandatorySourceDetails(result.source, result.history, { includePrivateDetails: true })}`, mandatoryJoinKeyboard());
      } catch (error) {
        const message = error.message === 'mandatory_target_unavailable'
          ? 'دریافت اطلاعات کانال/گروه انجام نشد؛ هدف را بررسی کن.'
          : error.message === 'mandatory_target_not_admin'
            ? 'ربات در این کانال یا گروه دسترسی ادمین ندارد.'
            : error.message === 'mandatory_invite_failed'
              ? 'ساخت لینک دعوت خصوصی انجام نشد؛ دسترسی ادمین کامل را بررسی کن. منبع ثبت نشد.'
              : 'ثبت منبع انجام نشد؛ اطلاعات را بررسی و دوباره تلاش کن.';
        return editAudienceCallback(callbackQuery, id, `${message}\n\n${mandatoryAudienceReviewText(draft)}`, mandatoryAudienceReviewKeyboard());
      }
    }
    return send(id, 'این گزینه معتبر نیست.');
  } finally { client.release(); }
}

function jalaliToGregorian(jy, jm, jd) {
  let gy = jy <= 979 ? 621 : 1600; let jy2 = jy <= 979 ? jy : jy - 979;
  let days = 365 * jy2 + Math.floor(jy2 / 33) * 8 + Math.floor((jy2 % 33 + 3) / 4) + 78 + jd + (jm < 7 ? (jm - 1) * 31 : (jm - 7) * 30 + 186);
  gy += 400 * Math.floor(days / 146097); days %= 146097;
  if (days > 36524) { gy += 100 * Math.floor(--days / 36524); days %= 36524; if (days >= 365) days++; }
  gy += 4 * Math.floor(days / 1461); days %= 1461;
  if (days > 365) { gy += Math.floor((days - 1) / 365); days = (days - 1) % 365; }
  let gd = days + 1; const leap = (gy % 4 === 0 && gy % 100 !== 0) || gy % 400 === 0; const monthDays = [0,31,leap?29:28,31,30,31,30,31,31,30,31,30,31]; let gm = 1;
  while (gd > monthDays[gm]) gd -= monthDays[gm++];
  return new Date(Date.UTC(gy, gm - 1, gd));
}
function parseJalaliDateTime(value) {
  const m = String(value).trim().match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})-(\d{1,2}):(\d{2})$/);
  if (!m) return null; const d = jalaliToGregorian(Number(m[1]), Number(m[2]), Number(m[3]));
  if (!d || Number(m[4]) > 23 || Number(m[5]) > 59) return null; d.setUTCHours(Number(m[4]) - 3, Number(m[5]) - 30); return d;
}
export function mandatoryAdminSourceDetails(source) {
  const lines = [`${source.tracking_code} | ${source.title} | ${mandatoryTypeLabel(source.source_type)} | ${source.mode} | ${source.status}`, `دستور پیگیری: ${trackingCommand(source.tracking_code)}`];
  lines.push(`مخاطبان: ${mandatoryAudienceLabels(source.audience)}`);
  if (['channel', 'group'].includes(source.source_type)) {
    lines.push(`آیدی عددی: ${source.target}`);
    lines.push(`لینک دعوت خصوصی: ${source.join_url || 'ساخته نشده'}`);
    lines.push(`اعضای تأییدشده: ${Number(source.joined_count || 0)}`);
  } else if (source.join_url) lines.push(`آدرس: ${source.join_url}`);
  return lines.join('\n');
}
function mandatoryAppearanceText(displaySettings) {
  const layout = displaySettings.mandatory_join_button_layout === 'compact' ? 'فشرده (دو دکمه در هر ردیف)' : 'تک‌ردیفه';
  const tags = displaySettings.mandatory_join_show_source_tags === 'false' ? 'خاموش' : 'روشن';
  return `کنترل ظاهر جویین اجباری\n\nمتن فعلی: ${String(displaySettings.mandatory_join_message || DEFAULTS.mandatory_join_message).slice(0, 250)}\nنام دکمه عضویت: ${displaySettings.mandatory_join_button_label || DEFAULTS.mandatory_join_button_label}\nنام دکمه بررسی: ${displaySettings.mandatory_verify_button_label || DEFAULTS.mandatory_verify_button_label}\nچیدمان: ${layout}\nنمایش شماره منبع: ${tags}\n\nدکمه‌های عضویت برای حفظ شمارش همیشه شیشه‌ای و لینک‌دار می‌مانند؛ رنگ دکمه‌ها را تلگرام تعیین می‌کند.`;
}
async function mandatoryReportChannelText(client) {
  const result = await client.query("SELECT key,value FROM bot_settings WHERE key IN ('mandatory_report_channel_id','mandatory_report_channel_private')");
  const values = Object.fromEntries(result.rows.map(row => [row.key, row.value]));
  const channelId = values.mandatory_report_channel_id;
  return channelId
    ? `کانال گزارش‌دهی متصل است.\nآیدی کانال: ${channelId}\nنوع دسترسی: ${values.mandatory_report_channel_private === 'true' ? 'خصوصی' : 'عمومی'}\n\nپست‌ها ویرایش می‌شوند. لینک دعوت خصوصی فقط در کانال خصوصی نمایش داده می‌شود؛ در کانال عمومی فقط در گفت‌وگوی خصوصی مدیر دیده می‌شود.`
    : 'هنوز کانال گزارش‌دهی متصل نشده است. ربات را ادمین کانال خصوصی کن و سپس آیدی عددی یا @نام‌کاربری آن را بفرست.';
}
async function sendMandatoryTrackingDetails(client, id, { trackingCode, lookupKey } = {}) {
  const source = await getMandatorySourceDetails(client, { trackingCode, lookupKey });
  if (!source) return send(id, 'سفارشی با این کد پیگیری پیدا نشد؛ ممکن است کد از پایگاه داده حذف شده باشد.');
  const history = await getMandatorySourceHistory(client, source.id);
  return send(id, formatMandatorySourceDetails(source, history, { includePrivateDetails: true }), mandatorySourceKeyboard(source));
}
async function sendMandatoryTrackingList(id, text, sources, replyMarkup, { showInlineCodes = false } = {}) {
  await send(id, text, replyMarkup);
  if (showInlineCodes && sources.length) return send(id, 'برای بازکردن جزئیات و کنترل هر سفارش، روی کد پیگیری زیر بزن:', mandatoryTrackingListKeyboard(sources));
}
async function sendMandatoryScheduleList(client, id, prefix = '') {
  const rows = await client.query("SELECT tracking_code,title,status FROM mandatory_sources WHERE status='scheduled' AND starts_at IS NOT NULL ORDER BY starts_at,id LIMIT 50");
  const list = await mandatoryScheduleListText(client);
  return sendMandatoryTrackingList(id, `${prefix ? `${prefix}\n\n` : ''}${list}`, rows.rows, mandatoryScheduleListKeyboard(), { showInlineCodes: true });
}
export async function mandatoryStatusText(client) {
  const r = await client.query(`SELECT ms.id,ms.tracking_code,ms.source_type,ms.title,ms.target,ms.join_url,ms.mode,ms.status,ms.quota,ms.duration_seconds,ms.starts_at,ms.audience,
    (SELECT COUNT(*) FROM mandatory_source_events e WHERE e.source_id=ms.id AND e.event_type='join') AS joined_count
    FROM mandatory_sources ms WHERE ms.status IN ('scheduled','active','paused') ORDER BY ms.id DESC LIMIT 50`);
  if (!r.rows.length) return 'هیچ منبع فعالی، در صف یا زمان‌بندی‌شده‌ای وجود ندارد.';
  const heading = 'منابع جویین اجباری';
  const sections = [];
  let used = heading.length + 2;
  for (const row of r.rows) {
    const detail = mandatoryAdminSourceDetails(row);
    if (sections.length && used + detail.length + 2 > 2800) break;
    sections.push(detail.slice(0, 2700));
    used += detail.length + 2;
  }
  const remainder = r.rows.slice(sections.length);
  if (remainder.length) {
    const codes = remainder.map(row => trackingCommand(row.tracking_code)).join(', ');
    sections.push(`فهرست برای کوتاه ماندن در یک پیام محدود شد. موارد دیگر (${remainder.length}): ${codes}`);
  }
  return `${heading}\n\n${sections.join('\n\n')}`;
}
export async function mandatoryScheduleListText(client) {
  const r = await client.query("SELECT tracking_code,title,starts_at FROM mandatory_sources WHERE status='scheduled' AND starts_at IS NOT NULL ORDER BY starts_at,id");
  return r.rows.length
    ? `لیست زمان‌بندی:\n\n${r.rows.map(x => `${trackingCommand(x.tracking_code)} (${x.tracking_code}) | ${x.title} | ${iranDate(x.starts_at)}`).join('\n')}`
    : 'مورد زمان‌بندی‌شده‌ای وجود ندارد.';
}
async function handleMandatoryBack(client, id, state) {
  const parts = String(state || '').split(':'); const kind = parts[1];
  if (kind === 'type' || kind === 'audience') { await updateAction(client, id, null); return send(id, 'مدیریت جویین اجباری', mandatoryJoinKeyboard()); }
  if (state === 'mandatory:appearance') { await updateAction(client, id, null); return send(id, 'مدیریت جویین اجباری', mandatoryJoinKeyboard()); }
  if (kind === 'appearance') { await updateAction(client, id, 'mandatory:appearance'); return send(id, mandatoryAppearanceText(await settings(client)), mandatoryAppearanceKeyboard()); }
  if (kind === 'visibility') { await updateAction(client, id, 'mandatory:type'); return send(id, 'نوع جویین اجباری را انتخاب کن.', mandatoryTypeKeyboard()); }
  if (kind === 'target') { await updateAction(client, id, `mandatory:visibility:${parts[2]}`); return send(id, `نوع ${mandatoryTypeLabel(parts[2])} را انتخاب کن.`, mandatoryVisibilityKeyboard()); }
  if (kind === 'mode') { await updateAction(client, id, `mandatory:target:${parts[2]}:${parts[3]}`); return send(id, `لینک یا آیدی ${mandatoryTypeLabel(parts[2])} را بفرست.`); }
  if (kind === 'value') { await updateAction(client, id, `mandatory:mode:${parts[2]}:${parts[3]}:${parts[4]}`); return send(id, 'روش محاسبه را انتخاب کن.', mandatoryModeKeyboard(parts[2])); }
  if (kind === 'activate' && parts.length > 3) { await updateAction(client, id, `mandatory:value:${parts[2]}:${parts[3]}:${parts[4]}:${parts[5]}`); return send(id, 'مقدار یا مدت را بفرست.'); }
  if (kind === 'schedule') { await updateAction(client, id, `mandatory:activate:${parts.slice(2).join(':')}`); return send(id, 'روش فعال‌سازی را انتخاب کن.', mandatoryActivationKeyboard()); }
  if (kind === 'status') { await updateAction(client, id, null); return send(id, 'مدیریت جویین اجباری', mandatoryJoinKeyboard()); }
  if (kind === 'schedule_list') {
    await updateAction(client, id, 'mandatory:status');
    return send(id, await mandatoryStatusText(client), mandatoryStatusKeyboard());
  }
  if (kind === 'cancel' || kind === 'activate' || kind === 'reschedule' || kind === 'reschedule_at') { await updateAction(client, id, 'mandatory:schedule_list'); return sendMandatoryScheduleList(client, id); }
  return false;
}

async function sendAppearanceEditor(id, client, section) {
  const s = await settings(client);
  const appearance = section === 'public' ? publicAppearance(s) : privateAppearance(s);
  await updateAction(client, id, `appearance:${section}`);
  return send(id, appearanceEditorText(section, appearance), appearanceEditorKeyboard(section));
}
async function handleAppearanceText(client, id, value, state, s) {
  const match = String(state || '').match(/^appearance:(public|private)(?::(template|edit|set|layout|choose))?(?::(.*))?$/);
  if (!match) return false;
  const section = match[1]; const mode = match[2] || null; const tail = match[3] || '';
  const appearance = section === 'public' ? publicAppearance(s) : privateAppearance(s);
  if (!mode && value === 'قالب‌های آماده') { await updateAction(client, id, `appearance:${section}:template`); return send(id, `یک قالب برای بخش ${APPEARANCE_SECTIONS[section].title} انتخاب کن.

${templateListText()}`, appearanceTemplateKeyboard()); }
  if (!mode && value === 'ویرایش آیتم‌ها') { await updateAction(client, id, `appearance:${section}:edit:0`); return send(id, `آیتم موردنظر را انتخاب کن؛ این فهرست همهٔ لایه‌ها و پاسخ‌های داخلی را پوشش می‌دهد.\n\n${appearanceItems(section, appearance).length} آیتم قابل ویرایش`, appearanceItemsKeyboard(section, appearance, 0)); }
  if (!mode && value === 'چیدمان') { await updateAction(client, id, `appearance:${section}:layout`); return send(id, `چیدمان بخش ${APPEARANCE_SECTIONS[section].title} را انتخاب کن.`, appearanceLayoutKeyboard()); }
  if (mode === 'layout') {
    if (value === 'بازگشت') return sendAppearanceEditor(id, client, section);
    const layout = value === 'تک‌ستونه' ? 'single' : value === 'دو ستونه' ? 'columns2' : value === 'چینش فعلی' ? appearance.layout : null;
    if (!layout) return send(id, 'یکی از چیدمان‌های موجود را انتخاب کن.', appearanceLayoutKeyboard());
    const next = { ...appearance, layout }; const [key, json] = saveAppearanceQuery(section, next);
    await client.query('INSERT INTO bot_settings(key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()', [key, json]);
    return sendAppearanceEditor(id, client, section);
  }
  if (!mode && value === 'روشن/خاموش') {
    const key = section === 'public' ? 'appearance_public_enabled' : 'appearance_private_enabled';
    const enabled = s[key] !== false; await client.query('INSERT INTO bot_settings(key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()', [key, String(!enabled)]);
    return sendAppearanceEditor(id, client, section);
  }
  if (!mode && value === 'بازگردانی پیش‌فرض') {
    const [key, json] = saveAppearanceQuery(section, templateAppearance('default', section));
    await client.query('INSERT INTO bot_settings(key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()', [key, json]);
    return sendAppearanceEditor(id, client, section);
  }
  if (mode === 'template') {
    if (value === 'بازگشت') return sendAppearanceEditor(id, client, section);
    const idFromText = templateIdFromText(value.replace(/^\d+\s*/, '')) || templateIdFromText(value);
    if (!idFromText) return send(id, 'قالب معتبر نیست؛ یکی از چهار گزینه را انتخاب کن.', appearanceTemplateKeyboard());
    const [key, json] = saveAppearanceQuery(section, templateAppearance(idFromText, section));
    await client.query('INSERT INTO bot_settings(key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()', [key, json]);
    return sendAppearanceEditor(id, client, section);
  }
  if (mode === 'edit') {
    const page = Number(tail) || 0;
    if (value === 'بازگشت') return sendAppearanceEditor(id, client, section);
    if (value === 'صفحه بعد') { await updateAction(client, id, `appearance:${section}:edit:${page + 1}`); return send(id, 'لایه‌های بعدی:', appearanceItemsKeyboard(section, appearance, page + 1)); }
    if (value === 'صفحه قبل') { await updateAction(client, id, `appearance:${section}:edit:${Math.max(0, page - 1)}`); return send(id, 'لایه‌های قبلی:', appearanceItemsKeyboard(section, appearance, Math.max(0, page - 1))); }
    const index = Number(String(value).match(/^(\d+)/)?.[1]); const items = appearanceItems(section, appearance);
    if (!Number.isInteger(index) || !items[index - 1]) return send(id, 'شمارهٔ آیتم معتبر نیست.', appearanceItemsKeyboard(section, appearance, page));
    await updateAction(client, id, `appearance:${section}:set:${items[index - 1].path}`);
    return send(id, `مقدار جدید برای «${items[index - 1].label}» را بفرست. برای لغو «بازگشت» را بفرست.`);
  }
  if (mode === 'set') {
    if (value === 'بازگشت') return sendAppearanceEditor(id, client, section);
    if (!value) return send(id, 'مقدار نمی‌تواند خالی باشد؛ دوباره بفرست.');
    const next = setAppearancePath(appearance, tail, value.slice(0, 4000));
    const [key, json] = saveAppearanceQuery(section, next);
    await client.query('INSERT INTO bot_settings(key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()', [key, json]);
    return sendAppearanceEditor(id, client, section);
  }
  return false;
}
async function handleTechnicalAction(id, client, value, state = 'admin:technical', s = {}, actionId = null) {
  if (!isOwner(id)) return send(id, 'این بخش فقط برای مالک اصلی ربات فعال است.', reportsKeyboard(s));
  if (actionId === 'technical' || value === 'بخش فنی') { await updateAction(client, id, 'admin:technical'); return send(id, `بخش فنی مالک\n\nاینجا قبل از ارسال، فرمت فایل را از خودت می‌پرسد.`, technicalKeyboard(s)); }
  if (actionId === 'back' || value === 'بازگشت') {
    if (state === 'admin:technical:source_format' || state === 'admin:technical:database_format') { await updateAction(client, id, 'admin:technical'); return send(id, 'بخش فنی مالک', technicalKeyboard(s)); }
    await updateAction(client, id, 'admin:reports_menu'); return send(id, 'گزارش‌ها', reportsKeyboard(s));
  }
  if (state === 'admin:technical:source_format') {
    const format = value === 'ZIP' ? 'zip' : value === 'TAR.GZ' ? 'tar.gz' : null;
    if (!format) return send(id, 'فرمت سورس را انتخاب کن.', sourceFormatKeyboard());
    const archive = await createSourceArchive(format);
    try { return await sendDocument(id, archive.path, archive.name, `فایل اوپن‌سورس با فرمت ${value}`); } finally { await removeTempFile(archive.path); }
  }
  if (state === 'admin:technical:database_format') {
    const format = value === 'ZIP چندفرمتی' ? 'zip' : value === 'SQL' ? 'sql' : value === 'JSON' ? 'json' : value === 'CSV (ZIP)' ? 'csv' : null;
    if (!format) return send(id, 'فرمت بک‌آپ دیتابیس را انتخاب کن.', databaseFormatKeyboard());
    const backup = await createDatabaseBackup(pool, format);
    const extension = format === 'sql' ? 'sql' : format === 'json' ? 'json' : 'zip';
    const temp = `${process.env.TMPDIR || '/tmp'}/anonymous-db-${Date.now()}.${extension}`;
    await fs.writeFile(temp, backup);
    try { return await sendDocument(id, temp, `anonymous-telegram-chat-database-backup.${extension}`, `بک‌آپ دیتابیس با فرمت ${value}`); } finally { await removeTempFile(temp); }
  }
  if (actionId === 'source' || value === 'فایل اوپن سورس') { await updateAction(client, id, 'admin:technical:source_format'); return send(id, 'سورس را با چه فرمتی می‌خواهی؟', sourceFormatKeyboard()); }
  if (actionId === 'database' || value === 'بک آپ دیتابیس') { await updateAction(client, id, 'admin:technical:database_format'); return send(id, 'بک‌آپ دیتابیس را با چه فرمتی می‌خواهی؟', databaseFormatKeyboard()); }
  if (actionId === 'server' || value === 'وضعیت سرور') { return send(id, await collectServerStatus(pool, telegram), technicalKeyboard(s)); }
  return false;
}

function dynamicPublicAction(value, s) { return appearanceButtonId(value, 'public', s); }
function dynamicPrivateAction(value, s) { return appearanceButtonId(value, 'private', s); }
function visiblePrivateAction(value, s) {
  const appearance = privateAppearance(s); const text = String(value);
  for (const row of appearance.buttons || []) for (const item of row || []) if (String(item.label) === text) return item.id;
  for (const screen of Object.values(appearance.screens || {})) for (const item of screen.buttons || []) if (String(item.label) === text) return item.id;
  return null;
}
function visiblePublicAction(value, s) {
  const appearance = publicAppearance(s); const text = String(value);
  for (const row of appearance.buttons || []) for (const item of row || []) if (String(item.label) === text) return item.id;
  for (const screen of Object.values(appearance.screens || {})) for (const item of screen.buttons || []) if (String(item.label) === text) return item.id;
  const legacy = { [s.connect_button]: 'connect', [s.cancel_button]: 'cancel', [s.disconnect_button]: 'disconnect', [s.profile_button]: 'profile', [s.increase_coins_button]: 'coins', [s.free_coins_button]: 'free_coins', [s.plus_button]: 'plus', [s.back_button]: 'back', 'اتصال به مخاطب خاص': 'contact_special' };
  return legacy[text] || null;
}
async function handleText(id, text, meta = {}) {
  const client = await pool.connect();
  let released = false;
  try {
    const me = await ensureUser(client, id); const s = await settings(client);
    const value = text.trim();
    if (isAdmin(id) && me.action_state?.startsWith('beauty:name:')) {
      const [, , section, path, itemId, messageId] = me.action_state.split(':'); const appearance = section === 'public' ? publicAppearance(s) : privateAppearance(s); const next = JSON.parse(JSON.stringify(appearance)); const item = beautyItemRef(next, path, itemId); if (!item || !value) return send(id, 'نام نمی‌تواند خالی باشد.'); item.label = value.slice(0, 64); await updateAppearanceSetting(client, section, next); await updateAction(client, id, null); const textOut = beautyEditorText(section, next, path, itemId, 'ثبت شد'); if (messageId) { try { await telegram('editMessageText', { chat_id: id, message_id: Number(messageId), text: textOut, reply_markup: beautyKeyboard(section, next, path, itemId).reply_markup }); return; } catch {} } return send(id, textOut, beautyKeyboard(section, next, path, itemId));
    }
    if (isAdmin(id) && me.action_state?.startsWith('beauty:message:')) {
      const [, , section, path, itemId, messageId] = me.action_state.split(':'); const appearance = section === 'public' ? publicAppearance(s) : privateAppearance(s); const next = JSON.parse(JSON.stringify(appearance)); const target = beautyMessageTarget(next, path, itemId); if (!target || !value) return send(id, 'پیام پاسخ برای این دکمه پیدا نشد یا خالی است.'); if (['امور [آرایش زیبایی]', 'امور آرایش زیبایی'].includes(value.trim())) return send(id, 'نام دکمهٔ مدیریت نباید به‌عنوان متن پاسخ ذخیره شود؛ متن پاسخ واقعی را بفرست.'); target.parent[target.key] = value.slice(0, 4000); await updateAppearanceSetting(client, section, next); await updateAction(client, id, null); const textOut = beautyEditorText(section, next, path, itemId, 'ثبت شد'); if (messageId) { try { await telegram('editMessageText', { chat_id: id, message_id: Number(messageId), text: textOut, reply_markup: beautyKeyboard(section, next, path, itemId).reply_markup }); return; } catch {} } return send(id, textOut, beautyKeyboard(section, next, path, itemId));
    }
    const publicActionId = visiblePublicAction(value, s);
    const privateActionId = visiblePrivateAction(value, s);
    if (publicActionId === 'contact_special' || value === 'اتصال به مخاطب خاص') return startContactFlow(client, id);
    if (value === 'بازگشت' && (me.action_state === 'contact:target' || me.action_state?.startsWith('contact:compose:') || me.action_state?.startsWith('contact:reply:'))) {
      await updateAction(client, id, null);
      return send(id, 'به منوی اصلی برگشتی.', mainKeyboard(s));
    }
    if (me.action_state === 'contact:target') {
      const forwardedId = meta.forwardedUserId; const numericId = value.match(/^@?(\d{3,20})$/)?.[1] ? Number(value.replace(/^@/, '')) : null; const username = value.match(/^@([A-Za-z0-9_]{3,32})$/)?.[1] || null;
      if (!forwardedId && !numericId && !username) return send(id, 'آیدی عددی، @username معتبر یا پیام فورواردشدهٔ همان کاربر را بفرست.', contactTargetKeyboard());
      const target = (await client.query('SELECT telegram_id FROM users WHERE telegram_id=$1 OR ($2::text IS NOT NULL AND lower(username)=lower($2)) LIMIT 1', [forwardedId || numericId, username])).rows[0];
      if (Number(target?.telegram_id) === id) return send(id, 'نمی‌توانی خودت را به‌عنوان مخاطب انتخاب کنی.', contactTargetKeyboard());
      if (!target) { await updateAction(client, id, null); return send(id, 'این کاربر هنوز عضو ربات نیست. اگر دوست داری، لینک ربات را برایش بفرست تا بعد از ورود بتوانی برایش پیام ارسال کنی.', mainKeyboard(s)); }
      await updateAction(client, id, `contact:compose:${target.telegram_id}`); return send(id, '✅ مخاطب پیدا شد. حالا پیامی را که می‌خواهی برای او ارسال شود بنویس. پیام بدون نام و مشخصات تو به دستش می‌رسد.', contactReplyKeyboard());
    }
    if (me.action_state?.startsWith('contact:compose:')) {
      const targetId = Number(me.action_state.split(':')[2]); if (!value) return send(id, 'پیام نمی‌تواند خالی باشد.', contactReplyKeyboard()); const result = await client.query('INSERT INTO contact_messages(sender_id,recipient_id,body) VALUES ($1,$2,$3) RETURNING id', [id, targetId, value]); await updateAction(client, id, null); await sendContactNotice(client, targetId, result.rows[0].id); return send(id, 'پیامت به مخاطب ارسال شد. اگر او پاسخ بدهد، اعلانش را دریافت می‌کنی.', mainKeyboard(s));
    }
    if (me.action_state?.startsWith('contact:reply:')) {
      const messageId = Number(me.action_state.split(':')[2]); const original = (await client.query('SELECT sender_id,recipient_id FROM contact_messages WHERE id=$1 AND recipient_id=$2', [messageId, id])).rows[0]; if (!original || !value) return send(id, 'پاسخ نمی‌تواند خالی باشد.', contactReplyKeyboard()); const result = await client.query('INSERT INTO contact_messages(sender_id,recipient_id,body) VALUES ($1,$2,$3) RETURNING id', [id, original.sender_id, value]); await updateAction(client, id, null); await sendContactNotice(client, original.sender_id, result.rows[0].id); return send(id, 'پاسخت ارسال شد.', mainKeyboard(s));
    }
    if (me.action_state === 'chatgift:coin_custom') { const amount = Number(value); if (!Number.isInteger(amount) || amount < 1 || amount > 100000) return send(id, 'مقدار باید عدد صحیح بین 1 تا 100000 باشد.'); await updateAction(client, id, `chatgift:coins:${amount}`); return send(id, `مقدار انتخابی: ${amount} مانو کوین`, chatGiftCoinKeyboard(amount)); }
    if (me.action_state === 'coins:gift') { const code = value.replace(/^\/gift\s+/i, '').replace(/^\//, '').trim(); const result = await redeemGift(client, id, code); await updateAction(client, id, null); return result; }
    if (value === 'هدیه دادن' && me.status === 'chatting' && me.partner_id) return send(id, 'چه چیزی می‌خواهی برای طرف مکالمه‌ات هدیه بدهی؟', chatGiftTypeKeyboard());
    if (isAdmin(id) && me.action_state?.startsWith('appearance:')) {
      if (value === 'بازگشت کنترل ربات') { await updateAction(client, id, null); return send(id, 'کنترل ربات', controlKeyboard()); }
      const handledAppearance = await handleAppearanceText(client, id, value, me.action_state, s);
      if (handledAppearance !== false) return handledAppearance;
    }
    if (isAdmin(id) && me.action_state === 'appearance:choose') {
      if (value === 'بازگشت') { await updateAction(client, id, null); return send(id, 'کنترل ربات', controlKeyboard()); }
      if (value === 'پابلیک') return sendAppearanceEditor(id, client, 'public');
      if (value === 'پرایویسی') return sendAppearanceEditor(id, client, 'private');
      return send(id, 'یکی از دو بخش پابلیک یا پرایویسی را انتخاب کن.', replyKeyboard([['پابلیک'], ['پرایویسی'], ['بازگشت']], true));
    }
    if (isAdmin(id) && me.action_state?.startsWith('admin:technical')) {
      const technical = await handleTechnicalAction(id, client, value, me.action_state, s, privateActionId);
      if (technical !== false) return technical;
    }
    if (isAdmin(id) && value === 'بازگشت' && me.action_state === 'admin:reports_channel') {
      await updateAction(client, id, 'admin:reports_menu');
      return send(id, 'گزارش‌ها', reportsKeyboard(s));
    }
    if (isAdmin(id) && value === 'بازگشت' && me.action_state === 'admin:reports_channel_target') {
      await updateAction(client, id, 'admin:reports_channel');
      return send(id, await mandatoryReportChannelText(client), reportChannelKeyboard());
    }
    if (isAdmin(id) && me.action_state === 'admin:reports_channel_target') {
      const channel = await validateMandatoryReportChannel(value);
      if (channel === false) return send(id, 'دریافت اطلاعات کانال از تلگرام انجام نشد؛ آیدی را بررسی کن و دوباره بفرست.', reportChannelKeyboard());
      if (!channel) return send(id, 'کانال پیدا نشد یا ربات ادمینِ دارای دسترسی ارسال پیام نیست. ابتدا ربات را به کانال اضافه کن و سپس آیدی عددی یا @نام‌کاربری را بفرست.', reportChannelKeyboard());
      await client.query("INSERT INTO bot_settings(key,value) VALUES ('mandatory_report_channel_id',$1),('mandatory_report_channel_private',$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()", [channel.id, String(channel.isPrivate)]);
      await updateAction(client, id, 'admin:reports_channel');
      return send(id, `کانال «${channel.title}» وصل شد. گزارش هر منبع در یک پست ساخته و همان پست با تغییر وضعیت و آمار ویرایش می‌شود. منابع قبلی هم به‌صورت دسته‌ای همگام می‌شوند.\n\nآیدی: ${channel.id}\nدسترسی: ${channel.isPrivate ? 'خصوصی؛ شامل لینک دعوت' : 'عمومی؛ لینک دعوت خصوصی نمایش داده نمی‌شود'}`, reportChannelKeyboard());
    }
    if (isAdmin(id) && me.action_state?.startsWith('mandatory:tracking_schedule_at:')) {
      const trackingCode = decodeState(me.action_state.split(':')[2]); const startsAt = parseJalaliDateTime(value);
      if (!startsAt) return send(id, 'قالب زمان نامعتبر است؛ نمونه: 1405/6/10-17:10.');
      const before = await getMandatorySourceDetails(client, { trackingCode });
      if (!before || before.status !== 'scheduled') { await updateAction(client, id, null); return send(id, 'این سفارش دیگر در صف یا زمان‌بندی نیست.'); }
      const result = await client.query("UPDATE mandatory_sources SET status='scheduled',starts_at=$2,started_at=NULL,updated_at=NOW() WHERE id=$1 AND status='scheduled' RETURNING *", [before.id, startsAt]);
      if (!result.rowCount) return send(id, 'زمان‌بندی تغییر نکرد؛ وضعیت سفارش را دوباره بررسی کن.');
      await client.query('DELETE FROM mandatory_source_queue WHERE source_id=$1', [before.id]);
      await recordMandatorySourceHistory(client, result.rows[0], 'rescheduled', { fromStatus: before.queue_position ? 'queued' : 'scheduled', toStatus: 'scheduled', details: { note: `شروع: ${value}` } });
      await updateAction(client, id, null);
      try { await syncMandatoryReport(client, before.id, telegram); } catch (error) { console.error('mandatory_report_sync_error', before.id, String(error?.message || error).slice(0, 200)); }
      return sendMandatoryTrackingDetails(client, id, { trackingCode });
    }
    if (isAdmin(id) && value === 'بازگشت' && me.action_state?.startsWith('mandatory:')) {
      const handled = await handleMandatoryBack(client, id, me.action_state); if (handled !== false) return handled;
    }
    if (isAdmin(id) && me.action_state?.startsWith('mandatory:appearance:set:')) {
      const key = me.action_state.slice('mandatory:appearance:set:'.length);
      const limits = { mandatory_join_message: 4000, mandatory_join_button_label: 60, mandatory_verify_button_label: 60 };
      if (!Object.hasOwn(limits, key)) { await updateAction(client, id, 'mandatory:appearance'); return send(id, 'تنظیم ظاهری معتبر نیست.', mandatoryAppearanceKeyboard()); }
      if (!value) return send(id, 'متن نمی‌تواند خالی باشد؛ دوباره بفرست.');
      await client.query('INSERT INTO bot_settings(key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()', [key, value.slice(0, limits[key])]);
      await updateAction(client, id, 'mandatory:appearance');
      return send(id, 'تنظیم ذخیره شد.\n\n' + mandatoryAppearanceText(await settings(client)), mandatoryAppearanceKeyboard());
    }
    if (isAdmin(id) && me.action_state === 'mandatory:appearance:layout') {
      if (!['تک‌ردیفه','فشرده'].includes(value)) return send(id, 'یکی از دو چیدمان را انتخاب کن.', mandatoryAppearanceLayoutKeyboard());
      await client.query("INSERT INTO bot_settings(key,value) VALUES ('mandatory_join_button_layout',$1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()", [value === 'فشرده' ? 'compact' : 'single']);
      await updateAction(client, id, 'mandatory:appearance');
      return send(id, mandatoryAppearanceText(await settings(client)), mandatoryAppearanceKeyboard());
    }
    if (isAdmin(id) && me.action_state?.startsWith('admin:set:')) {
      const key = me.action_state.slice('admin:set:'.length);
      if (!['welcome_message', 'connected_message'].includes(key)) return send(id, 'تنظیم نامعتبر است.', adminMainKeyboard());
      if (!value) return send(id, 'پیام نمی‌تواند خالی باشد. دوباره بفرست.');
      await client.query("INSERT INTO bot_settings(key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()", [key, value.slice(0, 4000)]);
      await updateAction(client, id, null);
      return send(id, 'پیام با موفقیت ذخیره شد.', adminMainKeyboard());
    }
    if (isAdmin(id) && me.action_state === 'admin:broadcast') {
      if (!value) return send(id, 'متن پیام همگانی نمی‌تواند خالی باشد.');
      await updateAction(client, id, null);
      return broadcastText(client, value, id);
    }
    if (isAdmin(id) && me.action_state === 'admin:user_control_hub') {
      if (value === 'کنترل مکالمات') { await updateAction(client, id, 'admin:conversation_control'); return send(id, 'کنترل مکالمات کلی ربات\nاین تنظیمات روی همهٔ کاربران اعمال می‌شود.', conversationControlKeyboard()); }
      if (value === 'کنترل مالی') { await updateAction(client, id, 'admin:finance'); return send(id, 'کنترل مالی ربات\nقیمت‌ها، هزینه‌های اتصال و وضعیت درآمد را از این بخش مدیریت کن.', userFinanceKeyboard()); }
      if (value === 'کنترل یک کاربر') { await updateAction(client, id, 'admin:user_control_lookup'); return send(id, 'آیدی عددی کاربر را برای کنترل بفرست.', userControlKeyboard()); }
      if (value === 'لیست بن شده ها') { await updateAction(client, id, 'admin:banned_list'); return send(id, await bannedListText(client), bannedListKeyboard()); }
      if (value === 'لیست بلاکی ها') { await updateAction(client, id, 'admin:blocked_list'); return sendBlockedList(client, id); }
      if (value === 'دریافت وضعیت کاربران') return send(id, await adminStats(client), userControlKeyboard());
      if (value === 'کد هدیه') { await updateAction(client, id, 'admin:gifts'); return sendGiftManagement(client, id); }
      if (value === 'بازگشت پنل' || value === 'برگشت') { await updateAction(client, id, null); return send(id, 'پنل مدیریت', adminMainKeyboard(s)); }
      return send(id, 'یکی از گزینه‌های کنترل کاربران را انتخاب کن.', userControlKeyboard());
    }
    if (isAdmin(id) && me.action_state === 'admin:control') {
      if (value === 'امور [آرایش زیبایی]' || value === 'امور آرایش زیبایی') { await updateAction(client, id, 'admin:control'); return send(id, 'امور [آرایش زیبایی]\n\nبخش موردنظر را انتخاب کن:', beautySectionsKeyboard()); }
      if (value === 'امور مالی') { await updateAction(client, id, 'admin:finance_panel'); return send(id, 'امور مالی', botFinanceKeyboard()); }
      if (value === 'بازگشت پنل') { await updateAction(client, id, null); return send(id, 'پنل مدیریت', adminMainKeyboard(s)); }
      return send(id, 'کنترل ربات', controlKeyboard());
    }
    if (isAdmin(id) && me.action_state === 'admin:finance_panel') {
      if (value === 'وضعیت') return send(id, await financeStatusText(client), botFinanceKeyboard());
      if (value === 'قیمت مانوکوین') { await updateAction(client, id, 'admin:finance:price'); return send(id, `قیمت فعلی مانوکوین: ${await botSettingValue(client, 'finance_coin_price', 'تنظیم نشده')}\nقیمت جدید را بفرست.`, botFinanceKeyboard()); }
      if (value === 'درگاه ها') { await updateAction(client, id, 'admin:finance:gateways'); return send(id, `درگاه‌های فعلی: ${await botSettingValue(client, 'finance_gateways', 'تنظیم نشده')}\nفهرست یا توضیح درگاه‌ها را بفرست.`, botFinanceKeyboard()); }
      if (value === 'ولت ها') { await updateAction(client, id, 'admin:finance:wallets'); return send(id, `ولت‌های فعلی: ${await botSettingValue(client, 'finance_wallets', 'تنظیم نشده')}\nفهرست ولت‌ها را بفرست.`, botFinanceKeyboard()); }
      if (value === 'شماره کارت ها') { await updateAction(client, id, 'admin:finance:cards'); return send(id, `شماره کارت‌های فعلی: ${await botSettingValue(client, 'finance_cards', 'تنظیم نشده')}\nشماره کارت‌ها و نام صاحب کارت را بفرست.`, botFinanceKeyboard()); }
      if (value === 'کنترل ظاهری') { await updateAction(client, id, 'admin:finance:appearance'); return send(id, `وضعیت پرداختی‌ها: ${await botSettingValue(client, 'finance_enabled', 'false') === 'true' ? 'فعال' : 'غیرفعال'}\nاز گزینه زیر برای تغییر وضعیت استفاده کن.`, financeAppearanceKeyboard()); }
      if (value === 'بازگشت کنترل ربات') { await updateAction(client, id, 'admin:control'); return send(id, 'کنترل ربات', controlKeyboard()); }
      return send(id, 'یکی از گزینه‌های امور مالی را انتخاب کن.', botFinanceKeyboard());
    }
    if (isAdmin(id) && me.action_state === 'admin:finance:appearance') {
      if (value === 'فعال/غیرفعال کردن پرداخت') { const next = (await botSettingValue(client, 'finance_enabled', 'false')) !== 'true'; await saveBotSetting(client, 'finance_enabled', String(next)); return send(id, `پرداخت‌ها ${next ? 'فعال' : 'غیرفعال'} شد.`, financeAppearanceKeyboard()); }
      if (value === 'بازگشت امور مالی') { await updateAction(client, id, 'admin:finance_panel'); return send(id, 'امور مالی', botFinanceKeyboard()); }
      return send(id, 'یکی از گزینه‌ها را انتخاب کن.', financeAppearanceKeyboard());
    }
    if (isAdmin(id) && /^admin:finance:(price|gateways|wallets|cards)$/.test(me.action_state || '')) {
      if (value === 'بازگشت کنترل ربات' || value === 'بازگشت امور مالی' || value === 'بازگشت') { await updateAction(client, id, 'admin:finance_panel'); return send(id, 'امور مالی', botFinanceKeyboard()); }
      const key = me.action_state.split(':')[2]; if (!value) return send(id, 'مقدار نمی‌تواند خالی باشد.', botFinanceKeyboard());
      await saveBotSetting(client, `finance_${key === 'price' ? 'coin_price' : key}`, value.slice(0, 1000)); await updateAction(client, id, 'admin:finance_panel'); return send(id, 'تنظیم امور مالی ذخیره شد.', botFinanceKeyboard());
    }
    if (isAdmin(id) && me.action_state === 'admin:finance') {
      if (value === 'گزارش مالی') return send(id, await financialReport(client), userFinanceKeyboard());
      if (value === 'هزینه اتصال') { const costs = { chat_cost_any: await botSettingValue(client, 'chat_cost_any', '0'), chat_cost_male: await botSettingValue(client, 'chat_cost_male', '0'), chat_cost_female: await botSettingValue(client, 'chat_cost_female', '0') }; return send(id, 'هزینهٔ اتصال موفق را برای هر نوع انتخاب کن:', chatCostInlineKeyboard(costs)); }
      if (value === 'تنظیم دیلی کوین') { await updateAction(client, id, 'admin:daily_coin'); return send(id, `تنظیمات دیلی کوین\nمقدار فعلی: ${await botSettingValue(client, 'daily_coin_amount', '20')}\nدستور فعلی: ${await botSettingValue(client, 'daily_coin_command', '/daily')}\nریست فعلی: ${await botSettingValue(client, 'daily_coin_reset', '24H')}`, dailyCoinKeyboard()); }
      if (value === 'بازگشت کنترل کاربران' || value === 'برگشت') { await updateAction(client, id, 'admin:user_control_hub'); return send(id, 'کنترل کاربران', userControlKeyboard()); }
      return send(id, 'یکی از گزینه‌های کنترل مالی را انتخاب کن.', userFinanceKeyboard());
    }
    if (isAdmin(id) && me.action_state === 'admin:blocked_list') {
      if (value === 'بازگشت کنترل کاربران' || value === 'برگشت') { await updateAction(client, id, 'admin:user_control_hub'); return send(id, 'کنترل کاربران', userControlKeyboard()); }
      return sendBlockedList(client, id);
    }
    if (isAdmin(id) && me.action_state === 'admin:banned_list') {
      if (value === 'بازگشت کنترل کاربران') { await updateAction(client, id, 'admin:user_control_hub'); return send(id, 'کنترل کاربران', userControlKeyboard()); }
      if (value === 'بازگشت پنل' || value === 'برگشت') { await updateAction(client, id, null); return send(id, 'پنل مدیریت', adminMainKeyboard(s)); }
      return send(id, await bannedListText(client), bannedListKeyboard());
    }
    if (isAdmin(id) && me.action_state === 'admin:user_control_lookup') {
      if (value === 'خروج از پنل' || value === 'بازگشت پنل' || value === 'بازگشت') { await updateAction(client, id, null); return send(id, 'از پنل مدیریت خارج شدی.', mainKeyboard(s)); }
      if (publicActionId === 'connect' || value === s.connect_button) { await updateAction(client, id, null); client.release(); released = true; return handleConnect(id); }
      if (value === 'کنترل مکالمات') { await updateAction(client, id, 'admin:conversation_control'); return send(id, 'کنترل مکالمات کلی ربات\nاین تنظیمات روی همهٔ کاربران اعمال می‌شود.', conversationControlKeyboard()); }
      if (value === 'کنترل مالی') { await updateAction(client, id, 'admin:finance'); return send(id, 'کنترل مالی ربات', userFinanceKeyboard()); }
      if (value === 'کنترل یک کاربر') { await updateAction(client, id, 'admin:user_control_lookup'); return send(id, 'آیدی عددی کاربر را برای کنترل بفرست.', userControlKeyboard()); }
      if (value === 'لیست بن شده ها') { await updateAction(client, id, 'admin:banned_list'); return send(id, await bannedListText(client), bannedListKeyboard()); }
      if (value === 'لیست بلاکی ها') { await updateAction(client, id, 'admin:blocked_list'); return sendBlockedList(client, id); }
      if (value === 'دریافت وضعیت کاربران') return send(id, await adminStats(client), userControlKeyboard());
      if (value === 'کد هدیه') { await updateAction(client, id, 'admin:gifts'); return sendGiftManagement(client, id); }
      if (!/^\d{3,20}$/.test(value)) return send(id, 'آیدی عددی معتبر بفرست.', userControlKeyboard());
      const panel = await adminUserPanel(client, id, value); await updateAction(client, id, `admin:user_control:${value}`); return send(id, panel.text, panel.markup);
    }
    if (isAdmin(id) && me.action_state?.startsWith('admin:user_control:')) {
      const targetId = me.action_state.split(':')[2];
      if (value === 'خروج از پنل' || value === 'بازگشت پنل' || value === 'بازگشت') { await updateAction(client, id, null); return send(id, 'از پنل مدیریت خارج شدی.', mainKeyboard(s)); }
      if (publicActionId === 'connect' || value === s.connect_button) { await updateAction(client, id, null); client.release(); released = true; return handleConnect(id); }
      if (value === 'بازگشت کنترل کاربران' || value === 'بازگشت پنل') { await updateAction(client, id, null); return send(id, 'کنترل کاربران', userControlKeyboard()); }
      if (value === 'افزایش/کسر مانو کوین') { await updateAction(client, id, `admin:coin:${targetId}`); return send(id, 'مقدار را با علامت بفرست؛ مثال: +100 یا -50'); }
      if (value === 'افزایش/کسر مانو پلاس') { await updateAction(client, id, `admin:plus:${targetId}`); return send(id, 'تعداد روز پلاس را با علامت بفرست؛ مثال: +30 یا -7'); }
      if (value === 'بن/رفع بن') { await updateAction(client, id, `admin:ban:${targetId}`); return send(id, 'برای رفع بن «رفع» یا برای بن مدت مثل 1H بفرست.'); }
      if (value === 'تاریخچه فعالیت') { const logs = await client.query('SELECT action,created_at FROM admin_audit_log WHERE target_user_id=$1 ORDER BY id DESC LIMIT 15', [targetId]); return send(id, `تاریخچه فعالیت\n\n${logs.rows.map(x => `${iranDate(x.created_at)} — ${x.action}`).join('\n') || 'موردی ثبت نشده'}`, userActionsInlineKeyboard(targetId)); }
    }
    if (isAdmin(id) && me.action_state === 'admin:conversation_control') {
      if (value === 'بازگشت کنترل کاربران') { await updateAction(client, id, null); return send(id, 'کنترل کاربران', userControlKeyboard()); }
      if (value === 'مجوز های چت') { const permissions = JSON.parse(await botSettingValue(client, 'chat_permissions', JSON.stringify(DEFAULT_CHAT_PERMISSIONS)) || '{}'); return send(id, 'مجوزهای چت', permissionInlineKeyboard({ ...DEFAULT_CHAT_PERMISSIONS, ...permissions })); }
      if (value === 'هزینه هر چت') { const costs = { chat_cost_any: await botSettingValue(client, 'chat_cost_any', '0'), chat_cost_male: await botSettingValue(client, 'chat_cost_male', '0'), chat_cost_female: await botSettingValue(client, 'chat_cost_female', '0') }; return send(id, 'هزینهٔ اتصال موفق را برای هر نوع انتخاب کن:', chatCostInlineKeyboard(costs)); }
      if (value === 'حداقل تایم چت') { await updateAction(client, id, 'admin:min_time'); return send(id, `حداقل تایم فعلی: ${await botSettingValue(client, 'min_chat_duration', '15S')}\nمقدار جدید را مثل 15S، 2M یا 1H بفرست.`); }
      if (value === 'تایم بلاکی') { await updateAction(client, id, 'admin:block_duration'); return send(id, `مدت فعلی بلاک: ${await botSettingValue(client, 'block_duration', '7D')}\nمدت جدید را با قالب روز D، ساعت H یا دقیقه M بفرست؛ نمونه: 2D12H30M.`, conversationControlKeyboard()); }
      if (value === 'پیام اسپم') { await updateAction(client, id, 'admin:spam'); return send(id, `تنظیمات پیام اسپم\nتعداد فعلی: ${await botSettingValue(client, 'spam_consecutive_limit', '3')}\nتاخیر فعلی: ${await botSettingValue(client, 'spam_delay', '2S')}`, spamAdminKeyboard()); }
      if (value === 'سرگرمی میان چت') { return send(id, 'تنظیمات سرگرمی میان چت', entertainmentAdminKeyboard(s)); }
    }
    if (isAdmin(id) && me.action_state?.startsWith('admin:coin:')) {
      const stateParts = me.action_state.split(':'); const targetId = stateParts[2]; const messageId = stateParts[3]; const amount = Number(value); if (!Number.isInteger(amount) || amount === 0) return send(id, 'مقدار صحیح مثل +100 یا -50 بفرست.');
      const changed = await client.query('UPDATE users SET coins=GREATEST(0,coins+$2),updated_at=NOW() WHERE telegram_id=$1 RETURNING coins', [targetId, amount]); await audit(client, id, targetId, 'coin_adjustment', { amount, balance: changed.rows[0]?.coins }); await send(targetId, `حساب مانو کوین شما توسط مدیریت تغییر کرد.\nتغییر: ${amount > 0 ? '+' : ''}${amount}\nموجودی جدید: ${changed.rows[0]?.coins || 0}`); await updateAction(client, id, `admin:user_control:${targetId}`); const panel = await adminUserPanel(client, id, targetId); return editAdminPanelMessage(id, messageId, panel);
    }
    if (isAdmin(id) && me.action_state?.startsWith('admin:ban_timer:')) {
      const parts = me.action_state.split(':'); const targetId = Number(parts[2]); const messageId = parts[3]; const seconds = parseDuration(value);
      if (seconds === null || seconds <= 0) return send(id, 'قالب مدت بن نامعتبر است؛ مثل 15M، 2H یا 7D.');
      await adminBanUser(client, targetId, seconds); await audit(client, id, targetId, 'timed_ban', { duration: value }); await updateAction(client, id, `admin:user_control:${targetId}`);
      const panel = await adminUserPanel(client, id, targetId); return editAdminPanelMessage(id, messageId, panel);
    }
    if (isAdmin(id) && me.action_state?.startsWith('admin:message:')) {
      const stateParts = me.action_state.split(':'); const targetId = Number(stateParts[2]); const messageId = stateParts[3]; if (!value) return send(id, 'پیام اختصاصی نمی‌تواند خالی باشد.'); await audit(client, id, targetId, 'private_message', { length: value.length }); await send(targetId, `پیام اختصاصی از مدیریت:\n\n${value}`); await updateAction(client, id, `admin:user_control:${targetId}`); const panel = await adminUserPanel(client, id, targetId); return editAdminPanelMessage(id, messageId, panel);
    }
    if (isAdmin(id) && me.action_state?.startsWith('admin:plus:')) {
      const stateParts = me.action_state.split(':'); const targetId = stateParts[2]; const messageId = stateParts[3]; const months = parsePlusPeriod(value); if (!months) return send(id, 'قالب نامعتبر است؛ مثل +2M، -1M یا +1Y.');
      const changed = await client.query("UPDATE users SET plus_expires_at=CASE WHEN $2::int > 0 THEN GREATEST(COALESCE(plus_expires_at,NOW()),NOW()) + ($2 || ' months')::interval ELSE GREATEST(COALESCE(plus_expires_at,NOW()) + ($2 || ' months')::interval,NOW()) END,updated_at=NOW() WHERE telegram_id=$1 RETURNING plus_expires_at", [targetId, String(months)]); await audit(client, id, targetId, 'plus_adjustment', { months, expiresAt: changed.rows[0]?.plus_expires_at }); await send(targetId, `مانو پلاس شما ${months > 0 ? 'افزایش' : 'کسر'} یافت: ${Math.abs(months) >= 12 ? `${Math.abs(months) / 12} سال` : `${Math.abs(months)} ماه`}.`); await updateAction(client, id, `admin:user_control:${targetId}`); const panel = await adminUserPanel(client, id, targetId); return editAdminPanelMessage(id, messageId, panel);
    }
    if (isAdmin(id) && me.action_state?.startsWith('admin:ban:')) {
      const targetId = me.action_state.split(':')[2]; if (value === 'رفع') await client.query('UPDATE users SET banned_until=NULL,ban_reason=NULL,updated_at=NOW() WHERE telegram_id=$1', [targetId]); else { const seconds = parseDuration(value); if (seconds === null) return send(id, 'قالب بن نامعتبر است؛ مثل 1H یا 7D. برای 7D عدد روز را بفرست: 168H.'); await adminBanUser(client, targetId, seconds); } await audit(client, id, targetId, value === 'رفع' ? 'unban' : 'ban', { value }); await updateAction(client, id, `admin:user_control:${targetId}`); const panel = await adminUserPanel(client, id, targetId); return send(id, panel.text, panel.markup);
    }
    if (isAdmin(id) && me.action_state === 'admin:gifts') {
      if (value === 'برگشت') { await updateAction(client, id, null); return send(id, 'کنترل کاربران', userControlKeyboard()); }
      if (value === 'ایجاد') { await updateAction(client, id, 'admin:gift:type'); return send(id, 'نوع هدیه را انتخاب کن:', giftTypeKeyboard()); }
      if (value === 'دیلی کوین') { await updateAction(client, id, 'admin:daily_coin'); return send(id, `تنظیمات دیلی کوین\nمقدار فعلی: ${await botSettingValue(client, 'daily_coin_amount', '20')}\nدستور فعلی: ${await botSettingValue(client, 'daily_coin_command', '/daily')}\nریست فعلی: ${await botSettingValue(client, 'daily_coin_reset', '24H')}`, dailyCoinKeyboard()); }
      return sendGiftManagement(client, id);
    }
    if (isAdmin(id) && me.action_state === 'admin:gift:coins') {
      if (!/^\d+$/.test(value) || Number(value) <= 0) return send(id, 'مقدار مانو کوین را به‌صورت عدد مثبت بفرست.');
      await updateAction(client, id, `admin:gift:capacity:coins:${Number(value)}`); return send(id, 'ظرفیت استفاده را به‌صورت عدد بفرست یا «نامحدود» بنویس. هر کاربر فقط یک بار می‌تواند استفاده کند.');
    }
    if (isAdmin(id) && me.action_state?.startsWith('admin:gift:plus:')) {
      const plan = me.action_state.split(':')[3];
      if (!/^\d+$/.test(value) || Number(value) <= 0) return send(id, 'تعداد مانو پلاس را به‌صورت عدد مثبت بفرست.');
      await updateAction(client, id, `admin:gift:capacity:plus:${plan}:${Number(value)}`); return send(id, 'ظرفیت استفاده را به‌صورت عدد بفرست یا «نامحدود» بنویس. هر کاربر فقط یک بار می‌تواند استفاده کند.');
    }
    if (isAdmin(id) && me.action_state === 'admin:gift:discount:percent') {
      if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 100) return send(id, 'درصد تخفیف باید عددی بین 1 تا 100 باشد.');
      await updateAction(client, id, `admin:gift:capacity:discount:${Number(value)}`); return send(id, 'ظرفیت استفاده را به‌صورت عدد بفرست یا «نامحدود» بنویس. هر کاربر فقط یک بار می‌تواند استفاده کند.');
    }
    if (isAdmin(id) && me.action_state?.startsWith('admin:gift:capacity:')) {
      const parts = me.action_state.split(':'); const kind = parts[3]; const capacity = value === 'نامحدود' ? null : (/^\d+$/.test(value) && Number(value) > 0 ? Number(value) : undefined); if (capacity === undefined) return send(id, 'ظرفیت نامعتبر است؛ عدد مثبت یا «نامحدود» بفرست.');
      const next = kind === 'coins' ? `admin:gift:code:coins:${parts[4]}:${capacity ?? 'null'}` : kind === 'plus' ? `admin:gift:code:plus:${parts[4]}:${parts[5]}:${capacity ?? 'null'}` : `admin:gift:code:discount:${parts[4]}:${capacity ?? 'null'}`; await updateAction(client, id, next); return send(id, 'نام کد/دستور را بفرست؛ فقط حروف انگلیسی، عدد، _ یا - و حداقل 3 نویسه. مثل SUMMER20');
    }
    if (isAdmin(id) && me.action_state?.startsWith('admin:gift:code:')) {
      const parts = me.action_state.split(':'); const commandName = value.replace(/^\//, '').toUpperCase(); if (!/^[A-Z0-9_-]{3,32}$/.test(commandName)) return send(id, 'نام کد نامعتبر است؛ مثل SUMMER20 یا PLUS_1405.');
      const next = parts[3] === 'coins' ? `admin:gift:duration:coins:${parts[4]}:${parts[5]}:${commandName}` : parts[3] === 'plus' ? `admin:gift:duration:plus:${parts[4]}:${parts[5]}:${parts[6]}:${commandName}` : `admin:gift:duration:discount:${parts[4]}:${parts[5]}:${commandName}`;
      await updateAction(client, id, next); return send(id, 'مدت فعال بودن کد را بفرست؛ نمونه: 1d2h3m40s یا 30m.');
    }
    if (isAdmin(id) && me.action_state?.startsWith('admin:gift:duration:')) {
      const parts = me.action_state.split(':'); const kind = parts[3]; const amount = kind === 'coins' ? Number(parts[4]) : kind === 'plus' ? Number(parts[5]) : 0; const plusDays = kind === 'plus' ? Number(parts[4]) * amount : 0; const discountPercent = kind === 'discount' ? Number(parts[4]) : 0; const maxUses = kind === 'coins' ? (parts[5] === 'null' ? null : Number(parts[5])) : kind === 'plus' ? (parts[6] === 'null' ? null : Number(parts[6])) : (parts[5] === 'null' ? null : Number(parts[5])); const commandName = kind === 'coins' ? parts[6] : kind === 'plus' ? parts[7] : parts[6];
      const seconds = parseDuration(value); if (seconds === null || seconds <= 0) return send(id, 'مدت نامعتبر است؛ از S، M، H و D استفاده کن؛ نمونه: 1d2h3m40s.');
      const code = `MG-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
      await client.query('INSERT INTO gift_codes(code,coins,plus_days,max_uses,expires_at,created_by,gift_type,discount_percent,command_name) VALUES ($1,$2,$3,$4,NOW()+($5 || \' seconds\')::interval,$6,$7,$8,$9)', [code, kind === 'coins' ? amount : 0, plusDays, maxUses, String(seconds), id, kind === 'discount' ? 'discount' : 'reward', discountPercent, commandName]);
      await audit(client, id, null, 'gift_code_create', { code, coins: kind === 'coins' ? amount : 0, plusDays, duration: value });
      await updateAction(client, id, 'admin:gifts');
      await send(id, `کد هدیه ساخته شد: /${commandName}\nنوع: ${kind === 'coins' ? `${amount} مانو کوین` : kind === 'plus' ? `${amount} عدد پلاس ${parts[4]} ماهه` : `${discountPercent}% تخفیف خرید`}\nظرفیت: ${maxUses ?? 'نامحدود'}\nاعتبار: ${value}`, giftManagementKeyboard());
      return sendGiftManagement(client, id);
    }
    if (isAdmin(id) && me.action_state === 'admin:daily_coin') {
      if (value === 'برگشت') { await updateAction(client, id, 'admin:gifts'); return sendGiftManagement(client, id); }
      if (value === 'مقدار دیلی کوین') { await updateAction(client, id, 'admin:daily_coin:amount'); return send(id, 'مقدار کوین دیلی را بفرست.'); }
      if (value === 'دستور / دار دیلی کوین') { await updateAction(client, id, 'admin:daily_coin:command'); return send(id, 'دستور را با / بفرست؛ مثال: /daily'); }
      if (value === 'زمان ریست دیلی کوین') { await updateAction(client, id, 'admin:daily_coin:reset'); return send(id, 'زمان ریست را بفرست؛ مثال: 24H یا 1d.'); }
    }
    if (isAdmin(id) && me.action_state?.startsWith('admin:daily_coin:')) {
      if (value === 'برگشت') { await updateAction(client, id, 'admin:gifts'); return sendGiftManagement(client, id); }
      const key = me.action_state.split(':')[2]; if (key === 'amount' && !/^\d+$/.test(value)) return send(id, 'مقدار باید عدد باشد.', dailyCoinKeyboard()); if (key === 'command' && !/^\/[A-Za-z0-9_\u0600-\u06FF]{2,32}$/.test(value)) return send(id, 'دستور نامعتبر است؛ مثل /daily.', dailyCoinKeyboard()); if (key === 'reset' && parseDuration(value) === null) return send(id, 'زمان نامعتبر است؛ مثل 24H.', dailyCoinKeyboard()); await saveBotSetting(client, `daily_coin_${key}`, key === 'amount' ? String(Number(value)) : value.toUpperCase()); await updateAction(client, id, 'admin:daily_coin'); return send(id, 'تنظیمات دیلی کوین ذخیره شد.', dailyCoinKeyboard());
    }
    if (isAdmin(id) && me.action_state?.startsWith('admin:gift:increase:')) {
      const code = me.action_state.slice('admin:gift:increase:'.length); const [coins, plusDays] = value.split(',').map(x => Number(x.trim()));
      if (!Number.isInteger(coins) || !Number.isInteger(plusDays) || coins < 0 || plusDays < 0 || (coins === 0 && plusDays === 0)) return send(id, 'قالب نامعتبر است؛ مثال: 100,0 یا 0,30.');
      await client.query('UPDATE gift_codes SET coins=coins+$2,plus_days=plus_days+$3 WHERE code=$1', [code, coins, plusDays]); await audit(client, id, null, 'gift_code_increase', { code, coins, plusDays }); await updateAction(client, id, 'admin:gifts'); return sendGiftManagement(client, id);
    }
    if (isAdmin(id) && me.action_state === 'admin:block_duration') {
      const seconds = parseDuration(value);
      if (seconds === null || seconds <= 0) return send(id, 'قالب نامعتبر است؛ نمونه‌های معتبر: 2D، 12H، 30M یا ترکیب آن‌ها مثل 2D12H30M.', conversationControlKeyboard());
      await saveBotSetting(client, 'block_duration', value.toUpperCase()); await updateAction(client, id, 'admin:conversation_control');
      return send(id, `تایم بلاکی روی ${durationLabel(seconds)} تنظیم شد.`, conversationControlKeyboard());
    }
    if (isAdmin(id) && me.action_state === 'admin:min_time') {
      const seconds = parseDuration(value); if (seconds === null) return send(id, 'قالب نامعتبر است؛ نمونه: 15S، 2M یا 1H.'); await saveBotSetting(client, 'min_chat_duration', value.toUpperCase()); await updateAction(client, id, 'admin:conversation_control'); return send(id, `حداقل زمان روی ${durationLabel(seconds)} تنظیم شد.`, conversationControlKeyboard());
    }
    if (isAdmin(id) && me.action_state?.startsWith('admin:chat_cost:')) {
      const preference = me.action_state.split(':')[2]; if (!['any','male','female'].includes(preference) || !/^\d+$/.test(value)) return send(id, 'هزینه باید عدد صحیح صفر یا بیشتر باشد.'); await saveBotSetting(client, `chat_cost_${preference}`, String(Number(value))); await updateAction(client, id, 'admin:conversation_control'); const costs = { chat_cost_any: await botSettingValue(client, 'chat_cost_any', '0'), chat_cost_male: await botSettingValue(client, 'chat_cost_male', '0'), chat_cost_female: await botSettingValue(client, 'chat_cost_female', '0') }; return send(id, 'هزینه ذخیره شد؛ فقط پس از اتصال موفق کسر می‌شود.', chatCostInlineKeyboard(costs));
    }
    if (isAdmin(id) && me.action_state === 'admin:spam') {
      if (value === 'بازگشت کنترل مکالمات') { await updateAction(client, id, 'admin:conversation_control'); return send(id, 'کنترل مکالمات کلی ربات', conversationControlKeyboard()); }
      if (value === 'تعداد پیام متوالی') { await updateAction(client, id, 'admin:spam:limit'); return send(id, 'تعداد پیام متوالی را بفرست.'); }
      if (value === 'تاخیر بین پیام‌ها') { await updateAction(client, id, 'admin:spam:delay'); return send(id, 'تاخیر را با قالب 2S، 1M یا 500S بفرست.'); }
    }
    if (isAdmin(id) && me.action_state === 'admin:spam:limit') {
      if (!/^\d+$/.test(value) || Number(value) < 1) return send(id, 'تعداد باید عدد مثبت باشد.', spamAdminKeyboard()); await saveBotSetting(client, 'spam_consecutive_limit', value); await updateAction(client, id, 'admin:spam'); return send(id, 'تعداد پیام متوالی ذخیره شد.', spamAdminKeyboard());
    }
    if (isAdmin(id) && me.action_state === 'admin:spam:delay') {
      if (parseDuration(value) === null) return send(id, 'قالب نامعتبر است؛ نمونه: 2S یا 1M.', spamAdminKeyboard()); await saveBotSetting(client, 'spam_delay', value.toUpperCase()); await updateAction(client, id, 'admin:spam'); return send(id, 'تاخیر پیام ذخیره شد.', spamAdminKeyboard());
    }
    if (isAdmin(id) && me.action_state === 'admin:user_search') {
      if (value === 'خروج از پنل' || value === 'بازگشت پنل' || value === 'بازگشت') { await updateAction(client, id, null); return send(id, 'از پنل مدیریت خارج شدی.', mainKeyboard(s)); }
      if (publicActionId === 'connect' || value === s.connect_button) { await updateAction(client, id, null); client.release(); released = true; return handleConnect(id); }
      if (!/^\d{3,20}$/.test(value)) return send(id, 'آیدی عددی معتبر بفرست.');
      const found = await client.query('SELECT telegram_id,status,gender,coins,created_at FROM users WHERE telegram_id=$1', [value]);
      await updateAction(client, id, null);
      if (!found.rows[0]) return send(id, 'کاربری با این آیدی پیدا نشد.', adminMainKeyboard());
      const u = found.rows[0];
      return send(id, `کاربر ${u.telegram_id}\nوضعیت: ${u.status}\nجنسیت: ${u.gender || 'ثبت نشده'}\nمانو کوین: ${u.coins || 0}\nعضویت: ${iranDate(u.created_at)}`, adminMainKeyboard());
    }
    if (isAdmin(id) && privateActionId === 'back') { await updateAction(client, id, null); return send(id, 'پنل مدیریت', adminMainKeyboard(s)); }
if (isAdmin(id) && (privateActionId === 'technical' || value === 'بخش فنی')) return handleTechnicalAction(id, client, value, me.action_state, s, privateActionId);
    const privateAction = isAdmin(id) ? visiblePrivateAction(value, s) : null;
    if (privateAction === 'ads') return send(id, appearanceFeedback(privateAppearance(s), 'ads', 'مدیریت تبلیغات'), adsKeyboard(s));
    if (privateAction === 'control') { await updateAction(client, id, 'admin:control'); return send(id, appearanceFeedback(privateAppearance(s), 'control', 'کنترل ربات'), controlKeyboard(s)); }
    if (value === 'کنترل کاربر' || value === 'کنترل کاربران') { await updateAction(client, id, 'admin:user_control_hub'); return send(id, 'کنترل کاربران', userControlKeyboard()); }
    if (privateAction === 'users') { await updateAction(client, id, 'admin:user_control_lookup'); return send(id, appearanceFeedback(privateAppearance(s), 'users', 'آیدی عددی کاربر را بفرست.')); }
    if (privateAction === 'status') { const stats = await botStatus(client); return send(id, stats, adminMainKeyboard(s)); }
    if (privateAction === 'reports') { await updateAction(client, id, 'admin:reports_menu'); return send(id, appearanceFeedback(privateAppearance(s), 'reports', 'گزارش‌ها'), reportsKeyboard(s)); }
    if (privateAction === 'admins') return send(id, `${appearanceFeedback(privateAppearance(s), 'admins', 'مدیران فعلی')}

${[...adminIds()].join('\n') || 'ثبت نشده'}`, adminMainKeyboard(s));
    if (privateAction === 'exit') { await updateAction(client, id, null); return send(id, appearanceFeedback(privateAppearance(s), 'exit', 'از پنل مدیریت خارج شدی.'), mainKeyboard(s)); }
    const publicAction = dynamicPublicAction(value, s);
    if (publicAction === 'connect') { await updateAction(client, id, null); client.release(); released = true; return handleConnect(id); }
    if (publicAction === 'anonymous_link') { client.release(); released = true; return flowFor(s).handleLinkButton(id); }
    if (publicAction === 'profile') return sendProfile(id, s);
    if (publicAction === 'coins') return sendIncreaseCoins(id, s);
    if (publicAction === 'plus') return sendPlus(id, s);
    if (isAdmin(id) && value === s.profile_button) return sendProfile(id, s);
    if (isAdmin(id) && value === 'پروفایل من') return sendProfile(id, s);
    if (isAdmin(id) && value === 'تبلیغات') return send(id, 'مدیریت تبلیغات', adsKeyboard());
    if (isAdmin(id) && (value === 'امور [آرایش زیبایی]' || value === 'امور آرایش زیبایی')) { await updateAction(client, id, 'admin:control'); return send(id, 'امور [آرایش زیبایی]\n\nبخش موردنظر را انتخاب کن:', beautySectionsKeyboard()); }
    if (isAdmin(id) && value === 'کنترل ربات') { await updateAction(client, id, 'admin:control'); return send(id, 'کنترل ربات', controlKeyboard()); }
    if (isAdmin(id) && (value === 'کنترل کاربر' || value === 'کنترل کاربران')) { await updateAction(client, id, 'admin:user_control_hub'); return send(id, 'کنترل کاربران', userControlKeyboard()); }
    if (isAdmin(id) && (privateActionId === 'public_appearance' || value === 'بخش ظاهری پابلیک')) return sendAppearanceEditor(id, client, 'public');
    if (isAdmin(id) && (privateActionId === 'private_appearance' || value === 'بخش ظاهری پرایویسی')) return sendAppearanceEditor(id, client, 'private');
    if (isAdmin(id) && (privateActionId === 'templates' || value === 'قالب‌های آماده')) { await updateAction(client, id, 'appearance:choose'); return send(id, 'قالب آماده را برای کدام بخش اعمال می‌کنی؟', replyKeyboard([['پابلیک'], ['پرایویسی'], ['بازگشت']], true)); }
    if (isAdmin(id) && value === 'وضعیت ربات') { const stats = await botStatus(client); return send(id, stats, adminMainKeyboard()); }
    if (isAdmin(id) && value === 'گزارش‌ها') {
      await updateAction(client, id, 'admin:reports_menu');
      const r = await client.query("SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE status='open') AS open FROM reports");
      return send(id, `گزارش‌ها\n\nگزارش کاربران — کل: ${r.rows[0].total} | باز: ${r.rows[0].open}\n\nاز دکمه‌های زیر برای گزارش‌های کاربران یا کانال گزارش‌دهی جویین اجباری استفاده کن.`, reportsKeyboard());
    }
    if (isAdmin(id) && me.action_state === 'admin:reports_menu' && (privateActionId === 'technical' || value === 'بخش فنی')) return handleTechnicalAction(id, client, value, me.action_state, s, privateActionId);
    if (isAdmin(id) && me.action_state === 'admin:reports_menu' && (privateActionId === 'user_reports' || value === 'گزارش‌های کاربران')) {
      const r = await client.query("SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE status='open') AS open FROM reports");
      return send(id, `گزارش کاربران\n\nکل: ${r.rows[0].total}\nباز: ${r.rows[0].open}`, reportsKeyboard());
    }
    if (isAdmin(id) && value === 'کانال های گزارش دهی') {
      await updateAction(client, id, 'admin:reports_channel');
      return send(id, await mandatoryReportChannelText(client), reportChannelKeyboard());
    }
    if (isAdmin(id) && me.action_state === 'admin:reports_channel' && value === 'اتصال/تغییر کانال') {
      await updateAction(client, id, 'admin:reports_channel_target');
      return send(id, 'آیدی عددی کانال یا @نام‌کاربری آن را بفرست. ربات باید ادمین کانال و دارای اجازهٔ ارسال پیام باشد.', reportChannelKeyboard());
    }
    if (isAdmin(id) && me.action_state === 'admin:reports_channel' && value === 'قطع اتصال کانال گزارش‌دهی') {
      await client.query("INSERT INTO bot_settings(key,value) VALUES ('mandatory_report_channel_id',''),('mandatory_report_channel_private','false') ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()");
      await updateAction(client, id, 'admin:reports_channel');
      return send(id, 'اتصال کانال برداشته شد؛ پست‌های قبلی در کانال حذف نمی‌شوند و از این به بعد به‌روزرسانی نخواهند شد.', reportChannelKeyboard());
    }
    if (isAdmin(id) && value === 'مدیران') return send(id, `مدیران فعلی\n\n${[...adminIds()].join('\n') || 'ثبت نشده'}`, adminMainKeyboard());
    if (isAdmin(id) && (privateActionId === 'join' || value === 'جویین اجباری')) { await updateAction(client, id, null); return send(id, 'مدیریت جویین اجباری', mandatoryJoinKeyboard()); }
    if (isAdmin(id) && value === 'افزودن') { await updateAction(client, id, 'mandatory:type'); return send(id, 'نوع جویین اجباری را انتخاب کن.', mandatoryTypeKeyboard()); }
    if (isAdmin(id) && value === 'وضعیت') {
      await updateAction(client, id, 'mandatory:status');
      return send(id, await mandatoryStatusText(client), mandatoryStatusKeyboard());
    }
    if (isAdmin(id) && value === 'لیست زمان بندی') {
      await updateAction(client, id, 'mandatory:schedule_list');
      return sendMandatoryScheduleList(client, id);
    }
    if (isAdmin(id) && value === 'صف انتظار') {
      const r = await client.query("SELECT q.position,s.tracking_code,s.title,s.status,s.source_type,s.mode FROM mandatory_source_queue q JOIN mandatory_sources s ON s.id=q.source_id ORDER BY q.position");
      const text = r.rows.length ? `صف انتظار:\n\n${r.rows.map(x => `${x.position}) ${trackingCommand(x.tracking_code)} (${x.tracking_code}) | ${x.title}`).join('\n')}` : 'صف انتظار خالی است.';
      return sendMandatoryTrackingList(id, text, r.rows, mandatoryStatusKeyboard());
    }
    if (isAdmin(id) && value === 'درحال انجام') {
      const r = await client.query("SELECT tracking_code,title,source_type,mode,status FROM mandatory_sources WHERE status='active' ORDER BY id LIMIT 50");
      const text = r.rows.length ? `درحال انجام:\n\n${r.rows.map(x => `${trackingCommand(x.tracking_code)} (${x.tracking_code}) | ${x.title} | ${mandatoryTypeLabel(x.source_type)} | ${x.mode}`).join('\n')}` : 'منبع فعالی وجود ندارد.';
      return sendMandatoryTrackingList(id, text, r.rows, mandatoryStatusKeyboard());
    }
    if (isAdmin(id) && me.action_state === 'mandatory:schedule_list' && ['کنسل کردن','الان ست کن','تغییر تایم'].includes(value)) { const action = value === 'کنسل کردن' ? 'cancel' : value === 'الان ست کن' ? 'activate' : 'reschedule'; await updateAction(client, id, `mandatory:${action}`); return send(id, 'کد پیگیری منبع را از همین فهرست بفرست.', mandatoryScheduleListKeyboard()); }
    if (isAdmin(id) && me.action_state === 'mandatory:cancel') {
      const r = await client.query("UPDATE mandatory_sources SET status='cancelled',updated_at=NOW() WHERE tracking_code=$1 AND status='scheduled' AND starts_at IS NOT NULL RETURNING *", [value]);
      if (r.rowCount) {
        await client.query('DELETE FROM mandatory_source_queue WHERE source_id=$1', [r.rows[0].id]);
        await recordMandatorySourceHistory(client, r.rows[0], 'cancelled', { fromStatus: 'scheduled', toStatus: 'cancelled', details: { note: 'از فهرست زمان‌بندی لغو شد.' } });
        try { await syncMandatoryReport(client, r.rows[0].id, telegram); } catch (error) { console.error('mandatory_report_sync_error', r.rows[0].id, String(error?.message || error).slice(0, 200)); }
        await processMandatoryLifecycle(client, { telegramCall: telegram, sendAdmin: (chatId, text, markup) => send(chatId, text, markup) });
      }
      await updateAction(client, id, 'mandatory:schedule_list');
      return sendMandatoryScheduleList(client, id, r.rowCount ? `منبع ${value} کنسل شد.` : 'کد پیگیری معتبر نیست یا در فهرست زمان‌بندی نیست.');
    }
    if (isAdmin(id) && me.action_state === 'mandatory:activate') {
      try {
        const r = await client.query("UPDATE mandatory_sources SET status='active',started_at=COALESCE(started_at,NOW()),updated_at=NOW() WHERE (tracking_code=$1 OR target=$1 OR join_url=$1) AND status='scheduled' AND starts_at IS NOT NULL RETURNING *", [value]);
        if (r.rowCount) {
          await client.query('DELETE FROM mandatory_source_queue WHERE source_id=$1', [r.rows[0].id]);
          await recordMandatorySourceHistory(client, r.rows[0], 'started', { fromStatus: 'scheduled', toStatus: 'active', details: { note: 'از فهرست زمان‌بندی فعال شد.' }, notifyAdmin: true });
          try { await syncMandatoryReport(client, r.rows[0].id, telegram); } catch (error) { console.error('mandatory_report_sync_error', r.rows[0].id, String(error?.message || error).slice(0, 200)); }
          await processMandatoryLifecycle(client, { telegramCall: telegram, sendAdmin: (chatId, text, markup) => send(chatId, text, markup) });
        }
        await updateAction(client, id, 'mandatory:schedule_list'); return sendMandatoryScheduleList(client, id, r.rowCount ? `منبع ${r.rows[0].tracking_code} همین حالا فعال شد.` : 'منبع زمان‌بندی‌شده‌ای با این کد پیدا نشد.');
      } catch (error) { console.error('mandatory_activate_error', error.message); await updateAction(client, id, 'mandatory:schedule_list'); return sendMandatoryScheduleList(client, id, 'فعال‌سازی انجام نشد؛ دوباره تلاش کن.'); }
    }
    if (isAdmin(id) && me.action_state === 'mandatory:reschedule') {
      if (parseJalaliDateTime(value)) return send(id, 'ابتدا کد پیگیری را از فهرست زمان‌بندی بفرست.', mandatoryScheduleListKeyboard());
      const source = await client.query("SELECT tracking_code FROM mandatory_sources WHERE tracking_code=$1 AND status='scheduled' AND starts_at IS NOT NULL", [value]);
      if (!source.rowCount) return send(id, 'کد پیگیری در فهرست زمان‌بندی پیدا نشد. کد را دوباره بفرست.', mandatoryScheduleListKeyboard());
      await updateAction(client, id, `mandatory:reschedule_at:${encodeState(value)}`); return send(id, 'زمان جدید را با قالب 1405/6/10-17:10 بفرست.', mandatoryScheduleListKeyboard());
    }
    if (isAdmin(id) && me.action_state?.startsWith('mandatory:reschedule_at:')) {
      const code = decodeState(me.action_state.split(':')[2]); const date = parseJalaliDateTime(value);
      if (!date) return send(id, 'قالب زمان نامعتبر است؛ نمونه: 1405/6/10-17:10.', mandatoryScheduleListKeyboard());
      const r = await client.query("UPDATE mandatory_sources SET starts_at=$2,started_at=NULL,updated_at=NOW() WHERE tracking_code=$1 AND status='scheduled' AND starts_at IS NOT NULL RETURNING *", [code,date]);
      if (r.rowCount) {
        await recordMandatorySourceHistory(client, r.rows[0], 'rescheduled', { fromStatus: 'scheduled', toStatus: 'scheduled', details: { note: `شروع: ${value}` } });
        try { await syncMandatoryReport(client, r.rows[0].id, telegram); } catch (error) { console.error('mandatory_report_sync_error', r.rows[0].id, String(error?.message || error).slice(0, 200)); }
      }
      await updateAction(client, id, 'mandatory:schedule_list'); return sendMandatoryScheduleList(client, id, r.rowCount ? `زمان منبع ${code} تغییر کرد.` : 'کد پیگیری در فهرست زمان‌بندی پیدا نشد.');
    }
    if (isAdmin(id) && value === 'بازگشت پنل') { await updateAction(client, id, null); return send(id, 'پنل مدیریت', adminMainKeyboard()); }
    if (isAdmin(id) && me.action_state === 'mandatory:type') {
      const type = mandatoryTypeKey(value); if (!type) return send(id, 'یک نوع معتبر انتخاب کن.', mandatoryTypeKeyboard());
      if (type === 'channel' || type === 'group') { await updateAction(client, id, `mandatory:visibility:${type}`); return send(id, `نوع ${mandatoryTypeLabel(type)} را انتخاب کن.`, mandatoryVisibilityKeyboard()); }
      await updateAction(client, id, `mandatory:target:${type}:public`); return send(id, `آیدی یا لینک ${mandatoryTypeLabel(type)} را بفرست.`);
    }
    if (isAdmin(id) && me.action_state?.startsWith('mandatory:visibility:')) {
      const type = me.action_state.split(':')[2]; if (!['خصوصی','عمومی'].includes(value)) return send(id, 'خصوصی یا عمومی را انتخاب کن.', mandatoryVisibilityKeyboard());
      await updateAction(client, id, `mandatory:target:${type}:${value === 'خصوصی' ? 'private' : 'public'}`); return send(id, `لینک یا آیدی ${mandatoryTypeLabel(type)} را بفرست.`);
    }
    if (isAdmin(id) && me.action_state?.startsWith('mandatory:target:')) {
      const [, , type, visibility] = me.action_state.split(':'); if (!value) return send(id, 'آدرس یا آیدی معتبر بفرست.');
      await updateAction(client, id, `mandatory:mode:${type}:${visibility}:${encodeState(value)}`); return send(id, 'روش محاسبه را انتخاب کن.', mandatoryModeKeyboard(type));
    }
    if (isAdmin(id) && me.action_state?.startsWith('mandatory:mode:')) {
      const [, , type, visibility, encodedTarget] = me.action_state.split(':');
      const mode = value === 'براساس زمان' ? 'time' : value === 'براساس میزان' ? 'count' : value === 'براساس استارت' ? 'start' : value === 'براساس کلیک' ? 'click' : null;
      if (!mode) return send(id, 'روش محاسبه را انتخاب کن.', mandatoryModeKeyboard(type));
      await updateAction(client, id, `mandatory:value:${type}:${visibility}:${mode}:${encodedTarget}`);
      return send(id, mode === 'time' ? 'زمان را با قالب 1D2h30m بفرست.' : 'مقدار را فقط با عدد لاتین بفرست.');
    }
    if (isAdmin(id) && me.action_state?.startsWith('mandatory:value:')) {
      const [, , type, visibility, mode, encodedTarget] = me.action_state.split(':');
      const raw = value.toLowerCase(); const target = decodeState(encodedTarget); let quota = null; let duration = null;
      if (mode === 'time') { const m = raw.match(/^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?$/); if (!m || !m[0] || (!m[1] && !m[2] && !m[3])) return send(id, 'قالب زمان نامعتبر است؛ نمونه: 1D2h30m.'); duration = ((Number(m[1]||0)*86400)+(Number(m[2]||0)*3600)+(Number(m[3]||0)*60)); }
      else { if (!/^\d+$/.test(raw) || Number(raw) < 1) return send(id, 'فقط عدد لاتین بزرگ‌تر از صفر بفرست.'); quota = Number(raw); }
      return (await updateAction(client, id, `mandatory:activate:${type}:${visibility}:${mode}:${encodedTarget}:${quota || 0}:${duration || 0}`), send(id, `جمع‌بندی منبع\nنوع: ${mandatoryTypeLabel(type)}\nآدرس: ${target}\nمقدار: ${mode === 'time' ? `${duration} ثانیه` : quota}\nروش فعال‌سازی را انتخاب کن.`, mandatoryActivationKeyboard()));
    }
    if (isAdmin(id) && me.action_state?.startsWith('mandatory:activate:')) {
      const [, , type, visibility, mode, encodedTarget, quotaRaw, durationRaw] = me.action_state.split(':');
      if (value === 'زمان بندی کردن') { await updateAction(client, id, `mandatory:schedule:${type}:${visibility}:${mode}:${encodedTarget}:${quotaRaw}:${durationRaw}`); return send(id, 'تاریخ و ساعت شمسی را با قالب 1405/6/10-17:10 بفرست.'); }
      if (!['شروع از الان','ارسال به صف'].includes(value)) return send(id, 'یکی از روش‌های فعال‌سازی را انتخاب کن.', mandatoryActivationKeyboard());
      const draft = { type, visibility, mode, target: decodeState(encodedTarget), quota: Number(quotaRaw) || null, duration: Number(durationRaw) || null, activation: value === 'شروع از الان' ? 'active' : 'queued', startsAt: null, audience: { ...DEFAULT_MANDATORY_AUDIENCE } };
      return beginMandatoryAudienceSelection(client, id, draft);
    }
    if (isAdmin(id) && me.action_state?.startsWith('mandatory:schedule:')) {
      const [, , type, visibility, mode, encodedTarget, quotaRaw, durationRaw] = me.action_state.split(':');
      const startsAt = parseJalaliDateTime(value);
      if (!startsAt) return send(id, 'قالب زمان نامعتبر است؛ نمونه: 1405/6/10-17:10.');
      const draft = { type, visibility, mode, target: decodeState(encodedTarget), quota: Number(quotaRaw) || null, duration: Number(durationRaw) || null, activation: 'scheduled', startsAt: startsAt.toISOString(), scheduleLabel: value, audience: { ...DEFAULT_MANDATORY_AUDIENCE } };
      return beginMandatoryAudienceSelection(client, id, draft);
    }
    if (isAdmin(id) && value === 'کنترل ظاهری') {
      await updateAction(client, id, 'mandatory:appearance');
      return send(id, mandatoryAppearanceText(s), mandatoryAppearanceKeyboard());
    }
    if (isAdmin(id) && me.action_state === 'mandatory:appearance') {
      const settingKeys = { 'ویرایش متن جویین': 'mandatory_join_message', 'نام دکمه عضویت': 'mandatory_join_button_label', 'نام دکمه بررسی': 'mandatory_verify_button_label' };
      if (settingKeys[value]) { await updateAction(client, id, `mandatory:appearance:set:${settingKeys[value]}`); return send(id, value === 'ویرایش متن جویین' ? 'متن پیام جویین را بفرست. برای تعداد منابع از {count} استفاده کن.' : 'نام جدید دکمه را بفرست (حداکثر ۶۰ نویسه).'); }
      if (value === 'چیدمان دکمه‌ها') { await updateAction(client, id, 'mandatory:appearance:layout'); return send(id, 'چیدمان دکمه‌های شیشه‌ای را انتخاب کن.', mandatoryAppearanceLayoutKeyboard()); }
      if (value === 'نمایش/پنهان‌کردن برچسب منبع') {
        const next = s.mandatory_join_show_source_tags === 'false' ? 'true' : 'false';
        await client.query("INSERT INTO bot_settings(key,value) VALUES ('mandatory_join_show_source_tags',$1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()", [next]);
        return send(id, mandatoryAppearanceText(await settings(client)), mandatoryAppearanceKeyboard());
      }
    }
    if (isAdmin(id) && value === 'بازگشت پنل') { await updateAction(client, id, null); return send(id, 'پنل مدیریت', adminMainKeyboard()); }

    if (isAdmin(id) && (privateActionId === 'broadcast' || value === 'پیام همگانی')) { await updateAction(client, id, 'admin:broadcast'); return send(id, 'متن پیام همگانی را بفرست. نسخهٔ متنی فعال است؛ ارسال رسانه در مرحلهٔ بعد اضافه می‌شود.'); }
    if (isAdmin(id) && (privateActionId === 'welcome' || value === 'پیام خوش‌آمد')) { await updateAction(client, id, 'admin:set:welcome_message'); return send(id, 'متن پیام خوش‌آمد جدید را بفرست.'); }
    if (isAdmin(id) && (privateActionId === 'connection_ad' || value === 'تبلیغ اتصال')) { await updateAction(client, id, 'admin:set:connected_message'); return send(id, 'متن پیام هنگام اتصال را بفرست.'); }
    if (isAdmin(id) && (privateActionId === 'mid_ad' || value === 'تبلیغ میان مکالمه')) return send(id, 'تبلیغ میان مکالمه در پنل فعال است؛ زمان‌بندی خودکار آن در مرحلهٔ بعد اضافه می‌شود.', adsKeyboard(s));
    if (isAdmin(id) && (privateActionId === 'public_appearance' || value === 'بخش ظاهری پابلیک')) return sendAppearanceEditor(id, client, 'public');
    if (isAdmin(id) && (privateActionId === 'private_appearance' || value === 'بخش ظاهری پرایویسی')) return sendAppearanceEditor(id, client, 'private');
    if (isAdmin(id) && (privateActionId === 'toggle' || value === 'روشن/خاموش کردن ربات')) { const enabled = !s.bot_enabled; await client.query("INSERT INTO bot_settings(key,value) VALUES ('bot_enabled',$1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()", [String(enabled)]); return send(id, enabled ? 'ربات روشن شد.' : 'ربات خاموش شد.', controlKeyboard(s)); }
    if (isAdmin(id) && (value === 'بازگشت پنل' || value === 'بازگشت')) { await updateAction(client, id, null); return send(id, 'پنل مدیریت', adminMainKeyboard()); }
    if (isAdmin(id) && (privateActionId === 'exit' || value === 'خروج از پنل')) { await updateAction(client, id, null); return send(id, 'از پنل خارج شدی.', mainKeyboard(s)); }
    if (publicActionId === 'profile' || value === 'پروفایل من') return sendProfile(id, s);
    if (publicActionId === 'emoji' || value === 'ظاهر ایموجی پلاس') {
      if (!isPlus(me, id)) return send(id, 'این بخش فقط برای کاربران پلاس فعال است.', profileKeyboard(s, id));
      await updateAction(client, id, 'plus_emoji');
      return send(id, isOwner(id) ? 'سه ایموجی ارسال کن؛ نشان مالک فقط با سه ایموجی معتبر ذخیره می‌شود.' : isAdmin(id) ? 'دو ایموجی ارسال کن؛ نشان ادمین فقط با دو ایموجی معتبر ذخیره می‌شود.' : 'یک ایموجی دلخواه ارسال کن. فقط یک ایموجی مجاز است و متن یا شکل دیگری پذیرفته نمی‌شود.', emojiKeyboard(s));
    }
    if (publicActionId === 'reset' || value === 'ریست ایموجی') { await client.query("UPDATE users SET plus_emoji='✨', updated_at=NOW() WHERE telegram_id=$1", [id]); await updateAction(client, id, null); return send(id, 'ایموجی پلاس به ✨ برگردانده شد.', profileKeyboard(s, id)); }
    if (publicActionId === 'coins' || value === s.increase_coins_button) return sendIncreaseCoins(id, s);
    if (publicActionId === 'free_coins' || value === s.free_coins_button) return sendFreeCoins(id, s);
    if (publicActionId === 'plus' || value === s.plus_button) return sendPlus(id, s);
    if (publicActionId === 'back' || value === s.back_button || value === 'بازگشت') return send(id, publicAppearance(s).message, mainKeyboard(s));
    if (me.action_state === 'plus_emoji') {
      const requiredCount = isOwner(id) ? 3 : isAdmin(id) ? 2 : 1;
      if (!emojiSequence(value, requiredCount)) return send(id, `دقیقاً ${requiredCount} ایموجی ارسال کن.`, emojiKeyboard(s));
      await client.query('UPDATE users SET plus_emoji=$2, updated_at=NOW() WHERE telegram_id=$1', [id, value]);
      await updateAction(client, id, null);
      return send(id, `نشان پلاس شما روی ${value} تنظیم شد.`, profileKeyboard(s, id));
    }
    // A stale anonymous-link state must never swallow the normal connect button.
    if (publicActionId === 'connect' || value === s.connect_button) {
      await updateAction(client, id, null);
      client.release();
      released = true;
      return handleConnect(id);
    }
    if (isAdmin(id) && me.action_state?.startsWith('rename:')) {
      const key = me.action_state.slice('rename:'.length); const renamed = value.slice(0, 64);
      if (!renamed) return send(id, 'نام دکمه نمی‌تواند خالی باشد.');
      await client.query("INSERT INTO bot_settings(key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value", [key, renamed]); await updateAction(client, id, null); return send(id, 'نام دکمه ذخیره شد.', adminKeyboard(s.bot_enabled));
    }
    if (me.action_state?.startsWith('anon_')) {
      const flow = flowFor(s);
      if (me.action_state === 'anon_done' && (publicActionId === 'connect' || value === s.connect_button)) {
        await updateAction(client, id, null);
        client.release();
        released = true;
        return handleConnect(id);
      }
      if (me.action_state === 'anon_done' && (publicActionId === 'anonymous_link' || value === ANONYMOUS_LINK_BUTTON)) {
        client.release();
        released = true;
        return flow.handleLinkButton(id);
      }
      client.release();
      released = true;
      return flow.handleText(id, value, me.action_state);
    }
    if (publicActionId === 'anonymous_link' || value === ANONYMOUS_LINK_BUTTON) {
      client.release();
      released = true;
      return flowFor(s).handleLinkButton(id);
    }
    if (me.action_state === 'choose_gender' || me.action_state?.startsWith('choose_gender_for:')) {
      const pendingMatch = me.action_state.match(/^choose_gender_for:(male|female|any)$/)?.[1];
      const normalized = normalizeFa(value);
      const gender = publicActionId === 'male' ? 'male' : publicActionId === 'female' ? 'female' : [normalizeFa(GENDER_LABELS.male), 'پسر'].includes(normalized) ? 'male' : [normalizeFa(GENDER_LABELS.female), 'دختر'].includes(normalized) ? 'female' : null;
      if (!gender) return send(id, 'یکی از دو گزینهٔ جنسیت خودت را انتخاب کن.', genderKeyboard(s));
      await client.query('UPDATE users SET gender=$2, action_state=$3, updated_at=NOW() WHERE telegram_id=$1', [id, gender, pendingMatch ? null : 'choose_preference']);
      if (pendingMatch) return searchByPreference(id, pendingMatch, s);
      return send(id, screenText(publicAppearance(s), 'preference', appearanceFeedback(publicAppearance(s), 'connect_prompt', 'دوست داری به چه کسی وصل شوی؟')), preferenceKeyboard(s));
    }
    if (me.action_state === 'choose_preference') {
      const preference = ['male', 'female', 'any'].includes(publicActionId) ? publicActionId : preferenceFromText(value);
      if (!preference) return send(id, screenText(publicAppearance(s), 'preference', 'یکی از گزینه‌های جنسیت را انتخاب کن.'), preferenceKeyboard(s));
      if (!['male', 'female'].includes(me.gender)) {
        await updateAction(client, id, `choose_gender_for:${preference}`);
        return send(id, screenText(publicAppearance(s), 'gender', OWN_GENDER_PROMPT), genderKeyboard(s));
      }
      return searchByPreference(id, preference, s);
    }
    const preferenceText = preferenceFromText(value);
    const resolvedPreferenceText = ['male', 'female', 'any'].includes(publicActionId) ? publicActionId : preferenceText;
    if (resolvedPreferenceText && me.status === 'waiting') return send(id, 'وضعیت فعلی: هنوز در صف انتظار هستی؛ برای لغو دکمه انصراف را بزن.', waitingKeyboard(s));
    // preferenceText && me.status === 'idle' remains the legacy branch; resolvedPreferenceText adds renamed-label support.
    if (resolvedPreferenceText && me.status === 'idle') {
      if (!['male', 'female'].includes(me.gender)) {
        await updateAction(client, id, `choose_gender_for:${resolvedPreferenceText}`);
        return send(id, screenText(publicAppearance(s), 'gender', OWN_GENDER_PROMPT), genderKeyboard(s));
      }
      return searchByPreference(id, resolvedPreferenceText, s);
    }
    if ((publicActionId === 'cancel' || value === s.cancel_button) && me.status === 'waiting') { await leaveWaiting(id); return send(id, 'از صف انتظار خارج شدی.', mainKeyboard(s)); }
    if ((publicActionId === 'disconnect' || value === s.disconnect_button) && me.status === 'chatting') {
      const started = me.conversation_started_at ? new Date(me.conversation_started_at).getTime() : Date.now(); const elapsed = (Date.now() - started) / 1000; const minSeconds = Number(parseDuration(await botSettingValue(client, 'min_chat_duration', '15S')) ?? STOP_MIN_SECONDS);
      if (elapsed < minSeconds) return send(id, `این مکالمه تا ${Math.ceil(minSeconds - elapsed)} ثانیه دیگر قابل قطع نیست.`, chatKeyboard(s, isAdmin(id)));
      await updateAction(client, id, 'confirm_stop'); return send(id, screenText(publicAppearance(s), 'confirm_stop', 'مطمئنی مکالمه قطع بشه؟'), confirmStopKeyboard(s));
    }
    if (me.action_state === 'confirm_stop') {
      if (publicActionId === 'continue' || value === 'نه ادامه میدم') { await updateAction(client, id, null); return send(id, 'ادامه بده؛ مکالمه برقرار است.', chatKeyboard(s)); }
      if (publicActionId === 'confirm' || value === 'اره مطمئنم') {
        const partnerId = await disconnect(id); await updateAction(client, id, 'after_stop'); if (partnerId) await send(partnerId, 'مکالمه از طرف مقابل شما بسته شد.', mainKeyboard(s)); return send(id, 'مکالمه بسته شد. دوست داری چه کار کنی؟', afterStopKeyboard(s));
      }
      return send(id, 'یکی از گزینه‌ها را انتخاب کن.', confirmStopKeyboard(s));
    }
    if (me.action_state === 'after_stop') {
      if (publicActionId === 'later' || value === 'بعدا وصلش کن') { await updateAction(client, id, null); return send(id, 'باشه؛ هر زمان خواستی دوباره وصل شو.', mainKeyboard(s)); }
      if (publicActionId === 'block' || value === 'بلاکش کن') { await updateAction(client, id, 'choose_block_reason'); return send(id, screenText(publicAppearance(s), 'block_reason', 'به چه دلیلی بلاک بشه؟'), blockKeyboard(s)); }
      return send(id, 'یکی از گزینه‌ها را انتخاب کن.', afterStopKeyboard(s));
    }
    if (me.action_state === 'choose_block_reason') {
      const entries = Object.entries(BLOCK_REASONS); const found = Object.hasOwn(BLOCK_REASONS, publicActionId) ? [publicActionId, BLOCK_REASONS[publicActionId]] : entries.find(([, label]) => label === value);
      if (publicActionId === 'later' || value === 'بذار بعدا هم وصل بشم') { await updateAction(client, id, null); return send(id, 'باشه؛ هر زمان خواستی دوباره وصل شو.', mainKeyboard(s)); }
      if (!found) return send(id, 'یکی از دلایل را انتخاب کن.', blockKeyboard(s));
      const target = me.last_partner_id ? Number(me.last_partner_id) : null;
      if (!target) return send(id, 'این مکالمه قبلاً بسته شده است.', mainKeyboard(s));
      await block(id, target, found[1]); await updateAction(client, id, null); await send(target, `مکالمه بسته شد و طرف مقابل شما را بلاک کرد. دلیل: ${found[1]}`); return send(id, 'کاربر بلاک شد و دلیل ثبت گردید.', mainKeyboard(s));
    }
    if ((value === '🎛 کنترل کاربر' || value === 'کنترل کاربران' || value === 'کنترل این کاربر') && isAdmin(id) && me.status === 'chatting' && me.partner_id) {
      const panel = await adminUserPanel(client, id, Number(me.partner_id)); await updateAction(client, id, `admin:user_control:${me.partner_id}`); return send(id, panel.text, panel.markup);
    }
    if (value === 'بازی' && me.status === 'chatting' && me.partner_id) { if (s.mid_chat_games_enabled === 'false') return send(id, 'بازی میان چت فعلاً غیرفعال است.', chatKeyboard(s, isAdmin(id))); return send(id, 'بازی موردنظر را انتخاب کن:', entertainmentKeyboard('games')); }
    if (value === 'ایده صحبت' && me.status === 'chatting' && me.partner_id) { if (s.mid_chat_ideas_enabled === 'false') return send(id, 'ایدهٔ صحبت میان چت فعلاً غیرفعال است.', chatKeyboard(s, isAdmin(id))); return send(id, 'یک ایده برای ادامه مکالمه انتخاب کن:', entertainmentKeyboard('ideas')); }
    if (me.status !== 'chatting' || !me.partner_id) return send(id, 'برای شروع، دکمه اتصال را بزن.', mainKeyboard(s));
    const target = Number(me.partner_id);
    const blocked = await client.query(
      'SELECT 1 FROM anonymous_blocks WHERE user_low=LEAST($1::bigint,$2::bigint) AND user_high=GREATEST($1::bigint,$2::bigint) AND expires_at > NOW()',
      [target, id]
    );
    if (blocked.rowCount) return send(id, 'این گفتگو دیگر در دسترس نیست.', mainKeyboard(s));
    const targetUser = await user(client, target);
    await send(target, formatPremiumMessage(me, id, text)); await client.query('UPDATE users SET last_action_at=NOW(), updated_at=NOW() WHERE telegram_id=$1', [id]);
  } finally { if (!released) client.release(); }
}

async function activeBanFor(id) {
  const result = await pool.query('SELECT banned_until FROM users WHERE telegram_id=$1 AND banned_until IS NOT NULL AND banned_until > NOW()', [id]);
  return result.rows[0] || null;
}
function bannedMessage(row) { return `حساب شما توسط مدیریت بن شده است.\nبن تا: ${iranDate(row.banned_until)}\nدر این مدت امکان استفاده از ربات را نداری.`; }

async function processUpdate(update) {
  const inserted = await pool.query('INSERT INTO processed_updates (update_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING update_id', [update.update_id]);
  if (!inserted.rowCount) return;
  const callback = update.callback_query;
  const callbackData = String(callback?.data || '');
  const mandatoryAdminControl = /^mandatory:(details|activate|schedule|pause|cancel|resume):/.test(callbackData);
  if (callback?.from && (callback.message?.chat?.type === 'private' || mandatoryAdminControl)) {
    await answerCallback(callback.id);
    const callbackId = Number(callback.from.id);
    if (!isAdmin(callbackId)) { const ban = await activeBanFor(callbackId); if (ban) { await send(callbackId, bannedMessage(ban)); return; } }
    await handleCallback(Number(callback.from.id), callbackData, callback); return;
  }
  const message = update.message;
  if (!message?.from || message.from.is_bot || message.chat?.type !== 'private' || message.chat.id !== message.from.id) return;
  const id = Number(message.from.id); const text = String(message.text || message.caption || '').trim(); const forwardedUserId = contactTargetIdFromMessage(message); if (!text && !forwardedUserId) return;
  if (!isAdmin(id)) { const ban = await activeBanFor(id); if (ban) return send(id, bannedMessage(ban)); }
  if (message.from.username) await pool.query('INSERT INTO users (telegram_id,username) VALUES ($1,$2) ON CONFLICT (telegram_id) DO UPDATE SET username=EXCLUDED.username,updated_at=NOW()', [id, message.from.username]);
    if (text.startsWith('/') && isAdmin(id)) { const stateClient = await pool.connect(); try { const state = (await stateClient.query('SELECT action_state FROM users WHERE telegram_id=$1', [id])).rows[0]?.action_state; if (state === 'admin:daily_coin:command') return handleText(id, text, { forwardedUserId }); } finally { stateClient.release(); } }
    if (text.startsWith('/')) {
      const [rawCommand, payload] = text.split(/\s+/, 2);
      const command = rawCommand.toLowerCase().split('@')[0];
      if (/^\/\d{3,20}$/.test(command) || /^\/@[A-Za-z0-9_]{3,32}$/.test(command)) { if (!isAdmin(id)) return send(id, 'این دستور فقط برای مدیران و ادمین‌های مجاز فعال است.'); return openAdminUserPanel(id, command.slice(1)); }
      if (command === '/gift' || command === '/کد') { const client = await pool.connect(); try { return redeemGift(client, id, payload); } finally { client.release(); } }
      { const client = await pool.connect(); try { const dailyCommand = (await botSettingValue(client, 'daily_coin_command', '/daily')).toLowerCase(); if (command === dailyCommand) return claimDailyCoins(client, id); } finally { client.release(); } }
      const trackingKey = parseTrackingCommand(rawCommand);
      if (trackingKey) {
        if (!isAdmin(id)) return send(id, 'دستور پیگیری فقط برای مدیران ربات فعال است.');
        const client = await pool.connect();
        try { return await sendMandatoryTrackingDetails(client, id, { lookupKey: trackingKey }); }
        finally { client.release(); }
      }
      if (['/user', '/کاربر', '/کنترل', '/کنترل_کاربر', '/controluser'].includes(command)) {
        if (!isAdmin(id)) return send(id, 'این دستور فقط برای مدیران و ادمین‌های مجاز فعال است.');
        if (!payload || !/^@?[A-Za-z0-9_]{3,32}$/.test(payload) && !/^\d{3,20}$/.test(payload)) {
          const client = await pool.connect();
          try { await updateAction(client, id, 'admin:user_control_lookup'); } finally { client.release(); }
          return send(id, 'آیدی عددی کاربر را بفرست.', userControlKeyboard());
        }
        return openAdminUserPanel(id, payload);
      }
      if (/^\/[a-z0-9_-]{3,64}$/i.test(command) && !['/plus','/admin','/owner','/start','/help','/manpin'].includes(command)) { const client = await pool.connect(); try { return redeemGift(client, id, command.slice(1)); } finally { client.release(); } }
      if (['/plus', '/admin', '/owner'].includes(command)) return handlePremiumRoleCommand(id, command);
      if (command === '/start') return handleStart(id, payload || null);
      if (command === '/help') return handleStart(id);
    if (command === '/manpin' && isAdmin(id)) { const c = await pool.connect(); try { const s = await settings(c); return send(id, `${privateAppearance(s).message}\n\nوضعیت ربات: ${s.bot_enabled ? 'روشن' : 'خاموش'}`, adminMainKeyboard(s)); } finally { c.release(); } }
    return send(id, 'از دکمه‌های ربات استفاده کن.', mainKeyboard(await settings(pool)));
  }
  return handleText(id, text, { forwardedUserId });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET; const supplied = req.headers['x-telegram-bot-api-secret-token'];
  if (!expected || supplied !== expected) return res.status(401).json({ ok: false, error: 'unauthorized' });
  // Acknowledge Telegram immediately. Processing may involve Telegram API calls and
  // must not hold the webhook open long enough for Telegram to retry the update.
  res.status(200).json({ ok: true });
  try { await ensureRuntimeSchema(); await processUpdate(req.body || {}); }
  catch (error) {
    console.error('webhook_error', error?.message || error);
    const fromId = req.body?.callback_query?.from?.id || req.body?.message?.from?.id;
    if (fromId) {
      try { await send(Number(fromId), 'در پردازش درخواست مشکلی پیش آمد؛ لطفاً دوباره تلاش کن.'); }
      catch (sendError) { console.error('webhook_fallback_send_error', sendError?.message || sendError); }
    }
  }
}

export async function runCryptoDepositScan() { return { scanned: 0, processed: 0, note: 'no crypto scan configured' }; }
export async function runMandatoryLifecycle() {
  await ensureRuntimeSchema();
  const client = await pool.connect();
  try {
    const telegramJobCall = (method, body) => telegram(method, body, { timeoutMs: 3_000 });
    const sendAdminJob = (chatId, text, markup) => telegramJobCall('sendMessage', { chat_id: chatId, text, protect_content: true, ...(markup ? { reply_markup: markup.reply_markup || markup } : {}) });
    return await processMandatoryLifecycle(client, { telegramCall: telegramJobCall, sendAdmin: sendAdminJob, backfillLimit: 1, changedReportLimit: 1 });
  } finally { client.release(); }
}

export async function prepareBotDatabase() { return ensureRuntimeSchema(); }

export { DEFAULTS, BLOCK_REASONS, STOP_MIN_SECONDS, normalizeFa, preferenceFromText, publicAppearance, privateAppearance, appearanceItems };
