import { Pool } from 'pg';

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
};
const GENDER_LABELS = { male: 'پسرم', female: 'دخترم' };
const PREF_LABELS = { female: 'دختر', male: 'پسر', any: 'مهم نیست' };
const BLOCK_REASONS = {
  rude: 'باهاش حال نکردم',
  abusive: 'بی ادب بود',
  wrong_gender: 'جنسیتش اشتباه بود',
  advertising: 'تبلیغ فرستاد',
};
const STOP_MIN_SECONDS = 15;

function adminIds() {
  return new Set((process.env.ADMIN_TELEGRAM_IDS || '').split(',').map(x => x.trim()).filter(Boolean));
}
function isAdmin(id) { return adminIds().has(String(id)); }
function button(text, data) { return { text, callback_data: data }; }
function keyboard(rows) { return { inline_keyboard: rows }; }
function mainKeyboard(settings) { return keyboard([[button(settings.connect_button, 'connect')]]); }
function genderKeyboard() { return keyboard([[button(GENDER_LABELS.male, 'gender:male'), button(GENDER_LABELS.female, 'gender:female')]]); }
function preferenceKeyboard() { return keyboard([[button(PREF_LABELS.female, 'pref:female')], [button(PREF_LABELS.male, 'pref:male')], [button(PREF_LABELS.any, 'pref:any')]]); }
function waitingKeyboard(settings) { return keyboard([[button(settings.cancel_button, 'cancel_wait')]]); }
function chatKeyboard(settings) { return keyboard([[button(settings.disconnect_button, 'stop')]]); }
function confirmStopKeyboard() { return keyboard([[button('اره مطمئنم', 'stop_yes'), button('نه ادامه میدم', 'stop_no')]]); }
function afterStopKeyboard() { return keyboard([[button('بلاکش کن', 'block')], [button('بعدا وصلش کن', 'later')]]); }
function blockKeyboard() { return keyboard([[button(BLOCK_REASONS.rude, 'block:rude')], [button(BLOCK_REASONS.abusive, 'block:abusive')], [button(BLOCK_REASONS.wrong_gender, 'block:wrong_gender')], [button(BLOCK_REASONS.advertising, 'block:advertising')], [button('بذار بعدا هم وصل بشم', 'block:later')]]); }
function adminKeyboard(enabled) { return keyboard([[button('تغییر نام دکمه‌ها', 'admin:rename')], [button(enabled ? 'خاموش کردن ربات' : 'روشن کردن ربات', 'admin:toggle')]]); }
function renameKeyboard() { return keyboard([[button('دکمه اتصال', 'admin:rename:connect_button')], [button('دکمه انصراف', 'admin:rename:cancel_button')], [button('دکمه قطع مکالمه', 'admin:rename:disconnect_button')]]); }

