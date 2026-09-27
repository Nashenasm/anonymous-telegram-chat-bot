import { Pool } from 'pg';
import crypto from 'node:crypto';
import { createAnonymousFlow } from '../src/anonymous-flow.js';

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
        await client.query(`CREATE TABLE IF NOT EXISTS mandatory_sources (id BIGSERIAL PRIMARY KEY, tracking_code TEXT NOT NULL UNIQUE, source_type TEXT NOT NULL CHECK (source_type IN ('channel','group','bot','web_app','website')), visibility TEXT CHECK (visibility IN ('private','public')), title TEXT NOT NULL, target TEXT NOT NULL, join_url TEXT, mode TEXT NOT NULL CHECK (mode IN ('time','count','start','click')), quota INTEGER, duration_seconds INTEGER, starts_at TIMESTAMPTZ, status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('scheduled','active','paused','completed','failed','cancelled')), created_by BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE RESTRICT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
        await client.query(`CREATE TABLE IF NOT EXISTS mandatory_source_events (source_id BIGINT NOT NULL REFERENCES mandatory_sources(id) ON DELETE CASCADE, telegram_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE, event_type TEXT NOT NULL, confirmed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (source_id, telegram_id))`);
        await client.query(`CREATE TABLE IF NOT EXISTS mandatory_source_queue (id BIGSERIAL PRIMARY KEY, source_id BIGINT NOT NULL REFERENCES mandatory_sources(id) ON DELETE CASCADE, position INTEGER NOT NULL, queued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(source_id), UNIQUE(position))`);
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
          ('mid_chat_ad_enabled', 'false'), ('mid_chat_ad_minutes', '15')
          ON CONFLICT (key) DO NOTHING`);
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
function mainKeyboard(settings) { return replyKeyboard([[settings.connect_button, ANONYMOUS_LINK_BUTTON], [settings.profile_button], [settings.increase_coins_button, settings.plus_button]]); }
function profileKeyboard(settings) { return replyKeyboard([['ظاهر ایموجی پلاس'], [settings.back_button]], true); }
function increaseCoinsKeyboard(settings) { return replyKeyboard([[settings.free_coins_button], [settings.back_button]], true); }
function emojiKeyboard(settings) { return replyKeyboard([['ریست ایموجی'], [settings.back_button]], true); }
function plusKeyboard(settings) { return replyKeyboard([[settings.back_button]], true); }
function plusPurchaseKeyboard() { return { reply_markup: { inline_keyboard: [[{ text: 'پلاس 1 ماهه⭐', callback_data: 'plus:buy:1' }], [{ text: 'پلاس 3 ماهه🌟', callback_data: 'plus:buy:3' }], [{ text: 'پلاس 6 ماهه✨', callback_data: 'plus:buy:6' }], [{ text: 'پلاس 12 ماهه💎', callback_data: 'plus:buy:12' }]] } }; }
function plusConfirmKeyboard() { return { reply_markup: { inline_keyboard: [[{ text: 'بله تایید میکنم', callback_data: 'plus:confirm' }, { text: 'خیر بعدا میخرم', callback_data: 'plus:cancel' }]] } }; }
function adminMainKeyboard() { return replyKeyboard([['تبلیغات', 'کنترل ربات'], ['کنترل کاربران', 'وضعیت ربات'], ['گزارش‌ها', 'مدیران'], ['خروج از پنل']]); }
function adsKeyboard() { return replyKeyboard([['جویین اجباری', 'پیام همگانی'], ['پیام خوش‌آمد', 'تبلیغ اتصال'], ['تبلیغ میان مکالمه'], ['بازگشت پنل']], true); }
function controlKeyboard() { return replyKeyboard([['بخش ظاهری پابلیک'], ['بخش ظاهری پرایویسی'], ['روشن/خاموش کردن ربات'], ['بازگشت پنل']], true); }
function genderKeyboard() { return replyKeyboard([[GENDER_LABELS.male, GENDER_LABELS.female]], true); }
export function preferenceKeyboard() { return replyKeyboard([[PREF_LABELS.male, PREF_LABELS.female, PREF_LABELS.any]], true); }
function waitingKeyboard(settings) { return replyKeyboard([[settings.cancel_button]]); }
function chatKeyboard(settings) { return replyKeyboard([[settings.disconnect_button]]); }
function confirmStopKeyboard() { return replyKeyboard([['اره مطمئنم', 'نه ادامه میدم']], true); }
function afterStopKeyboard() { return replyKeyboard([['بلاکش کن'], ['بعدا وصلش کن']], true); }
function blockKeyboard() { return replyKeyboard([[BLOCK_REASONS.rude], [BLOCK_REASONS.abusive], [BLOCK_REASONS.wrong_gender], [BLOCK_REASONS.advertising], ['بذار بعدا هم وصل بشم']], true); }
function adminKeyboard(enabled) { return adminMainKeyboard(); }
function renameKeyboard() { return replyKeyboard([['دکمه اتصال'], ['دکمه انصراف'], ['دکمه قطع مکالمه']], true); }
function mandatoryJoinKeyboard() { return replyKeyboard([['حذف', 'افزودن'], ['وضعیت', 'خاموش/روشن'], ['کنترل ظاهری'], ['بازگشت پنل']], true); }
function mandatoryTypeKeyboard() { return replyKeyboard([['کانال', 'گروه'], ['ربات', 'وب اپ'], ['وب سایت'], ['بازگشت']], true); }
function mandatoryVisibilityKeyboard() { return replyKeyboard([['خصوصی', 'عمومی'], ['بازگشت']], true); }
function mandatoryModeKeyboard(type) { return replyKeyboard(type === 'bot' ? [['براساس زمان', 'براساس استارت'], ['بازگشت']] : [['براساس زمان', 'براساس میزان'], ['بازگشت']], true); }
function mandatoryActivationKeyboard() { return replyKeyboard([['زمان بندی کردن', 'شروع از الان'], ['ارسال به صف'], ['بازگشت']], true); }
function mandatoryConfirmKeyboard() { return replyKeyboard([['تایید نهایی'], ['بازگشت']], true); }
function mandatoryStatusKeyboard() { return replyKeyboard([['لیست زمان بندی', 'صف انتظار'], ['درحال انجام', 'امور پیگیری'], ['کنسل کردن', 'الان ست کن'], ['تغییر تایم'], ['بازگشت']], true); }

