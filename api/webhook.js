import { Pool } from 'pg';
import { createAnonymousFlow } from '../src/anonymous-flow.js';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.DB_POOL_MAX || 5),
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 5_000,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

const DEFAULTS = {
  connect_button: 'وصل کن به ناشناس',
  cancel_button: 'انصراف',
  disconnect_button: 'قطع مکالمه',
  profile_button: 'پروفایل من',
  back_button: 'بازگشت',
  welcome_message: 'به چت ناشناس خوش آمدی.',
  connected_message: 'وصل شدی؛ سلام کن و گفت‌وگو را شروع کن.',
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
function isAdmin(id) { return adminIds().has(String(id)); }
function button(text, data) { return { text, callback_data: data }; }
function replyKeyboard(rows, oneTime = false) { return { keyboard: rows, resize_keyboard: true, one_time_keyboard: oneTime, selective: true }; }
const ANONYMOUS_LINK_BUTTON = 'لینک ناشناس من';
function mainKeyboard(settings) { return replyKeyboard([[settings.connect_button, ANONYMOUS_LINK_BUTTON], [settings.profile_button]]); }
function profileKeyboard(settings) { return replyKeyboard([[settings.back_button]], true); }
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
  return createAnonymousFlow({ pool, send, sendLink, connectButton: settings.connect_button, disconnectButton: settings.disconnect_button });
}
async function answerCallback(id) { try { await telegram('answerCallbackQuery', { callback_query_id: id }); } catch (e) { console.error('callback_answer_error', e.message); } }