async function telegram(method, body) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is missing');
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(`Telegram ${method}: ${result.description || response.status}`);
  return result.result;
}
async function send(chatId, text, replyMarkup) {
  return telegram('sendMessage', { chat_id: chatId, text, protect_content: true, ...(replyMarkup ? { reply_markup: replyMarkup } : {}) });
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
async function updateAction(client, id, action) { await client.query('UPDATE users SET action_state=$2, updated_at=NOW() WHERE telegram_id=$1', [id, action]); }

async function findPair(id, preference) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const me = await ensureUser(client, id);
    if (me.status === 'chatting' && me.partner_id) { await client.query('COMMIT'); return { kind: 'already_chatting', partnerId: Number(me.partner_id) }; }
    await client.query('SELECT telegram_id FROM users WHERE telegram_id=$1 FOR UPDATE', [id]);
    const candidate = await client.query(`
      SELECT telegram_id, gender FROM users
      WHERE status='waiting' AND telegram_id<>$1
        AND ($2='any' OR gender=$2)
        AND (match_preference='any' OR match_preference=$3)
        AND NOT ($1 = ANY(blocked_ids))
        AND NOT (telegram_id = ANY((SELECT blocked_ids FROM users WHERE telegram_id=$1)))
      ORDER BY updated_at ASC
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
    await client.query('UPDATE users SET blocked_ids=ARRAY(SELECT DISTINCT unnest(blocked_ids || $2::bigint[])), updated_at=NOW() WHERE telegram_id=$1', [id, [targetId]]);
    await client.query('INSERT INTO reports (reporter_id, target_id, reason) VALUES ($1,$2,$3)', [id, targetId, reason]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

async function handleStart(id) {
  const client = await pool.connect(); try {
    const me = await ensureUser(client, id); const s = await settings(client);
    if (me.status === 'waiting') return send(id, 'در صف انتظار هستی؛ به‌محض پیدا شدن نفر بعدی خبر می‌دهم.', waitingKeyboard(s));
    if (me.status === 'chatting') return send(id, 'هنوز در یک مکالمه هستی.', chatKeyboard(s));
    return send(id, 'به چت ناشناس خوش آمدی.', mainKeyboard(s));
  } finally { client.release(); }
}

async function handleConnect(id) {
  const client = await pool.connect(); try {
    const me = await ensureUser(client, id); const s = await settings(client);
    if (!s.bot_enabled && !isAdmin(id)) return send(id, 'ربات موقتاً خاموش است.');
    if (me.status === 'chatting') return send(id, 'هنوز در یک مکالمه هستی.', chatKeyboard(s));
    if (!me.gender) { await updateAction(client, id, 'choose_gender'); return send(id, 'جنسیتت را انتخاب کن؛ فقط یک‌بار از تو پرسیده می‌شود.', genderKeyboard()); }
    await updateAction(client, id, 'choose_preference'); return send(id, 'دوست داری به چه کسی وصل شوی؟', preferenceKeyboard());
  } finally { client.release(); }
}

async function handleCallback(id, data) {
  const sClient = await pool.connect();
  try {
    const me = await ensureUser(sClient, id); const s = await settings(sClient);
    if (data === 'connect') return handleConnect(id);
    if (data === 'gender:male' || data === 'gender:female') {
      await sClient.query('UPDATE users SET gender=$2, action_state=\'choose_preference\', updated_at=NOW() WHERE telegram_id=$1', [id, data.split(':')[1]]);
      return send(id, 'دوست داری به چه کسی وصل شوی؟', preferenceKeyboard());
    }
    if (data.startsWith('pref:')) {
      const preference = data.split(':')[1]; const result = await findPair(id, preference);
      if (result.kind === 'already_chatting') return send(id, 'هنوز در یک مکالمه هستی.', chatKeyboard(s));
      if (result.kind === 'paired') { await send(id, 'وصل شدی؛ سلام کن و گفت‌وگو را شروع کن.', chatKeyboard(s)); await send(result.partnerId, 'وصل شدی؛ سلام کن و گفت‌وگو را شروع کن.', chatKeyboard(s)); return; }
      return send(id, 'در حال پیدا کردن یک ناشناس هستم؛ کمی صبر کن.', waitingKeyboard(s));
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
  try {
    const me = await ensureUser(client, id); const s = await settings(client);
    if (isAdmin(id) && me.action_state?.startsWith('rename:')) {
      const key = me.action_state.slice('rename:'.length); const value = text.trim().slice(0, 64);
      if (!value) return send(id, 'نام دکمه نمی‌تواند خالی باشد.');
      await client.query("INSERT INTO bot_settings(key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value", [key, value]); await updateAction(client, id, null); return send(id, 'نام دکمه ذخیره شد.', adminKeyboard(s.bot_enabled));
    }
    if (me.status !== 'chatting' || !me.partner_id) return send(id, 'برای شروع، دکمه اتصال را بزن.', mainKeyboard(s));
    const target = Number(me.partner_id); const blocked = await client.query('SELECT $2 = ANY(blocked_ids) AS blocked FROM users WHERE telegram_id=$1', [target, id]);
    if (blocked.rows[0]?.blocked) return send(id, 'این گفتگو دیگر در دسترس نیست.', mainKeyboard(s));
    await send(target, `پیام ناشناس:\n${text}`); await client.query('UPDATE users SET last_action_at=NOW(), updated_at=NOW() WHERE telegram_id=$1', [id]);
  } finally { client.release(); }
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
    const command = text.split(/\s+/)[0].toLowerCase();
    if (command === '/start' || command === '/help') return handleStart(id);
    if (command === '/manpin' && isAdmin(id)) { const c = await pool.connect(); try { const s = await settings(c); return send(id, `پنل مدیریت\nوضعیت ربات: ${s.bot_enabled ? 'روشن' : 'خاموش'}`, adminKeyboard(s.bot_enabled)); } finally { c.release(); } }
    return send(id, 'از دکمه‌های ربات استفاده کن.', mainKeyboard(await settings(pool)));
  }
  return handleText(id, text);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET; const supplied = req.headers['x-telegram-bot-api-secret-token'];
  if (!expected || supplied !== expected) return res.status(401).json({ ok: false, error: 'unauthorized' });
  try { await processUpdate(req.body || {}); return res.status(200).json({ ok: true }); }
  catch (error) { console.error('webhook_error', error?.message || error); return res.status(200).json({ ok: false }); }
}

export { DEFAULTS, BLOCK_REASONS, STOP_MIN_SECONDS };
