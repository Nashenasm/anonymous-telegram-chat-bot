import { Pool } from 'pg';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createAnonymousFlow } from '../src/anonymous-flow.js';
import { decodeTrackingCode, formatMandatorySourceDetails, getMandatorySourceDetails, getMandatorySourceHistory, mandatorySourceKeyboard, mandatoryTrackingListKeyboard, parseTrackingCommand, processMandatoryLifecycle, recordMandatorySourceHistory, syncMandatoryReport, trackingCommand } from '../src/mandatory-service.js';
import { DEFAULT_MANDATORY_AUDIENCE, mandatoryAudienceIncludesUser, mandatoryAudienceLabels, mandatoryAudienceReviewKeyboard, mandatoryAudienceSelectionKeyboard, normalizeMandatoryAudience, toggleMandatoryAudience } from '../src/mandatory-audience.js';
import { encryptMandatoryTrackingUserId } from '../src/mandatory-tracking-token.js';
import { APPEARANCE_SECTIONS, appearanceButton, appearanceFeedback, appearanceItems, appearanceKeyboard, normalizeAppearance, screenKeyboard, screenText, setAppearancePath, templateAppearance, templateIdFromText, templateListText } from '../src/appearance.js';
import { collectServerStatus, createDatabaseBackup, createSourceArchive, removeTempFile } from '../src/technical-tools.js';

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
        await client.query(`CREATE TABLE IF NOT EXISTS anonymous_blocks (
          user_low BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
          user_high BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),
          PRIMARY KEY (user_low, user_high), CHECK (user_low < user_high)
        )`);
        await client.query('ALTER TABLE anonymous_blocks ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ');
        await client.query("UPDATE anonymous_blocks SET expires_at = created_at + INTERVAL '7 days' WHERE expires_at IS NULL");
        await client.query("ALTER TABLE anonymous_blocks ALTER COLUMN expires_at SET DEFAULT (NOW() + INTERVAL '7 days')");
        await client.query('ALTER TABLE anonymous_blocks ALTER COLUMN expires_at SET NOT NULL');
        await client.query("INSERT INTO bot_settings(key, value) VALUES ('unblock_all_v1', 'pending') ON CONFLICT (key) DO NOTHING");
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
          ('mid_chat_ad_enabled', 'false'), ('mid_chat_ad_minutes', '15'), ('appearance_public_enabled', 'true'), ('appearance_private_enabled', 'true'), ('appearance_public', '{}'), ('appearance_private', '{}')
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
function mainKeyboard(settings) { const a = publicAppearance(settings); return replyKeyboard(appearanceKeyboard(a)); }
function profileKeyboard(settings) { return replyKeyboard(screenKeyboard(publicAppearance(settings), 'profile', [['ظاهر ایموجی پلاس'], [settings.back_button]]), true); }
function increaseCoinsKeyboard(settings) { return replyKeyboard(screenKeyboard(publicAppearance(settings), 'coins', [[settings.free_coins_button], [settings.back_button]]), true); }
function emojiKeyboard(settings) { return replyKeyboard(screenKeyboard(publicAppearance(settings), 'emoji', [['ریست ایموجی'], [settings.back_button]]), true); }
function plusKeyboard(settings) { return replyKeyboard(screenKeyboard(publicAppearance(settings), 'plus', [[settings.back_button]]), true); }
function plusPurchaseKeyboard() { return { reply_markup: { inline_keyboard: [[{ text: 'پلاس 1 ماهه⭐', callback_data: 'plus:buy:1' }], [{ text: 'پلاس 3 ماهه🌟', callback_data: 'plus:buy:3' }], [{ text: 'پلاس 6 ماهه✨', callback_data: 'plus:buy:6' }], [{ text: 'پلاس 12 ماهه💎', callback_data: 'plus:buy:12' }]] } }; }
function plusConfirmKeyboard() { return { reply_markup: { inline_keyboard: [[{ text: 'بله تایید میکنم', callback_data: 'plus:confirm' }, { text: 'خیر بعدا میخرم', callback_data: 'plus:cancel' }]] } }; }
function adminMainKeyboard(settings = {}) { const a = privateAppearance(settings); return replyKeyboard(appearanceKeyboard(a)); }
function reportsKeyboard(settings = {}) { return replyKeyboard(screenKeyboard(privateAppearance(settings), 'reports', [['گزارش‌های کاربران', 'کانال های گزارش دهی'], ['بخش فنی'], ['بازگشت پنل']]), true); }
function reportChannelKeyboard() { return replyKeyboard([['اتصال/تغییر کانال'], ['قطع اتصال کانال گزارش‌دهی'], ['بازگشت']], true); }
function adsKeyboard(settings = {}) { return replyKeyboard(screenKeyboard(privateAppearance(settings), 'ads', [['جویین اجباری', 'پیام همگانی'], ['پیام خوش‌آمد', 'تبلیغ اتصال'], ['تبلیغ میان مکالمه'], ['بازگشت پنل']]), true); }
function controlKeyboard(settings = {}) { return replyKeyboard(screenKeyboard(privateAppearance(settings), 'control', [['بخش ظاهری پابلیک'], ['بخش ظاهری پرایویسی'], ['قالب‌های آماده'], ['روشن/خاموش کردن ربات'], ['بازگشت پنل']]), true); }
function genderKeyboard(settings = {}) { return replyKeyboard(screenKeyboard(publicAppearance(settings), 'gender', [[GENDER_LABELS.male, GENDER_LABELS.female]]), true); }
export function preferenceKeyboard(settings = {}) { return replyKeyboard(screenKeyboard(publicAppearance(settings), 'preference', [[PREF_LABELS.male, PREF_LABELS.female, PREF_LABELS.any]]), true); }
function waitingKeyboard(settings) { return replyKeyboard(screenKeyboard(publicAppearance(settings), 'waiting', [[appearanceButton(publicAppearance(settings), 'cancel', settings.cancel_button)]])); }
function chatKeyboard(settings) { return replyKeyboard(screenKeyboard(publicAppearance(settings), 'chat', [[appearanceButton(publicAppearance(settings), 'disconnect', settings.disconnect_button)]])); }
function confirmStopKeyboard(settings = {}) { return replyKeyboard(screenKeyboard(publicAppearance(settings), 'confirm_stop', [['اره مطمئنم', 'نه ادامه میدم']]), true); }
function afterStopKeyboard(settings = {}) { return replyKeyboard(screenKeyboard(publicAppearance(settings), 'after_stop', [['بلاکش کن'], ['بعدا وصلش کن']]), true); }
function blockKeyboard(settings = {}) { return replyKeyboard(screenKeyboard(publicAppearance(settings), 'block_reason', [[BLOCK_REASONS.rude], [BLOCK_REASONS.abusive], [BLOCK_REASONS.wrong_gender], [BLOCK_REASONS.advertising], ['بذار بعدا هم وصل بشم']]), true); }
function adminKeyboard(enabled) { return adminMainKeyboard(); }
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