async function settings(client) {
  const result = await client.query('SELECT key, value FROM bot_settings');
  const out = { ...DEFAULTS, bot_enabled: 'true' };
  for (const row of result.rows) out[row.key] = row.value;
  return { ...out, bot_enabled: out.bot_enabled !== 'false' };
}
async function ensureUser(client, id) {
  await client.query('INSERT INTO users (telegram_id) VALUES ($1) ON CONFLICT (telegram_id) DO UPDATE SET updated_at=NOW()', [id]);
  const result = await client.query('SELECT * FROM users WHERE telegram_id=$1', [id]);
  return result.rows[0];
}
async function user(client, id) { const r = await client.query('SELECT * FROM users WHERE telegram_id=$1', [id]); return r.rows[0] || null; }
function iranDate(value) {
  return new Intl.DateTimeFormat('fa-IR', { timeZone: 'Asia/Tehran', dateStyle: 'short', timeStyle: 'short' }).format(new Date(value));
}
async function sendProfile(id, settings) {
  const client = await pool.connect();
  try {
    const me = await ensureUser(client, id);
    const gender = me.gender === 'male' ? 'پسر' : me.gender === 'female' ? 'دختر' : 'ثبت نشده';
    const text = `پروفایل شما\n\n🪙 سکه: ${Number(me.coins || 0)}\n📅 تاریخ عضویت: ${iranDate(me.created_at)}\n🆔 آیدی عددی: ${me.telegram_id}\n⚧ جنسیت: ${gender}`;
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
        AND (candidate.match_preference='any' OR candidate.match_preference=$3)
        AND NOT EXISTS (
          SELECT 1 FROM anonymous_blocks AS ab
          WHERE ab.expires_at > NOW()
            AND ((ab.user_low = LEAST($1, candidate.telegram_id) AND ab.user_high = GREATEST($1, candidate.telegram_id)))
        )
      ORDER BY candidate.updated_at ASC
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
    await send(id, s.connected_message || DEFAULTS.connected_message, chatKeyboard(s));
    await send(result.partnerId, s.connected_message || DEFAULTS.connected_message, chatKeyboard(s));
    return;
  }
  return send(id, 'در صف انتظار قرار گرفتی؛ هنوز کسی با این انتخاب پیدا نشده است. به‌محض اتصال خبرت می‌دهم.', waitingKeyboard(s));
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
       VALUES (LEAST($1,$2), GREATEST($1,$2), NOW() + INTERVAL '7 days')
       ON CONFLICT (user_low, user_high) DO UPDATE SET created_at=NOW(), expires_at=NOW() + INTERVAL '7 days'`,
      [id, targetId]
    );
    await client.query('INSERT INTO reports (reporter_id, target_id, reason) VALUES ($1,$2,$3)', [id, targetId, reason]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

async function handleStart(id, payload = null) {
  const client = await pool.connect(); let released = false; try {
    const me = await ensureUser(client, id); const s = await settings(client);
    if (payload !== null) {
      if (me.status !== 'idle' || (me.action_state && me.action_state !== 'anon_done')) {
        return send(id, 'برای باز کردن لینک، ابتدا عملیات یا گفت‌وگوی فعلی را تمام کن.', mainKeyboard(s));
      }
      client.release();
      released = true;
      const started = await flowFor(s).handleStartPayload(id, payload);
      if (!started) return send(id, 'این لینک ناشناس معتبر نیست یا دیگر در دسترس نیست.', mainKeyboard(s));
      return;
    }
    if (me.status === 'waiting') return send(id, 'وضعیت فعلی: در صف انتظار هستی. به‌محض پیدا شدن فرد سازگار خبر می‌دهم.', waitingKeyboard(s));
    if (me.status === 'chatting') return send(id, 'وضعیت فعلی: به یک ناشناس وصل هستی و مکالمه برقرار است.', chatKeyboard(s));
    return send(id, s.welcome_message || DEFAULTS.welcome_message, mainKeyboard(s));
  } finally { if (!released) client.release(); }
}

async function handleConnect(id) {
  const client = await pool.connect(); try {
    const me = await ensureUser(client, id); const s = await settings(client);
    if (!s.bot_enabled && !isAdmin(id)) return send(id, 'ربات موقتاً خاموش است.');
    if (me.status === 'chatting') return send(id, 'وضعیت فعلی: به یک ناشناس وصل هستی و مکالمه برقرار است.', chatKeyboard(s));
    await updateAction(client, id, 'choose_preference'); return send(id, 'دوست داری به چه کسی وصل شوی؟', preferenceKeyboard());
  } finally { client.release(); }
}

async function handleCallback(id, data) {
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
    if (data === 'admin:toggle' && isAdmin(id)) { const enabled = !s.bot_enabled; await sClient.query("INSERT INTO bot_settings(key,value) VALUES ('bot_enabled',$1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value", [String(enabled)]); return send(id, enabled ? 'ربات روشن شد.' : 'ربات خاموش شد.', adminKeyboard(enabled)); }
    if (data === 'admin:rename' && isAdmin(id)) return send(id, 'کدام دکمه را تغییر می‌دهی؟', renameKeyboard());
    if (data.startsWith('admin:rename:') && isAdmin(id)) { const key = data.slice('admin:rename:'.length); if (!DEFAULTS[key]) return send(id, 'گزینه نامعتبر است.'); await updateAction(sClient, id, `rename:${key}`); return send(id, 'نام جدید را در یک پیام بفرست.'); }
    return send(id, 'این گزینه دیگر معتبر نیست.', mainKeyboard(s));
  } finally { sClient.release(); }
}

async function handleText(id, text) {
  const client = await pool.connect();
  let released = false;
  try {
    const me = await ensureUser(client, id); const s = await settings(client);
    const value = text.trim();
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
      return send(id, `کاربر ${u.telegram_id}\nوضعیت: ${u.status}\nجنسیت: ${u.gender || 'ثبت نشده'}\nسکه: ${u.coins || 0}\nعضویت: ${iranDate(u.created_at)}`, adminMainKeyboard());
    }
    if (isAdmin(id) && value === s.profile_button) return sendProfile(id, s);
    if (isAdmin(id) && value === 'پروفایل من') return sendProfile(id, s);
    if (isAdmin(id) && value === 'تبلیغات') return send(id, 'مدیریت تبلیغات', adsKeyboard());
    if (isAdmin(id) && value === 'کنترل ربات') return send(id, 'کنترل ربات', controlKeyboard());
    if (isAdmin(id) && value === 'کنترل کاربران') { await updateAction(client, id, 'admin:user_search'); return send(id, 'آیدی عددی کاربر را بفرست.'); }
    if (isAdmin(id) && value === 'وضعیت ربات') { const stats = await adminStats(client); return send(id, stats, adminMainKeyboard()); }
    if (isAdmin(id) && value === 'گزارش‌ها') { const r = await client.query("SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE status='open') AS open FROM reports"); return send(id, `گزارش‌ها\n\nکل: ${r.rows[0].total}\nباز: ${r.rows[0].open}`, adminMainKeyboard()); }
    if (isAdmin(id) && value === 'مدیران') return send(id, `مدیران فعلی\n\n${[...adminIds()].join('\n') || 'ثبت نشده'}`, adminMainKeyboard());
    if (isAdmin(id) && value === 'جویین اجباری') return send(id, 'این بخش آمادهٔ اتصال کانال است و در نسخهٔ بعدی فعال می‌شود.', adsKeyboard());
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
    if (value === s.back_button || value === 'بازگشت') return send(id, s.welcome_message || DEFAULTS.welcome_message, mainKeyboard(s));
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
    if (value === s.connect_button) {
      client.release();
      released = true;
      return handleConnect(id);
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
      'SELECT 1 FROM anonymous_blocks WHERE user_low=LEAST($1,$2) AND user_high=GREATEST($1,$2) AND expires_at > NOW()',
      [target, id]
    );
    if (blocked.rowCount) return send(id, 'این گفتگو دیگر در دسترس نیست.', mainKeyboard(s));
    await send(target, `پیام ناشناس:\n${text}`); await client.query('UPDATE users SET last_action_at=NOW(), updated_at=NOW() WHERE telegram_id=$1', [id]);
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
  try { await processUpdate(req.body || {}); return res.status(200).json({ ok: true }); }
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