async function telegram(method, body) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is missing');
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(8_000),
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
function flowFor(settings) {
  const sendAsUser = async (senderId, recipientId, text, replyMarkup) => {
    const c = await pool.connect();
    try { const sender = await user(c, senderId); return send(recipientId, formatPremiumMessage(sender, senderId, text), replyMarkup); }
    finally { c.release(); }
  };
  return createAnonymousFlow({ pool, send, sendLink, sendAsUser, connectButton: settings.connect_button, disconnectButton: settings.disconnect_button });
}
async function answerCallback(id) { try { await telegram('answerCallbackQuery', { callback_query_id: id }); } catch (e) { console.error('callback_answer_error', e.message); } }

async function activeMandatorySources(client) {
  await client.query("UPDATE mandatory_sources SET status='active', updated_at=NOW() WHERE status='scheduled' AND starts_at IS NOT NULL AND starts_at <= NOW()");
  await client.query("UPDATE mandatory_sources SET status='completed', updated_at=NOW() WHERE status='active' AND mode='time' AND duration_seconds IS NOT NULL AND created_at + (duration_seconds * INTERVAL '1 second') <= NOW()");
  await client.query("UPDATE mandatory_sources ms SET status='completed', updated_at=NOW() WHERE ms.status='active' AND ms.mode IN ('count','start','click') AND ms.quota IS NOT NULL AND (SELECT COUNT(*) FROM mandatory_source_events e WHERE e.source_id=ms.id) >= ms.quota");
  const next = await client.query("SELECT q.id,q.source_id FROM mandatory_source_queue q JOIN mandatory_sources s ON s.id=q.source_id WHERE s.status='scheduled' ORDER BY q.position LIMIT 1");
  if (next.rows[0]) { await client.query("UPDATE mandatory_sources SET status='active', updated_at=NOW() WHERE id=$1", [next.rows[0].source_id]); await client.query('DELETE FROM mandatory_source_queue WHERE id=$1', [next.rows[0].id]); }
  return client.query("SELECT * FROM mandatory_sources WHERE status='active' AND (starts_at IS NULL OR starts_at <= NOW()) ORDER BY id");
}
async function telegramChatMember(target, userId) {
  try { const member = await telegram('getChatMember', { chat_id: target, user_id: userId }); return ['creator','administrator','member','restricted'].includes(member?.status); }
  catch (error) { console.error('mandatory_membership_check_error', error.message); return false; }
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
  if (!['channel', 'group'].includes(type)) return true;
  try {
    const me = await telegram('getMe', {}); const normalized = normalizeTelegramTarget(target); const chat = await telegram('getChat', { chat_id: normalized }); const member = await telegram('getChatMember', { chat_id: chat.id || normalized, user_id: me.id });
    return ['creator', 'administrator'].includes(member?.status);
  } catch (error) { console.error('mandatory_target_validation_error', error.message); return false; }
}
async function mandatoryRequirements(id, client) {
  const sources = await activeMandatorySources(client);
  const missing = [];
  for (const source of sources.rows) {
    if (!['channel','group'].includes(source.source_type)) continue;
    const joined = await telegramChatMember(normalizeTelegramTarget(source.target), id);
    if (!joined) missing.push(source);
    else await client.query("INSERT INTO mandatory_source_events(source_id, telegram_id, event_type) VALUES ($1,$2,'join') ON CONFLICT DO NOTHING", [source.id, id]);
  }
  return missing;
}
async function recordMandatoryStart(id, payload, client) {
  const code = String(payload || '').match(/^mj_([A-Za-z0-9_-]+)$/)?.[1];
  if (!code) return;
  await client.query("INSERT INTO mandatory_source_events(source_id,telegram_id,event_type) SELECT id,$2,'start' FROM mandatory_sources WHERE tracking_code=$1 AND source_type='bot' ON CONFLICT DO NOTHING", [code, id]);
}
function mandatoryJoinMessage(missing) {
  return `برای استفاده از ربات، ابتدا در منابع زیر عضو شو:\n\n${missing.map((x,i)=>`${i+1}) ${x.title}${x.join_url ? `\n${x.join_url}` : ''}`).join('\n\n')}\n\nبعد از عضویت دوباره /start را بفرست.`;
}
function mandatoryJoinMarkup(missing) {
  const rows = missing.filter(x => /^https?:\/\//i.test(String(x.join_url || ''))).map(x => [{ text: `عضویت: ${x.title}`, url: x.join_url }]);
  rows.push([{ text: 'تایید عضویت', callback_data: 'mandatory:verify' }]);
  return { reply_markup: { inline_keyboard: rows } };
}
async function settings(client) {
  const result = await client.query('SELECT key, value FROM bot_settings');
  const out = { ...DEFAULTS, bot_enabled: 'true' };
  for (const row of result.rows) out[row.key] = row.value;
  return { ...out, bot_enabled: out.bot_enabled !== 'false' };
}
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
  if (!['male', 'female', 'any'].includes(preference)) return send(id, 'یکی از سه گزینهٔ پسر، دختر یا مهم نیست را انتخاب کن.', preferenceKeyboard());
  const result = await findPair(id, preference);
  if (result.kind === 'missing_gender') {
    await pool.query('UPDATE users SET action_state=$2, updated_at=NOW() WHERE telegram_id=$1', [id, `choose_gender_for:${preference}`]);
    return send(id, OWN_GENDER_PROMPT, genderKeyboard());
  }
  if (result.kind === 'already_chatting') return send(id, 'هنوز در یک مکالمه هستی.', chatKeyboard(s));
  if (result.kind === 'paired') {
    await sendConnectionNotice(id, s, chatKeyboard(s));
    await sendConnectionNotice(result.partnerId, s, chatKeyboard(s));
    return;
  }
  return send(id, 'در صف انتظار قرار گرفتی؛ هنوز کسی با این انتخاب پیدا نشده است. به‌محض اتصال خبرت می‌دهم.', waitingKeyboard(s));
}
async function sendConnectionNotice(id, s, keyboard) {
  const c = await pool.connect();
  try {
    const me = await user(c, id); const exempt = isPlus(me, id) || isAdmin(id) || isOwner(id);
    return send(id, exempt ? 'اتصال برقرار شد؛ گفت‌وگو را شروع کن.' : (s.connected_message || DEFAULTS.connected_message), keyboard);
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
    if (payload !== null) await recordMandatoryStart(id, payload, client);
    if (!isAdmin(id)) {
      const missing = await mandatoryRequirements(id, client);
      if (missing.length) return send(id, mandatoryJoinMessage(missing), mandatoryJoinMarkup(missing));
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
    return send(id, first ? `${s.welcome_message || DEFAULTS.welcome_message}\n\n🎁 برای ورود اول، ۲۰ مانو کوین هدیه گرفتی.` : (s.welcome_message || DEFAULTS.welcome_message), mainKeyboard(s));
  } finally { if (!released) client.release(); }
}

async function handleConnect(id) {
  const client = await pool.connect(); try {
    const me = await ensureUser(client, id); const s = await settings(client);
    if (!isAdmin(id)) {
      const missing = await mandatoryRequirements(id, client);
      if (missing.length) return send(id, mandatoryJoinMessage(missing), mandatoryJoinMarkup(missing));
    }
    if (!s.bot_enabled && !isAdmin(id)) return send(id, 'ربات موقتاً خاموش است.');
    if (me.status === 'chatting') return send(id, 'وضعیت فعلی: به یک ناشناس وصل هستی و مکالمه برقرار است.', chatKeyboard(s));
    await updateAction(client, id, 'choose_preference'); return send(id, 'دوست داری به چه کسی وصل شوی؟', preferenceKeyboard());
  } finally { client.release(); }
}

async function handleCallback(id, data) {
  if (data === 'mandatory:verify') {
    const c = await pool.connect();
    try {
      const missing = await mandatoryRequirements(id, c);
      if (missing.length) return send(id, mandatoryJoinMessage(missing), mandatoryJoinMarkup(missing));
      return send(id, '✅ عضویت شما در همهٔ منابع فعال تایید شد. حالا می‌توانی از ربات استفاده کنی.', mainKeyboard(await settings(c)));
    } finally { c.release(); }
  }
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
      return send(id, 'دوست داری به چه کسی وصل شوی؟', preferenceKeyboard());
    }
    if (data.startsWith('pref:')) {
      const preference = data.slice('pref:'.length);
      if (!['male', 'female', 'any'].includes(preference)) return send(id, 'گزینهٔ جستجو معتبر نیست.', mainKeyboard(s));
      if (!['male', 'female'].includes(me.gender)) {
        await updateAction(sClient, id, `choose_gender_for:${preference}`);
        return send(id, OWN_GENDER_PROMPT, genderKeyboard());
      }
      return searchByPreference(id, preference, s);
    }
    if (data === 'cancel_wait') { await leaveWaiting(id); return send(id, 'از صف انتظار خارج شدی.', mainKeyboard(s)); }
    if (data === 'stop') {
      const meNow = await user(sClient, id); if (!meNow?.partner_id) return send(id, 'در حال حاضر در مکالمه‌ای نیستی.', mainKeyboard(s));
      const started = meNow.conversation_started_at ? new Date(meNow.conversation_started_at).getTime() : Date.now(); const elapsed = (Date.now() - started) / 1000;
      if (elapsed < STOP_MIN_SECONDS) return send(id, `این مکالمه تا ${Math.ceil(STOP_MIN_SECONDS - elapsed)} ثانیه دیگر قابل قطع نیست.`, chatKeyboard(s));
      await updateAction(sClient, id, 'confirm_stop'); return send(id, 'مطمئنی مکالمه قطع بشه؟', confirmStopKeyboard());
    }
    if (data === 'stop_no') { await updateAction(sClient, id, null); return send(id, 'ادامه بده؛ مکالمه برقرار است.', chatKeyboard(s)); }
    if (data === 'stop_yes') {
      const partnerId = await disconnect(id); await updateAction(sClient, id, 'after_stop'); if (partnerId) await send(partnerId, 'مکالمه از طرف مقابل شما بسته شد.', mainKeyboard(s)); return send(id, 'مکالمه بسته شد. دوست داری چه کار کنی؟', afterStopKeyboard());
    }
    if (data === 'later' || data === 'block:later') { await updateAction(sClient, id, null); return send(id, 'باشه؛ هر زمان خواستی دوباره وصل شو.', mainKeyboard(s)); }
    if (data === 'block') { await updateAction(sClient, id, 'choose_block_reason'); return send(id, 'به چه دلیلی بلاک بشه؟', blockKeyboard()); }
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
async function mandatoryStatusText(client) {
  const r = await client.query('SELECT id,tracking_code,source_type,title,mode,status,quota,duration_seconds,starts_at FROM mandatory_sources ORDER BY id DESC');
  if (!r.rows.length) return 'هیچ جویین اجباری ثبت نشده است.';
  return `منابع جویین اجباری\n\n${r.rows.map(x => `${x.tracking_code} | ${x.title} | ${mandatoryTypeLabel(x.source_type)} | ${x.mode} | ${x.status}`).join('\n')}`;
}
async function handleMandatoryBack(client, id, state) {
  const parts = String(state || '').split(':'); const kind = parts[1];
  if (kind === 'type' || kind === 'delete') { await updateAction(client, id, null); return send(id, 'مدیریت جویین اجباری', mandatoryJoinKeyboard()); }
  if (kind === 'visibility') { await updateAction(client, id, 'mandatory:type'); return send(id, 'نوع جویین اجباری را انتخاب کن.', mandatoryTypeKeyboard()); }
  if (kind === 'target') { await updateAction(client, id, `mandatory:visibility:${parts[2]}`); return send(id, `نوع ${mandatoryTypeLabel(parts[2])} را انتخاب کن.`, mandatoryVisibilityKeyboard()); }
  if (kind === 'mode') { await updateAction(client, id, `mandatory:target:${parts[2]}:${parts[3]}`); return send(id, `لینک یا آیدی ${mandatoryTypeLabel(parts[2])} را بفرست.`); }
  if (kind === 'value') { await updateAction(client, id, `mandatory:mode:${parts[2]}:${parts[3]}:${parts[4]}`); return send(id, 'روش محاسبه را انتخاب کن.', mandatoryModeKeyboard(parts[2])); }
  if (kind === 'activate' && parts.length > 3) { await updateAction(client, id, `mandatory:value:${parts[2]}:${parts[3]}:${parts[4]}:${parts[5]}`); return send(id, 'مقدار یا مدت را بفرست.'); }
  if (kind === 'schedule') { await updateAction(client, id, `mandatory:activate:${parts.slice(2).join(':')}`); return send(id, 'روش فعال‌سازی را انتخاب کن.', mandatoryActivationKeyboard()); }
  if (kind === 'cancel' || kind === 'activate' || kind === 'reschedule') { await updateAction(client, id, null); return send(id, 'وضعیت جویین اجباری', mandatoryStatusKeyboard()); }
  if (kind === 'reschedule_at') { await updateAction(client, id, 'mandatory:reschedule'); return send(id, 'کد پیگیری منبع را بفرست.', mandatoryStatusKeyboard()); }
  return false;
}
async function handleText(id, text) {
  const client = await pool.connect();
  let released = false;
  try {
    const me = await ensureUser(client, id); const s = await settings(client);
    const value = text.trim();
    if (isAdmin(id) && value === 'بازگشت' && me.action_state?.startsWith('mandatory:')) {
      const handled = await handleMandatoryBack(client, id, me.action_state); if (handled !== false) return handled;
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
    if (isAdmin(id) && value === s.profile_button) return sendProfile(id, s);
    if (isAdmin(id) && value === 'پروفایل من') return sendProfile(id, s);
    if (isAdmin(id) && value === 'تبلیغات') return send(id, 'مدیریت تبلیغات', adsKeyboard());
    if (isAdmin(id) && value === 'کنترل ربات') return send(id, 'کنترل ربات', controlKeyboard());
    if (isAdmin(id) && value === 'کنترل کاربران') { await updateAction(client, id, 'admin:user_search'); return send(id, 'آیدی عددی کاربر را بفرست.'); }
    if (isAdmin(id) && value === 'وضعیت ربات') { const stats = await adminStats(client); return send(id, stats, adminMainKeyboard()); }
    if (isAdmin(id) && value === 'گزارش‌ها') { const r = await client.query("SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE status='open') AS open FROM reports"); return send(id, `گزارش‌ها\n\nکل: ${r.rows[0].total}\nباز: ${r.rows[0].open}`, adminMainKeyboard()); }
    if (isAdmin(id) && value === 'مدیران') return send(id, `مدیران فعلی\n\n${[...adminIds()].join('\n') || 'ثبت نشده'}`, adminMainKeyboard());
    if (isAdmin(id) && value === 'جویین اجباری') return send(id, 'مدیریت جویین اجباری', mandatoryJoinKeyboard());
    if (isAdmin(id) && value === 'افزودن') { await updateAction(client, id, 'mandatory:type'); return send(id, 'نوع جویین اجباری را انتخاب کن.', mandatoryTypeKeyboard()); }
    if (isAdmin(id) && value === 'حذف') { await updateAction(client, id, 'mandatory:delete'); return send(id, 'کد پیگیری یا آدرس منبع را بفرست.', mandatoryJoinKeyboard()); }
    if (isAdmin(id) && value === 'وضعیت') { return send(id, await mandatoryStatusText(client), mandatoryStatusKeyboard()); }
    if (isAdmin(id) && value === 'لیست زمان بندی') { const r = await client.query("SELECT tracking_code,title,starts_at FROM mandatory_sources WHERE status='scheduled' AND starts_at IS NOT NULL ORDER BY starts_at"); return send(id, r.rows.length ? `لیست زمان‌بندی:\n\n${r.rows.map(x => `${x.tracking_code} | ${x.title} | ${iranDate(x.starts_at)}`).join('\n')}` : 'مورد زمان‌بندی‌شده‌ای وجود ندارد.', mandatoryStatusKeyboard()); }
    if (isAdmin(id) && value === 'صف انتظار') { const r = await client.query("SELECT q.position,s.tracking_code,s.title FROM mandatory_source_queue q JOIN mandatory_sources s ON s.id=q.source_id ORDER BY q.position"); return send(id, r.rows.length ? `صف انتظار:\n\n${r.rows.map(x => `${x.position}) ${x.tracking_code} | ${x.title}`).join('\n')}` : 'صف انتظار خالی است.', mandatoryStatusKeyboard()); }
    if (isAdmin(id) && value === 'درحال انجام') { const r = await client.query("SELECT tracking_code,title,source_type,mode FROM mandatory_sources WHERE status='active' ORDER BY id"); return send(id, r.rows.length ? `درحال انجام:\n\n${r.rows.map(x => `${x.tracking_code} | ${x.title} | ${mandatoryTypeLabel(x.source_type)} | ${x.mode}`).join('\n')}` : 'منبع فعالی وجود ندارد.', mandatoryStatusKeyboard()); }
    if (isAdmin(id) && value === 'امور پیگیری') { const r = await client.query("SELECT tracking_code,title,status,updated_at FROM mandatory_sources WHERE status IN ('failed','completed','cancelled') ORDER BY updated_at DESC LIMIT 50"); return send(id, r.rows.length ? `امور پیگیری:\n\n${r.rows.map(x => `${x.tracking_code} | ${x.title} | ${x.status}`).join('\n')}` : 'موردی برای پیگیری وجود ندارد.', mandatoryStatusKeyboard()); }
    if (isAdmin(id) && ['کنسل کردن','الان ست کن','تغییر تایم'].includes(value)) { await updateAction(client, id, `mandatory:${value === 'کنسل کردن' ? 'cancel' : value === 'الان ست کن' ? 'activate' : 'reschedule'}`); return send(id, 'کد پیگیری منبع را بفرست.', mandatoryStatusKeyboard()); }
    if (isAdmin(id) && me.action_state === 'mandatory:cancel') { const r = await client.query("UPDATE mandatory_sources SET status='cancelled',updated_at=NOW() WHERE tracking_code=$1 AND status IN ('scheduled','active','paused') RETURNING tracking_code", [value]); await updateAction(client, id, null); return send(id, r.rowCount ? `منبع ${value} کنسل شد.` : 'کد پیگیری معتبر نیست.', mandatoryStatusKeyboard()); }
    if (isAdmin(id) && me.action_state === 'mandatory:activate') {
      try {
        const r = await client.query("UPDATE mandatory_sources SET status='active',starts_at=NULL,updated_at=NOW() WHERE (tracking_code=$1 OR target=$1 OR join_url=$1) AND status='scheduled' RETURNING id,tracking_code", [value]);
        if (r.rowCount) await client.query('DELETE FROM mandatory_source_queue WHERE source_id=$1', [r.rows[0].id]);
        await updateAction(client, id, null); return send(id, r.rowCount ? `منبع ${r.rows[0].tracking_code} همین حالا فعال شد.` : 'منبع زمان‌بندی‌شده‌ای با این کد یا آدرس پیدا نشد.', mandatoryStatusKeyboard());
      } catch (error) { console.error('mandatory_activate_error', error.message); return send(id, 'فعال‌سازی انجام نشد؛ کد پیگیری یا آدرس منبع را دوباره بفرست.', mandatoryStatusKeyboard()); }
    }
    if (isAdmin(id) && me.action_state === 'mandatory:reschedule') { if (!parseJalaliDateTime(value)) { await updateAction(client, id, `mandatory:reschedule_at:${encodeState(value)}`); return send(id, 'زمان جدید را با قالب 1405/6/10-17:10 بفرست.', mandatoryStatusKeyboard()); } return send(id, 'ابتدا کد پیگیری را بفرست.', mandatoryStatusKeyboard()); }
    if (isAdmin(id) && me.action_state?.startsWith('mandatory:reschedule_at:')) { const code = decodeState(me.action_state.split(':')[2]); const date = parseJalaliDateTime(value); if (!date) return send(id, 'قالب زمان نامعتبر است.', mandatoryStatusKeyboard()); const r = await client.query("UPDATE mandatory_sources SET starts_at=$2,status='scheduled',updated_at=NOW() WHERE tracking_code=$1 RETURNING tracking_code", [code,date]); await updateAction(client, id, null); return send(id, r.rowCount ? `زمان منبع ${code} تغییر کرد.` : 'کد پیگیری معتبر نیست.', mandatoryStatusKeyboard()); }
    if (isAdmin(id) && value === 'خاموش/روشن') { await client.query("UPDATE mandatory_sources SET status=CASE WHEN status='active' THEN 'paused' ELSE 'active' END, updated_at=NOW() WHERE status IN ('active','paused')"); return send(id, 'وضعیت منابع فعال تغییر کرد.', mandatoryJoinKeyboard()); }
    if (isAdmin(id) && value === 'بازگشت پنل') return send(id, 'پنل مدیریت', adminMainKeyboard());
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
      const [, , type, visibility, mode, encodedTarget, quotaRaw, durationRaw] = me.action_state.split(':'); const rawTarget = decodeState(encodedTarget); const target = normalizeTelegramTarget(rawTarget); const quota = Number(quotaRaw) || null; const duration = Number(durationRaw) || null;
      if (!['شروع از الان','ارسال به صف','زمان بندی کردن'].includes(value)) return send(id, 'یکی از روش‌های فعال‌سازی را انتخاب کن.', mandatoryActivationKeyboard());
      if (value === 'زمان بندی کردن') { await updateAction(client, id, `mandatory:schedule:${type}:${visibility}:${mode}:${encodedTarget}:${quotaRaw}:${durationRaw}`); return send(id, 'تاریخ و ساعت شمسی را با قالب 1405/6/10-17:10 بفرست.'); }
      if (!(await validateMandatoryTarget(type, target))) return send(id, 'ربات در این کانال یا گروه ادمین کامل نیست؛ ابتدا دسترسی ادمین کامل بده.');
      const tracking = sourceTrackingCode(); const title = target.replace(/^https?:\/\//, '').slice(0, 120); const status = value === 'ارسال به صف' ? 'scheduled' : 'active';
      const created = await client.query("INSERT INTO mandatory_sources(tracking_code,source_type,visibility,title,target,join_url,mode,quota,duration_seconds,status,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id", [tracking,type,visibility,title,target,rawTarget,mode,quota,duration,status,id]);
      await client.query('UPDATE mandatory_sources SET join_url=$2 WHERE id=$1', [created.rows[0].id, await createMandatoryInviteLink(type, rawTarget, tracking)]);
      if (value === 'ارسال به صف') { const pos = await client.query('SELECT COALESCE(MAX(position),0)+1 AS next FROM mandatory_source_queue'); await client.query('INSERT INTO mandatory_source_queue(source_id,position) VALUES ($1,$2)', [created.rows[0].id, pos.rows[0].next]); }
      await updateAction(client, id, null); return send(id, `منبع ثبت شد.\nکد پیگیری: ${tracking}\nوضعیت: ${value}`, mandatoryJoinKeyboard());
    }
    if (isAdmin(id) && me.action_state?.startsWith('mandatory:schedule:')) {
      const [, , type, visibility, mode, encodedTarget, quotaRaw, durationRaw] = me.action_state.split(':'); const startsAt = parseJalaliDateTime(value); if (!startsAt) return send(id, 'قالب زمان نامعتبر است؛ نمونه: 1405/6/10-17:10.');
      const rawTarget = decodeState(encodedTarget); const target = normalizeTelegramTarget(rawTarget); if (!(await validateMandatoryTarget(type, target))) return send(id, 'ربات در این کانال یا گروه ادمین کامل نیست؛ ابتدا دسترسی ادمین کامل بده.'); const tracking = sourceTrackingCode(); const title = rawTarget.replace(/^https?:\/\//, '').slice(0, 120); const quota = Number(quotaRaw) || null; const duration = Number(durationRaw) || null;
      const scheduled = await client.query("INSERT INTO mandatory_sources(tracking_code,source_type,visibility,title,target,join_url,mode,quota,duration_seconds,status,starts_at,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'scheduled',$10,$11) RETURNING id", [tracking,type,visibility,title,target,rawTarget,mode,quota,duration,startsAt,id]); await client.query('UPDATE mandatory_sources SET join_url=$2 WHERE id=$1', [scheduled.rows[0].id, await createMandatoryInviteLink(type, rawTarget, tracking)]); await updateAction(client, id, null);
      return send(id, `منبع زمان‌بندی شد.\nکد پیگیری: ${tracking}\nشروع: ${value}`, mandatoryJoinKeyboard());
    }
    if (isAdmin(id) && me.action_state === 'mandatory:delete') {
      const result = await client.query('DELETE FROM mandatory_sources WHERE tracking_code=$1 OR target=$1 RETURNING tracking_code', [value]); await updateAction(client, id, null);
      return send(id, result.rowCount ? `منبع ${result.rows[0].tracking_code} حذف شد.` : 'منبعی با این کد یا آدرس پیدا نشد.', mandatoryJoinKeyboard());
    }

    if (isAdmin(id) && value === 'پیام همگانی') { await updateAction(client, id, 'admin:broadcast'); return send(id, 'متن پیام همگانی را بفرست. نسخهٔ متنی فعال است؛ ارسال رسانه در مرحلهٔ بعد اضافه می‌شود.'); }
    if (isAdmin(id) && value === 'پیام خوش‌آمد') { await updateAction(client, id, 'admin:set:welcome_message'); return send(id, 'متن پیام خوش‌آمد جدید را بفرست.'); }
    if (isAdmin(id) && value === 'تبلیغ اتصال') { await updateAction(client, id, 'admin:set:connected_message'); return send(id, 'متن پیام هنگام اتصال را بفرست.'); }
    if (isAdmin(id) && value === 'تبلیغ میان مکالمه') return send(id, 'تبلیغ میان مکالمه در پنل فعال است؛ زمان‌بندی خودکار آن در مرحلهٔ بعد اضافه می‌شود.', adsKeyboard());
    if (isAdmin(id) && value === 'بخش ظاهری پابلیک') return send(id, 'ظاهر عمومی فعلاً از تنظیمات دکمه‌های اتصال، انصراف، قطع مکالمه و پروفایل استفاده می‌کند.', controlKeyboard());
    if (isAdmin(id) && value === 'بخش ظاهری پرایویسی') return send(id, 'ظاهر پنل مدیریت در این نسخه با منوی قابل توسعه فعال است.', controlKeyboard());
    if (isAdmin(id) && value === 'روشن/خاموش کردن ربات') { const enabled = !s.bot_enabled; await client.query("INSERT INTO bot_settings(key,value) VALUES ('bot_enabled',$1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()", [String(enabled)]); return send(id, enabled ? 'ربات روشن شد.' : 'ربات خاموش شد.', controlKeyboard()); }
    if (isAdmin(id) && (value === 'بازگشت پنل' || value === 'بازگشت')) return send(id, 'پنل مدیریت', adminMainKeyboard());
    if (isAdmin(id) && value === 'خروج از پنل') { await updateAction(client, id, null); return send(id, 'از پنل خارج شدی.', mainKeyboard(s)); }
    if (value === s.profile_button || value === 'پروفایل من') return sendProfile(id, s);
    if (value === 'ظاهر ایموجی پلاس') {
      if (!isPlus(me, id)) return send(id, 'این بخش فقط برای کاربران پلاس فعال است.', profileKeyboard(s));
      await updateAction(client, id, 'plus_emoji');
      return send(id, isOwner(id) ? 'سه ایموجی ارسال کن؛ نشان مالک فقط با سه ایموجی معتبر ذخیره می‌شود.' : isAdmin(id) ? 'دو ایموجی ارسال کن؛ نشان ادمین فقط با دو ایموجی معتبر ذخیره می‌شود.' : 'یک ایموجی دلخواه ارسال کن. فقط یک ایموجی مجاز است و متن یا شکل دیگری پذیرفته نمی‌شود.', emojiKeyboard(s));
    }
    if (value === 'ریست ایموجی') { await client.query("UPDATE users SET plus_emoji='✨', updated_at=NOW() WHERE telegram_id=$1", [id]); await updateAction(client, id, null); return send(id, 'ایموجی پلاس به ✨ برگردانده شد.', profileKeyboard(s)); }
    if (value === s.increase_coins_button) return sendIncreaseCoins(id, s);
    if (value === s.free_coins_button) return sendFreeCoins(id, s);
    if (value === s.plus_button) return sendPlus(id, s);
    if (value === s.back_button || value === 'بازگشت') return send(id, s.welcome_message || DEFAULTS.welcome_message, mainKeyboard(s));
    if (me.action_state === 'plus_emoji') {
      const requiredCount = isOwner(id) ? 3 : isAdmin(id) ? 2 : 1;
      if (!emojiSequence(value, requiredCount)) return send(id, `دقیقاً ${requiredCount} ایموجی ارسال کن.`, emojiKeyboard(s));
      await client.query('UPDATE users SET plus_emoji=$2, updated_at=NOW() WHERE telegram_id=$1', [id, value]);
      await updateAction(client, id, null);
      return send(id, `نشان پلاس شما روی ${value} تنظیم شد.`, profileKeyboard(s));
    }
    // A stale anonymous-link state must never swallow the normal connect button.
    if (value === s.connect_button) {
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
      if (me.action_state === 'anon_done' && value === s.connect_button) {
        await updateAction(client, id, null);
        client.release();
        released = true;
        return handleConnect(id);
      }
      if (me.action_state === 'anon_done' && value === ANONYMOUS_LINK_BUTTON) {
        client.release();
        released = true;
        return flow.handleLinkButton(id);
      }
      client.release();
      released = true;
      return flow.handleText(id, value, me.action_state);
    }
    if (value === ANONYMOUS_LINK_BUTTON) {
      client.release();
      released = true;
      return flowFor(s).handleLinkButton(id);
    }
    if (me.action_state === 'choose_gender' || me.action_state?.startsWith('choose_gender_for:')) {
      const pendingMatch = me.action_state.match(/^choose_gender_for:(male|female|any)$/)?.[1];
      const normalized = normalizeFa(value);
      const gender = [normalizeFa(GENDER_LABELS.male), 'پسر'].includes(normalized) ? 'male' : [normalizeFa(GENDER_LABELS.female), 'دختر'].includes(normalized) ? 'female' : null;
      if (!gender) return send(id, 'یکی از دو گزینهٔ جنسیت خودت را انتخاب کن.', genderKeyboard());
      await client.query('UPDATE users SET gender=$2, action_state=$3, updated_at=NOW() WHERE telegram_id=$1', [id, gender, pendingMatch ? null : 'choose_preference']);
      if (pendingMatch) return searchByPreference(id, pendingMatch, s);
      return send(id, 'دوست داری به چه کسی وصل شوی؟', preferenceKeyboard());
    }
    if (me.action_state === 'choose_preference') {
      const preference = preferenceFromText(value);
      if (!preference) return send(id, 'یکی از گزینه‌های جنسیت را انتخاب کن.', preferenceKeyboard());
      if (!['male', 'female'].includes(me.gender)) {
        await updateAction(client, id, `choose_gender_for:${preference}`);
        return send(id, OWN_GENDER_PROMPT, genderKeyboard());
      }
      return searchByPreference(id, preference, s);
    }
    const preferenceText = preferenceFromText(value);
    if (preferenceText && me.status === 'waiting') return send(id, 'وضعیت فعلی: هنوز در صف انتظار هستی؛ برای لغو دکمه انصراف را بزن.', waitingKeyboard(s));
    if (preferenceText && me.status === 'idle') {
      if (!['male', 'female'].includes(me.gender)) {
        await updateAction(client, id, `choose_gender_for:${preferenceText}`);
        return send(id, OWN_GENDER_PROMPT, genderKeyboard());
      }
      return searchByPreference(id, preferenceText, s);
    }
    if (value === s.cancel_button && me.status === 'waiting') { await leaveWaiting(id); return send(id, 'از صف انتظار خارج شدی.', mainKeyboard(s)); }
    if (value === s.disconnect_button && me.status === 'chatting') {
      const started = me.conversation_started_at ? new Date(me.conversation_started_at).getTime() : Date.now(); const elapsed = (Date.now() - started) / 1000;
      if (elapsed < STOP_MIN_SECONDS) return send(id, `این مکالمه تا ${Math.ceil(STOP_MIN_SECONDS - elapsed)} ثانیه دیگر قابل قطع نیست.`, chatKeyboard(s));
      await updateAction(client, id, 'confirm_stop'); return send(id, 'مطمئنی مکالمه قطع بشه؟', confirmStopKeyboard());
    }
    if (me.action_state === 'confirm_stop') {
      if (value === 'نه ادامه میدم') { await updateAction(client, id, null); return send(id, 'ادامه بده؛ مکالمه برقرار است.', chatKeyboard(s)); }
      if (value === 'اره مطمئنم') {
        const partnerId = await disconnect(id); await updateAction(client, id, 'after_stop'); if (partnerId) await send(partnerId, 'مکالمه از طرف مقابل شما بسته شد.', mainKeyboard(s)); return send(id, 'مکالمه بسته شد. دوست داری چه کار کنی؟', afterStopKeyboard());
      }
      return send(id, 'یکی از گزینه‌ها را انتخاب کن.', confirmStopKeyboard());
    }
    if (me.action_state === 'after_stop') {
      if (value === 'بعدا وصلش کن') { await updateAction(client, id, null); return send(id, 'باشه؛ هر زمان خواستی دوباره وصل شو.', mainKeyboard(s)); }
      if (value === 'بلاکش کن') { await updateAction(client, id, 'choose_block_reason'); return send(id, 'به چه دلیلی بلاک بشه؟', blockKeyboard()); }
      return send(id, 'یکی از گزینه‌ها را انتخاب کن.', afterStopKeyboard());
    }
    if (me.action_state === 'choose_block_reason') {
      const entries = Object.entries(BLOCK_REASONS); const found = entries.find(([, label]) => label === value);
      if (value === 'بذار بعدا هم وصل بشم') { await updateAction(client, id, null); return send(id, 'باشه؛ هر زمان خواستی دوباره وصل شو.', mainKeyboard(s)); }
      if (!found) return send(id, 'یکی از دلایل را انتخاب کن.', blockKeyboard());
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
  if (callback?.from && callback.message?.chat?.type === 'private') { await answerCallback(callback.id); await handleCallback(Number(callback.from.id), String(callback.data || '')); return; }
  const message = update.message;
  if (!message?.from || message.from.is_bot || message.chat?.type !== 'private' || message.chat.id !== message.from.id) return;
  const id = Number(message.from.id); const text = String(message.text || '').trim(); if (!text) return;
    if (text.startsWith('/')) {
      const [rawCommand, payload] = text.split(/\s+/, 2);
      const command = rawCommand.toLowerCase();
      if (['/plus', '/admin', '/owner'].includes(command)) return handlePremiumRoleCommand(id, command);
      if (command === '/start') return handleStart(id, payload || null);
      if (command === '/help') return handleStart(id);
    if (command === '/manpin' && isAdmin(id)) { const c = await pool.connect(); try { const s = await settings(c); return send(id, `پنل مدیریت\nوضعیت ربات: ${s.bot_enabled ? 'روشن' : 'خاموش'}`, adminMainKeyboard()); } finally { c.release(); } }
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

export { DEFAULTS, BLOCK_REASONS, STOP_MIN_SECONDS, normalizeFa, preferenceFromText };