async function telegram(method, body, { timeoutMs = 8_000 } = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is missing');
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
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
  for (const row of appearance.buttons || []) for (const item of row || []) if (item.label === value) return item.id;
  return null;
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
    return send(id, text, profileKeyboard(settings));
  } finally { client.release(); }
}
async function adminStats(client) {
  const r = await client.query(`SELECT COUNT(*) FILTER (WHERE TRUE) AS users, COUNT(*) FILTER (WHERE status='waiting') AS waiting, COUNT(*) FILTER (WHERE status='chatting') AS chatting, (SELECT COUNT(*) FROM reports WHERE status='open') AS reports FROM users`);
  const x = r.rows[0];
  return `وضعیت ربات\n\nکاربران: ${x.users}\nدر صف انتظار: ${x.waiting}\nمکالمه‌های فعال: ${x.chatting}\nگزارش‌های باز: ${x.reports}`;
}
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
    // Serialize queue searches so two simultaneous searches do not each skip the other's locked row.
    await client.query('SELECT pg_advisory_xact_lock(20260925, 1)');
    await client.query('SELECT telegram_id FROM users WHERE telegram_id=$1 FOR UPDATE', [id]);
    const candidate = await client.query(`
      SELECT candidate.telegram_id, candidate.gender FROM users AS candidate
      WHERE candidate.status='waiting' AND candidate.telegram_id<>$1
        AND candidate.gender IN ('male','female')
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
      LIMIT 1 FOR UPDATE SKIP LOCKED`, [id, preference, me.gender]);
    if (!candidate.rows[0]) {
      await client.query("UPDATE users SET status='waiting', match_preference=$2, partner_id=NULL, action_state=NULL, updated_at=NOW() WHERE telegram_id=$1", [id, preference]);
      await client.query('COMMIT');
      return { kind: 'waiting' };
    }
    const other = Number(candidate.rows[0].telegram_id);
    await client.query("UPDATE users SET status='chatting', partner_id=$2, conversation_started_at=NOW(), action_state=NULL, updated_at=NOW() WHERE telegram_id=$1", [id, other]);
    await client.query("UPDATE users SET status='chatting', partner_id=$2, conversation_started_at=NOW(), action_state=NULL, updated_at=NOW() WHERE telegram_id=$1", [other, id]);
    await client.query('COMMIT');
    return { kind: 'paired', partnerId: other };
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
async function searchByPreference(id, preference, s) {
  if (!['male', 'female', 'any'].includes(preference)) return send(id, screenText(publicAppearance(s), 'preference', 'یکی از سه گزینهٔ پسر، دختر یا مهم نیست را انتخاب کن.'), preferenceKeyboard(s));
  const result = await findPair(id, preference);
  if (result.kind === 'missing_gender') {
    await pool.query('UPDATE users SET action_state=$2, updated_at=NOW() WHERE telegram_id=$1', [id, `choose_gender_for:${preference}`]);
    return send(id, screenText(publicAppearance(s), 'gender', OWN_GENDER_PROMPT), genderKeyboard(s));
  }
  if (result.kind === 'already_chatting') return send(id, 'هنوز در یک مکالمه هستی.', chatKeyboard(s));
  if (result.kind === 'paired') {
    await sendConnectionNotice(id, s, chatKeyboard(s));
    await sendConnectionNotice(result.partnerId, s, chatKeyboard(s));
    return;
  }
  return send(id, appearanceFeedback(publicAppearance(s), 'waiting', 'در صف انتظار قرار گرفتی؛ هنوز کسی با این انتخاب پیدا نشده است. به‌محض اتصال خبرت می‌دهم.'), waitingKeyboard(s));
}
async function sendConnectionNotice(id, s, keyboard) {
  const c = await pool.connect();
  try {
    const me = await user(c, id); const exempt = isPlus(me, id) || isAdmin(id) || isOwner(id);
    return send(id, exempt ? appearanceFeedback(publicAppearance(s), 'connected', 'اتصال برقرار شد؛ گفت‌وگو را شروع کن.') : (s.connected_message || DEFAULTS.connected_message), keyboard);
  } finally { c.release(); }
}
async function leaveWaiting(id) { await pool.query("UPDATE users SET status='idle', partner_id=NULL, action_state=NULL, updated_at=NOW() WHERE telegram_id=$1 AND status='waiting'", [id]); }
async function disconnect(id) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const me = await user(client, id); const partnerId = me?.partner_id ? Number(me.partner_id) : null;
    if (partnerId) await client.query("UPDATE users SET status='idle', partner_id=NULL, last_partner_id=$3, conversation_started_at=NULL, action_state=NULL, updated_at=NOW() WHERE telegram_id IN ($1,$2)", [id, partnerId, partnerId]);
    else await client.query("UPDATE users SET status='idle', partner_id=NULL, conversation_started_at=NULL, action_state=NULL, updated_at=NOW() WHERE telegram_id=$1", [id]);
    await client.query('COMMIT'); return partnerId;
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
async function block(id, targetId, reason) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO anonymous_blocks (user_low, user_high, expires_at)
       VALUES (LEAST($1::bigint,$2::bigint), GREATEST($1::bigint,$2::bigint), NOW() + INTERVAL '7 days')
       ON CONFLICT (user_low, user_high) DO UPDATE SET created_at=NOW(), expires_at=NOW() + INTERVAL '7 days'`,
      [id, targetId]
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
    const months = Number(match[1]); const price = PLUS_PRICES[months];
    await updateAction(client, id, `plus_confirm:${months}`);
    return send(id, `موجودی مانو کوین: ${Number(me.coins || 0)}\nمحصول: پلاس ${months} ماهه\nقیمت: ${price} مانو کوین\n\nخرید را تایید می‌کنید؟`, plusConfirmKeyboard());
  }
  if (data === 'plus:cancel') { await updateAction(client, id, null); return sendPlus(id, s); }
  if (data === 'plus:confirm') {
    const months = Number(String(me.action_state || '').split(':')[1]); const price = PLUS_PRICES[months];
    if (!price) return sendPlus(id, s);
    const tx = await pool.connect();
    try {
      await tx.query('BEGIN');
      const locked = await tx.query('SELECT coins, plus_expires_at FROM users WHERE telegram_id=$1 FOR UPDATE', [id]);
      const row = locked.rows[0];
      if (!row || Number(row.coins) < price) { await tx.query('ROLLBACK'); await updateAction(client, id, null); return send(id, 'موجودی مانو کوین شما برای این خرید کافی نیست.', plusPurchaseKeyboard()); }
      const base = row.plus_expires_at && new Date(row.plus_expires_at).getTime() > Date.now() ? new Date(row.plus_expires_at) : new Date();
      base.setUTCMonth(base.getUTCMonth() + months);
      await tx.query('UPDATE users SET coins=coins-$2, plus_expires_at=$3, plus_emoji=COALESCE(NULLIF(plus_emoji, \'\'), \'✨\'), action_state=NULL, updated_at=NOW() WHERE telegram_id=$1', [id, price, base]);
      await tx.query('INSERT INTO plus_purchases(telegram_id, months, price) VALUES ($1,$2,$3)', [id, months, price]);
      await tx.query('COMMIT');
      return send(id, `🎉 تبریک! خرید پلاس ${months} ماهه با موفقیت انجام شد.\nاکانت شما به مدت ${months} ماه پلاس شد.`, plusKeyboard(s));
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
  const legacy = { [s.connect_button]: 'connect', [s.cancel_button]: 'cancel', [s.disconnect_button]: 'disconnect', [s.profile_button]: 'profile', [s.increase_coins_button]: 'coins', [s.free_coins_button]: 'free_coins', [s.plus_button]: 'plus', [s.back_button]: 'back' };
  return legacy[text] || null;
}
async function handleText(id, text) {
  const client = await pool.connect();
  let released = false;
  try {
    const me = await ensureUser(client, id); const s = await settings(client);
    const value = text.trim();
    const publicActionId = visiblePublicAction(value, s);
    const privateActionId = visiblePrivateAction(value, s);
    if (isAdmin(id) && me.action_state?.startsWith('appearance:')) {
      if (value === 'بازگشت کنترل ربات') { await updateAction(client, id, null); return send(id, 'کنترل ربات', controlKeyboard()); }
      const handledAppearance = await handleAppearanceText(client, id, value, me.action_state, s);
      if (handledAppearance !== false) return handledAppearance;
    }
    if (isAdmin(id) && me.action_state === 'appearance:choose') {
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
    if (isAdmin(id) && me.action_state === 'admin:user_search') {
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
    if (privateAction === 'control') return send(id, appearanceFeedback(privateAppearance(s), 'control', 'کنترل ربات'), controlKeyboard(s));
    if (privateAction === 'users') { await updateAction(client, id, 'admin:user_search'); return send(id, appearanceFeedback(privateAppearance(s), 'users', 'آیدی عددی کاربر را بفرست.')); }
    if (privateAction === 'status') { const stats = await adminStats(client); return send(id, stats, adminMainKeyboard(s)); }
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
    if (isAdmin(id) && value === 'کنترل ربات') return send(id, 'کنترل ربات', controlKeyboard());
    if (isAdmin(id) && (privateActionId === 'public_appearance' || value === 'بخش ظاهری پابلیک')) return sendAppearanceEditor(id, client, 'public');
    if (isAdmin(id) && (privateActionId === 'private_appearance' || value === 'بخش ظاهری پرایویسی')) return sendAppearanceEditor(id, client, 'private');
    if (isAdmin(id) && (privateActionId === 'templates' || value === 'قالب‌های آماده')) { await updateAction(client, id, 'appearance:choose'); return send(id, 'قالب آماده را برای کدام بخش اعمال می‌کنی؟', replyKeyboard([['پابلیک'], ['پرایویسی'], ['بازگشت']], true)); }
    if (isAdmin(id) && value === 'کنترل کاربران') { await updateAction(client, id, 'admin:user_search'); return send(id, 'آیدی عددی کاربر را بفرست.'); }
    if (isAdmin(id) && value === 'وضعیت ربات') { const stats = await adminStats(client); return send(id, stats, adminMainKeyboard()); }
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
      if (!isPlus(me, id)) return send(id, 'این بخش فقط برای کاربران پلاس فعال است.', profileKeyboard(s));
      await updateAction(client, id, 'plus_emoji');
      return send(id, isOwner(id) ? 'سه ایموجی ارسال کن؛ نشان مالک فقط با سه ایموجی معتبر ذخیره می‌شود.' : isAdmin(id) ? 'دو ایموجی ارسال کن؛ نشان ادمین فقط با دو ایموجی معتبر ذخیره می‌شود.' : 'یک ایموجی دلخواه ارسال کن. فقط یک ایموجی مجاز است و متن یا شکل دیگری پذیرفته نمی‌شود.', emojiKeyboard(s));
    }
    if (publicActionId === 'reset' || value === 'ریست ایموجی') { await client.query("UPDATE users SET plus_emoji='✨', updated_at=NOW() WHERE telegram_id=$1", [id]); await updateAction(client, id, null); return send(id, 'ایموجی پلاس به ✨ برگردانده شد.', profileKeyboard(s)); }
    if (publicActionId === 'coins' || value === s.increase_coins_button) return sendIncreaseCoins(id, s);
    if (publicActionId === 'free_coins' || value === s.free_coins_button) return sendFreeCoins(id, s);
    if (publicActionId === 'plus' || value === s.plus_button) return sendPlus(id, s);
    if (publicActionId === 'back' || value === s.back_button || value === 'بازگشت') return send(id, publicAppearance(s).message, mainKeyboard(s));
    if (me.action_state === 'plus_emoji') {
      const requiredCount = isOwner(id) ? 3 : isAdmin(id) ? 2 : 1;
      if (!emojiSequence(value, requiredCount)) return send(id, `دقیقاً ${requiredCount} ایموجی ارسال کن.`, emojiKeyboard(s));
      await client.query('UPDATE users SET plus_emoji=$2, updated_at=NOW() WHERE telegram_id=$1', [id, value]);
      await updateAction(client, id, null);
      return send(id, `نشان پلاس شما روی ${value} تنظیم شد.`, profileKeyboard(s));
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
      const started = me.conversation_started_at ? new Date(me.conversation_started_at).getTime() : Date.now(); const elapsed = (Date.now() - started) / 1000;
      if (elapsed < STOP_MIN_SECONDS) return send(id, `این مکالمه تا ${Math.ceil(STOP_MIN_SECONDS - elapsed)} ثانیه دیگر قابل قطع نیست.`, chatKeyboard(s));
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

async function processUpdate(update) {
  const inserted = await pool.query('INSERT INTO processed_updates (update_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING update_id', [update.update_id]);
  if (!inserted.rowCount) return;
  const callback = update.callback_query;
  const callbackData = String(callback?.data || '');
  const mandatoryAdminControl = /^mandatory:(details|activate|schedule|pause|cancel|resume):/.test(callbackData);
  if (callback?.from && (callback.message?.chat?.type === 'private' || mandatoryAdminControl)) { await answerCallback(callback.id); await handleCallback(Number(callback.from.id), callbackData, callback); return; }
  const message = update.message;
  if (!message?.from || message.from.is_bot || message.chat?.type !== 'private' || message.chat.id !== message.from.id) return;
  const id = Number(message.from.id); const text = String(message.text || '').trim(); if (!text) return;
    if (text.startsWith('/')) {
      const [rawCommand, payload] = text.split(/\s+/, 2);
      const command = rawCommand.toLowerCase();
      const trackingKey = parseTrackingCommand(rawCommand);
      if (trackingKey) {
        if (!isAdmin(id)) return send(id, 'دستور پیگیری فقط برای مدیران ربات فعال است.');
        const client = await pool.connect();
        try { return await sendMandatoryTrackingDetails(client, id, { lookupKey: trackingKey }); }
        finally { client.release(); }
      }
      if (['/plus', '/admin', '/owner'].includes(command)) return handlePremiumRoleCommand(id, command);
      if (command === '/start') return handleStart(id, payload || null);
      if (command === '/help') return handleStart(id);
    if (command === '/manpin' && isAdmin(id)) { const c = await pool.connect(); try { const s = await settings(c); return send(id, `${privateAppearance(s).message}\n\nوضعیت ربات: ${s.bot_enabled ? 'روشن' : 'خاموش'}`, adminMainKeyboard(s)); } finally { c.release(); } }
    return send(id, 'از دکمه‌های ربات استفاده کن.', mainKeyboard(await settings(pool)));
  }
  return handleText(id, text);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET; const supplied = req.headers['x-telegram-bot-api-secret-token'];
  if (!expected || supplied !== expected) return res.status(401).json({ ok: false, error: 'unauthorized' });
  try { await ensureRuntimeSchema(); await processUpdate(req.body || {}); return res.status(200).json({ ok: true }); }
  catch (error) {
    console.error('webhook_error', error?.message || error);
    const fromId = req.body?.callback_query?.from?.id || req.body?.message?.from?.id;
    if (fromId) {
      try { await send(Number(fromId), 'در پردازش درخواست مشکلی پیش آمد؛ لطفاً دوباره تلاش کن.'); }
      catch (sendError) { console.error('webhook_fallback_send_error', sendError?.message || sendError); }
    }
    return res.status(200).json({ ok: false });
  }
}

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
