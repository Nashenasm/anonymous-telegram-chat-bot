import { normalizeAppearance, screenMessagePayload, screenKeyboard } from './appearance.js';
export const SPECIFIC_NOT_FOUND = 'این شخص در ربات ما نیست';
export const SPECIFIC_FOUND_CONFIRM = 'کاربر مورد نظر پیدا شد، درخواست چت به کاربر مورد نظر ارسال بشه؟';
export const SPECIFIC_SENDER_WAITING = 'اگر کاربر مورد نظر درخواست شما را قبول کند چت شروع میشه، لطفا در همین صفحه بمانید، اگر روی بازگشت کلیک کنید درخواست شما منقضی میشه';
export const SPECIFIC_RECEIVER_PROMPT = 'شما یک درخواست چت ناشناس دارید، قبول میکنید یا رد میکنید؟';
export const SPECIFIC_RECEIVER_EXPIRED = 'این درخواست از طرف ارسال کننده منقضی شده';
export const SPECIFIC_RECEIVER_DECLINED = 'درخواست چت رد شد';
export const SPECIFIC_SENDER_DECLINED = 'شخص مورد نظر شما درخواست چت را رد کرد';
export const SPECIFIC_TARGET_PROMPT = '🔎 اتصال به مخاطب خاص\n\nآیدی عددی تلگرام او را بفرست یا یک پیام مستقیم از همان کاربر فوروارد کن.\n\nنگران نباش؛ تا زمانی که پیام را تایید نکنی چیزی برای او ارسال نمی‌شود.';
export const SPECIFIC_TARGET_INVALID = 'آیدی عددی، @username معتبر یا پیام فورواردشده همان کاربر را بفرست.';
export function specificTargetMessage(s) { return scrMsg(s, 'specific_target', SPECIFIC_TARGET_PROMPT); }
export function specificTargetKeyboard(s) { const rows = scrRows(s, 'specific_target', [['بازگشت']]); return toKeyboard(rows); }
export function specificTargetFeedback(s, key, fb) { return scrFb(s, 'specific_target', key, fb); }
export function specificConfirmMessage(s) { return scrMsg(s, 'specific_confirm', SPECIFIC_FOUND_CONFIRM); }
export function specificConfirmKeyboardFromSettings(s) { const rows = scrRows(s, 'specific_confirm', [['بله'], ['خیر']]); return toKeyboard(rows); }
function pubOf(s) {
  try {
    if (s && s.appearance_public_enabled === false) return normalizeAppearance('public', null);
    return normalizeAppearance('public', s ? s.appearance_public : null);
  } catch { try { return normalizeAppearance('public', null); } catch { return null; } }
}
function scrMsg(s, id, fb) {
  try {
    const pub = pubOf(s);
    if (!pub) return fb;
    const m = screenMessagePayload(pub, id, fb);
    if (typeof m === 'string') return m;
    if (m && typeof m.text === 'string' && m.text) return m;
    return fb;
  } catch { return fb; }
}
function scrFb(s, screenId, key, fb) {
  try {
    const pub = pubOf(s);
    const v = pub && pub.screens && pub.screens[screenId] && pub.screens[screenId].feedback && pub.screens[screenId].feedback[key];
    return (typeof v === 'string' && v) ? v : fb;
  } catch { return fb; }
}
function scrRows(s, id, fbRows) {
  try {
    const pub = pubOf(s);
    if (!pub) return fbRows;
    const rows = screenKeyboard(pub, id, fbRows);
    if (Array.isArray(rows) && rows.length) return rows;
    return fbRows;
  } catch { return fbRows; }
}
function toKeyboard(rows) {
  return { keyboard: rows.map(r => r.map(t => typeof t === 'string' ? { text: t } : { ...(t || {}), text: t?.text || '' })), resize_keyboard: true, one_time_keyboard: true };
}
function btnId(s, screenId, value, fbMap) {
  try {
    const pub = pubOf(s);
    const scr = pub && pub.screens && pub.screens[screenId];
    const flat = [];
    for (const row of (scr && scr.buttons) || []) {
      const items = Array.isArray(row) ? row : [row];
      for (const it of items) if (it) flat.push(it);
    }
    for (const it of flat) if (it && (it.label === value || it.id === value)) return it.id;
  } catch {}
  return (fbMap && fbMap[value]) || null;
}
export function specificConfirmKeyboard() {
  return { keyboard: [[{ text: 'بله' }], [{ text: 'خیر' }]], resize_keyboard: true, one_time_keyboard: true };
}
export function specificWaitingKeyboard() {
  return { keyboard: [[{ text: 'بازگشت' }]], resize_keyboard: true };
}
export function specificRequestInlineKeyboard(requestId, s = null) {
  let accept = { text: 'بله' }, decline = { text: 'رد کردن' };
  try {
    const pub = pubOf(s);
    const items = (pub?.screens?.specific_request?.buttons || []).flat().filter(Boolean);
    const configured = id => items.find(item => item.id === id);
    const toInline = (item, fallback, callback_data) => ({
      text: item?.label || fallback,
      ...(item?.icon_custom_emoji_id ? { icon_custom_emoji_id: item.icon_custom_emoji_id } : {}),
      ...(item?.style ? { style: item.style } : {}),
      callback_data,
    });
    accept = toInline(configured('accept'), 'بله', `specific:accept:${requestId}`);
    decline = toInline(configured('decline'), 'رد کردن', `specific:decline:${requestId}`);
  } catch {}
  return { reply_markup: { inline_keyboard: [[accept], [decline]] } };
}
export async function ensureSpecificChatSchema(client) {
  await client.query(`CREATE TABLE IF NOT EXISTS specific_chat_requests (id BIGSERIAL PRIMARY KEY, sender_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE, recipient_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE, status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined','expired','cancelled')), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), decided_at TIMESTAMPTZ, expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '5 minutes', CHECK (sender_id <> recipient_id))`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_specific_chat_requests_sender ON specific_chat_requests(sender_id, status)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_specific_chat_requests_recipient ON specific_chat_requests(recipient_id, status)`);
}
export async function createSpecificRequest(client, senderId, recipientId) {
  await ensureSpecificChatSchema(client);
  await client.query(`UPDATE specific_chat_requests SET status='expired', decided_at=NOW() WHERE sender_id=$1 AND status='pending'`, [senderId]);
  const row = (await client.query(`INSERT INTO specific_chat_requests(sender_id,recipient_id,status) VALUES ($1,$2,'pending') RETURNING id`, [senderId, recipientId])).rows[0];
  return Number(row.id);
}
export async function getSpecificRequest(client, id) {
  return (await client.query(`SELECT * FROM specific_chat_requests WHERE id=$1 LIMIT 1`, [id])).rows[0] || null;
}
export async function setSpecificStatus(client, id, status) {
  await client.query(`UPDATE specific_chat_requests SET status=$2, decided_at=NOW() WHERE id=$1`, [id, status]);
}
export function isSpecificExpired(row) {
  if (!row) return true;
  if (row.status !== 'pending') return true;
  try { return new Date(row.expires_at).getTime() <= Date.now(); } catch { return false; }
}
export async function handleSpecificTextRoute(ctx) {
  const { client, id, value, s, me, send, mainKeyboard, chatKeyboard, updateAction, isAdmin } = ctx;
  const state = me.action_state || '';
  const confirmKb = (() => { const rows = scrRows(s, 'specific_confirm', [[ 'بله' ], [ 'خیر' ]]); return toKeyboard(rows); })();
  const waitingKb = (() => { const rows = scrRows(s, 'specific_waiting', [[ 'بازگشت' ]]); return { keyboard: rows.map(r => r.map(t => ({ text: typeof t === 'string' ? t : (t && t.text) || 'بازگشت' }))), resize_keyboard: true }; })();
  if (state.startsWith('contact:request_confirm:')) {
    const targetId = Number(state.split(':')[2]);
    const bid = btnId(s, 'specific_confirm', value, { 'بله': 'yes', 'خیر': 'no', 'بازگشت': 'back' });
    if (bid === 'no' || bid === 'back' || value === 'خیر' || value === 'بازگشت') {
      await updateAction(client, id, null);
      return send(id, scrFb(s, 'specific_waiting', 'to_main', 'به منوی اصلی برگشتی.'), mainKeyboard(s));
    }
    if (bid !== 'yes' && value !== 'بله') return send(id, scrMsg(s, 'specific_confirm', SPECIFIC_FOUND_CONFIRM), confirmKb);
    const target = (await client.query('SELECT telegram_id, status FROM users WHERE telegram_id=$1', [targetId])).rows[0];
    if (!target) { await updateAction(client, id, null); return send(id, scrFb(s, 'specific_target', 'not_found', SPECIFIC_NOT_FOUND), mainKeyboard(s)); }
    if (Number(targetId) === Number(id)) { await updateAction(client, id, null); return send(id, scrFb(s, 'specific_target', 'self', 'نمی‌توانی خودت را به‌عنوان مخاطب انتخاب کنی.'), mainKeyboard(s)); }
    const freshMe = (await client.query('SELECT status FROM users WHERE telegram_id=$1', [id])).rows[0];
    if (freshMe && freshMe.status === 'chatting') { await updateAction(client, id, null); return send(id, scrFb(s, 'specific_target', 'busy', 'هنوز در یک مکالمه هستی.'), chatKeyboard(s, isAdmin(id))); }
    const blocked = await client.query('SELECT 1 FROM anonymous_blocks WHERE user_low=LEAST($1::bigint,$2::bigint) AND user_high=GREATEST($1::bigint,$2::bigint) AND expires_at > NOW()', [id, targetId]);
    if (blocked.rowCount) { await updateAction(client, id, null); return send(id, scrFb(s, 'specific_target', 'blocked', 'این گفتگو دیگر در دسترس نیست.'), mainKeyboard(s)); }
    const reqId = await createSpecificRequest(client, id, targetId);
    await updateAction(client, id, `contact:waiting:${reqId}`);
    try { await send(targetId, scrMsg(s, 'specific_request', SPECIFIC_RECEIVER_PROMPT), specificRequestInlineKeyboard(reqId, s)); }
    catch (e) { await setSpecificStatus(client, reqId, 'expired'); await updateAction(client, id, null); return send(id, scrFb(s, 'specific_confirm', 'send_fail', 'ارسال درخواست ممکن نشد؛ مخاطب احتمالا ربات را بلاک کرده است.'), mainKeyboard(s)); }
    return send(id, scrMsg(s, 'specific_waiting', SPECIFIC_SENDER_WAITING), waitingKb);
  }
  if (state.startsWith('contact:waiting:')) {
    const reqId = Number(state.split(':')[2]);
    const bid = btnId(s, 'specific_waiting', value, { 'بازگشت': 'back' });
    if (bid === 'back' || value === 'بازگشت') {
      const req = await getSpecificRequest(client, reqId);
      if (req && req.status === 'pending') {
        await setSpecificStatus(client, reqId, 'cancelled');
        try { await send(Number(req.recipient_id), scrFb(s, 'specific_request', 'expired_sender', SPECIFIC_RECEIVER_EXPIRED)); } catch {}
      }
      await updateAction(client, id, null);
      return send(id, scrFb(s, 'specific_waiting', 'to_main', 'به منوی اصلی برگشتی.'), mainKeyboard(s));
    }
    const req = await getSpecificRequest(client, reqId);
    if (!req || isSpecificExpired(req)) {
      await updateAction(client, id, null);
      return send(id, scrFb(s, 'specific_waiting', 'expired', 'این درخواست منقضی شده است.'), mainKeyboard(s));
    }
    return send(id, scrMsg(s, 'specific_waiting', SPECIFIC_SENDER_WAITING), waitingKb);
  }
  return false;
}
export async function handleSpecificCallbackRoute(ctx) {
  const { sClient, id, data, callbackQuery, s, send, editAudienceCallback, mainKeyboard, chatKeyboard, updateAction, sendConnectionNotice, isAdmin } = ctx;
  if (!data.startsWith('specific:accept:') && !data.startsWith('specific:decline:')) return false;
  const reqId = Number(data.split(':')[2]);
  const req = await getSpecificRequest(sClient, reqId);
  if (!req || req.status !== 'pending' || isSpecificExpired(req)) {
    if (req && req.status === 'pending') await setSpecificStatus(sClient, reqId, 'expired');
    await updateAction(sClient, id, null);
    return send(id, scrFb(s, 'specific_waiting', 'expired', 'این درخواست منقضی شده است.'), mainKeyboard(s));
  }
  if (Number(req.recipient_id) !== Number(id)) return send(id, scrFb(s, 'specific_request', 'not_for_you', 'این درخواست برای شما نیست.'));
  const senderId = Number(req.sender_id);
  if (data.startsWith('specific:decline:')) {
    await setSpecificStatus(sClient, reqId, 'declined');
    try { await editAudienceCallback(callbackQuery, id, scrFb(s, 'specific_request', 'declined_receiver', SPECIFIC_RECEIVER_DECLINED), { reply_markup: { inline_keyboard: [] } }); } catch { await send(id, scrFb(s, 'specific_request', 'declined_receiver', SPECIFIC_RECEIVER_DECLINED)); }
    const senderState = (await sClient.query('SELECT action_state FROM users WHERE telegram_id=$1', [senderId])).rows[0]?.action_state;
    if (senderState === `contact:waiting:${reqId}`) {
      await sClient.query("UPDATE users SET action_state=NULL, updated_at=NOW() WHERE telegram_id=$1", [senderId]);
      try { await send(senderId, scrFb(s, 'specific_request', 'declined_sender', SPECIFIC_SENDER_DECLINED), mainKeyboard(s)); } catch {}
    }
    await updateAction(sClient, id, null);
    return true;
  }
  const senderRow = (await sClient.query('SELECT status, action_state FROM users WHERE telegram_id=$1', [senderId])).rows[0];
  const receiverRow = (await sClient.query('SELECT status FROM users WHERE telegram_id=$1', [id])).rows[0];
  if (!senderRow || senderRow.action_state !== `contact:waiting:${reqId}`) {
    await setSpecificStatus(sClient, reqId, 'expired');
    await updateAction(sClient, id, null);
    try { await editAudienceCallback(callbackQuery, id, scrFb(s, 'specific_request', 'expired_sender', SPECIFIC_RECEIVER_EXPIRED), { reply_markup: { inline_keyboard: [] } }); } catch { await send(id, scrFb(s, 'specific_request', 'expired_sender', SPECIFIC_RECEIVER_EXPIRED)); }
    return true;
  }
  if (senderRow.status === 'chatting' || receiverRow?.status === 'chatting') {
    await setSpecificStatus(sClient, reqId, 'expired');
    await sClient.query("UPDATE users SET action_state=NULL, updated_at=NOW() WHERE telegram_id=$1", [senderId]);
    try { await send(senderId, scrFb(s, 'specific_request', 'busy_other', 'درخواست منقضی شد چون یکی از شما در مکالمه دیگری است.'), mainKeyboard(s)); } catch {}
    await updateAction(sClient, id, null);
    try { await editAudienceCallback(callbackQuery, id, 'این مکالمه دیگر فعال نیست.', { reply_markup: { inline_keyboard: [] } }); } catch {}
    return true;
  }
  const blocked = await sClient.query('SELECT 1 FROM anonymous_blocks WHERE user_low=LEAST($1::bigint,$2::bigint) AND user_high=GREATEST($1::bigint,$2::bigint) AND expires_at > NOW()', [senderId, id]);
  if (blocked.rowCount) {
    await setSpecificStatus(sClient, reqId, 'expired');
    await sClient.query("UPDATE users SET action_state=NULL, updated_at=NOW() WHERE telegram_id=$1", [senderId]);
    await updateAction(sClient, id, null);
    return send(id, scrFb(s, 'specific_target', 'blocked', 'این گفتگو دیگر در دسترس نیست.'), mainKeyboard(s));
  }
  await setSpecificStatus(sClient, reqId, 'accepted');
  await sClient.query("UPDATE users SET status='chatting', partner_id=$2, conversation_started_at=NOW(), action_state=NULL, updated_at=NOW() WHERE telegram_id=$1", [senderId, id]);
  await sClient.query("UPDATE users SET status='chatting', partner_id=$2, conversation_started_at=NOW(), action_state=NULL, updated_at=NOW() WHERE telegram_id=$1", [id, senderId]);
  try { await editAudienceCallback(callbackQuery, id, 'اتصال برقرار شد؛ گفت‌وگو را شروع کن.', { reply_markup: { inline_keyboard: [] } }); } catch {}
  await sendConnectionNotice(senderId, s, chatKeyboard(s, isAdmin(senderId)));
  await sendConnectionNotice(id, s, chatKeyboard(s, isAdmin(id)));
  return true;
}
