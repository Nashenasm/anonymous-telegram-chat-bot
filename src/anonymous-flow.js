import {
  getStableLink,
  resolveLink,
  deterministicToken,
  pairIsBlocked,
  hasConsent,
  queueAnonymousMessage,
  decideAnonymousMessage,
  createAnonymousBlock,
} from './anonymous-link-service.js';
import { applyCoinDelta } from './finance-ledger.js';
import { BONUS_DEFINITIONS, claimBonus } from './bonus-service.js';
import { createUserLink, getOrCreateUserLinks, listUserLinks, setLinkStatus, renameUserLink, resolveLinkDetails, queueInboxMessage, listInbox, listOutbox, markInboxMessage, createOutboxReply } from './anonymous-inbox-service.js';

const CANCEL_WORDS = ['انصراف', 'بازگشت'];
const MAX_LEN = 4096;
const START_TOKEN = /^[A-Za-z0-9_-]{32,64}$/;
const LINK_LABEL = '🔗 لینک ناشناس من';
const INBOX_LABEL = '📥 صندوق دریافت';
const OUTBOX_LABEL = '📤 صندوق ارسال';
const LINKS_LABEL = '🗂 لینک های من';

const MSG_HEADER = 'پیام ناشناس:\n';
const CONSENT_PROMPT = 'شما یک پیام ناشناس دارید، آیا قبول میکنید؟';
const BLOCK_CONFIRM_MSG = 'آیا از بلاک کردن این کاربر مطمئن هستید؟';
const SENT_MSG = 'پیامتون ارسال شد';
const WAIT_MSG = 'پیامتون ارسال شد منتظر پاسخ بمونید';
const BLOCKED_MSG = 'کاربر بلاک شد';
const COMPOSE_PROMPT = 'پیام ناشناس خود را بنویسید:';
const REPLY_PROMPT = 'جواب خود را بنویسید:';
const LEN_MSG = 'پیام باید بین ۱ تا ۴۰۹۶ کاراکتر باشد.';
const CANCEL_MSG = 'لغو شد.';
const BACK_MSG = 'بازگشت به منوی پیام.';
const DISCARDED_MSG = 'پیام ناشناس حذف شد.';
const DECLINED_MSG = 'پیامت دریافت نشد؛ اگر خواستی دوباره پیام بده، از لینک ناشناس استفاده کن.';
const CHOOSE_MSG = 'برای پاسخ دادن یا بلاک کردن از دکمه‌های زیر استفاده کنید.';
const DONE_PROMPT = 'برای شروع چت تصادفی روی دکمه اتصال بزنید.';
const LINK_RETRY_MSG = 'دریافت لینک ناشناس ناموفق بود. لطفاً دوباره تلاش کنید.';
const ACTIVE_ANON_MSG =
  'شما در حال انجام یک عملیات ناشناس هستید. لطفاً ابتدا آن را کامل یا لغو کنید.';

const SAFE_RESPONSES = {
  blocked: 'ارسال پیام به این کاربر ممکن نیست.',
  busy: 'کاربر در حال حاضر یک پیام ناشناس در انتظار دارد. لطفاً بعداً تلاش کنید.',
  invalid: 'ارسال پیام ممکن نیست. لطفاً دوباره تلاش کنید.',
};

const parseState = (state) => {
  if (typeof state !== 'string' || state.length === 0) return null;
  const idx = state.indexOf(':');
  if (idx === -1) return { name: state, id: null };
  return { name: state.slice(0, idx), id: state.slice(idx + 1) };
};

const isActiveState = (state) => typeof state === 'string' && state.startsWith('anon_');

let usernamePromise = null;

export function createAnonymousFlow({ pool, send, sendLink = send, sendAsUser = null, connectButton, disconnectButton }) {
  const uid = (id) => Number(id);
  const deliverMessage = async (senderId, recipientId, text, markup) => {
    if (sendAsUser) return sendAsUser(senderId, recipientId, text, markup);
    return send(recipientId, text, markup);
  };
  const rewardFirstEntry = async (newcomerId, ownerId) => {
    if (typeof pool.connect !== 'function' || String(newcomerId) === String(ownerId)) return false;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const first = await client.query('UPDATE users SET start_completed=TRUE WHERE telegram_id=$1 AND start_completed=FALSE RETURNING telegram_id', [uid(newcomerId)]);
      if (!first.rowCount) { await client.query('COMMIT'); return false; }
      await applyCoinDelta(client, { userId: uid(newcomerId), delta: 20, kind: 'grant', idempotencyKey: `anonymous-entry:${uid(newcomerId)}`, metadata: { source: 'anonymous_link' } });
      const owner = await client.query('SELECT telegram_id FROM users WHERE telegram_id=$1', [uid(ownerId)]);
      if (owner.rowCount) {
        await applyCoinDelta(client, { userId: uid(ownerId), delta: 3, kind: 'referral', idempotencyKey: `anonymous-referral:${uid(newcomerId)}:${uid(ownerId)}`, metadata: { newcomerId: uid(newcomerId) } });
        const bonus = await claimBonus(client, { bonusKey: 'first_referral', userId: uid(ownerId), metadata: { source: 'anonymous_link' } });
        await client.query('UPDATE users SET referred_by=$2 WHERE telegram_id=$1', [uid(newcomerId), uid(ownerId)]);
        await client.query('COMMIT');
        await send(uid(ownerId), '🎁 یک کاربر از لینک ناشناس شما وارد شد و ۳ مانو کوین هدیه گرفتی.');
        if (bonus.granted) { const definition = BONUS_DEFINITIONS.first_referral; await send(uid(ownerId), `🎁 بونوس دریافت کردی\n\nمقدار: +${bonus.amount} مانوکوین\nدلیل: ${definition.title}\n${definition.description}`); }
        return true;
      }
      await client.query('UPDATE users SET referred_by=$2 WHERE telegram_id=$1', [uid(newcomerId), uid(ownerId)]);
      await client.query('COMMIT');
      return true;
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  };

  const kb = (rows) => ({ reply_markup: { keyboard: rows, resize_keyboard: true } });
  const inlineActions = (otherId) => ({
    reply_markup: {
      inline_keyboard: [[
        { text: 'پاسخ دادن', callback_data: `anon:reply:${otherId}` },
        { text: 'بلاک کردن', callback_data: `anon:block:${otherId}` },
      ]],
    },
  });
  const inboxActions = (messageId) => ({ reply_markup: { inline_keyboard: [[
    { text: '💬 پاسخ', callback_data: `ainbox:reply:${messageId}` },
    { text: '🚫 بلاک', callback_data: `ainbox:block:${messageId}` },
  ]] } });
  const backMarkup = (callback = 'alink:menu') => ({ reply_markup: { inline_keyboard: [[{ text: '↩️ بازگشت', callback_data: callback }]] } });
  const linkControls = (key, status) => ({ reply_markup: { inline_keyboard: [
    [{ text: '🪓 باطل کردن', callback_data: `alink:revoke:${key}` }],
    [{ text: status === 'closed' ? '♦️ بازکردن لینک' : '🔒 بستن لینک', callback_data: `alink:${status === 'closed' ? 'open' : 'close'}:${key}` }],
    [{ text: '✏️ تغییر نام', callback_data: `alink:rename:${key}` }],
    [{ text: '➕ لینک جدید', callback_data: 'alink:new' }],
    [{ text: '↩️ بازگشت به لینک‌ها', callback_data: 'alink:list' }],
  ] } });
  const inlineBlockConfirm = (otherId) => ({
    reply_markup: {
      inline_keyboard: [[
        { text: 'بله مطمئنم', callback_data: `anon:block_confirm:${otherId}` },
        { text: 'خیر ادامه میدم', callback_data: `anon:block_cancel:${otherId}` },
      ]],
    },
  });
  const inlineConsent = (senderId) => ({
    reply_markup: {
      inline_keyboard: [[
        { text: 'بله', callback_data: `anon:consent_yes:${senderId}` },
        { text: 'خیر', callback_data: `anon:consent_no:${senderId}` },
      ]],
    },
  });
  const mainKb = (chatting = false) =>
    kb([[LINK_LABEL], ...(chatting ? [[disconnectButton]] : [])]);
  const composeKb = () => kb([[LINK_LABEL], ['انصراف']]);

  const isChatting = async (id) => {
    try {
      const res = await pool.query('SELECT status FROM users WHERE telegram_id = $1', [uid(id)]);
      return !!(res.rows && res.rows.length && res.rows[0].status === 'chatting');
    } catch {
      return false;
    }
  };

  const mainKbFor = async (id) => mainKb(await isChatting(id));

  const setState = async (id, state) => {
    await pool.query('UPDATE users SET action_state = $1 WHERE telegram_id = $2', [
      state == null ? null : String(state),
      uid(id),
    ]);
  };

  const getState = async (id) => {
    const res = await pool.query('SELECT action_state FROM users WHERE telegram_id = $1', [
      uid(id),
    ]);
    return res.rows && res.rows.length ? res.rows[0].action_state : null;
  };

  const clearAnonStates = async (a, b) => {
    const aid = Number(a);
    const bid = Number(b);
    if (!Number.isFinite(aid) || !Number.isFinite(bid)) return;
    let res;
    try {
      res = await pool.query(
        'SELECT telegram_id, action_state FROM users WHERE telegram_id IN ($1, $2)',
        [aid, bid]
      );
    } catch {
      return;
    }
    const matches = [];
    for (const row of res.rows || []) {
      const state = row.action_state;
      if (typeof state !== 'string' || !state.startsWith('anon_')) continue;
      const parsed = parseState(state);
      const counterpart = String(row.telegram_id) === String(aid) ? bid : aid;
      if (parsed && parsed.id != null && String(parsed.id) === String(counterpart)) {
        matches.push(Number(row.telegram_id));
      }
    }
    if (matches.length === 0) return;
    await pool.query(
      'UPDATE users SET action_state = NULL WHERE telegram_id = ANY($1::bigint[]) AND action_state ~ $2',
      [matches, '^anon_']
    );
  };

  const deliver = async (senderId, recipientId, body) => {
    await setState(recipientId, `anon_last:${senderId}`);
    await deliverMessage(senderId, recipientId, MSG_HEADER + body, inlineActions(senderId));
  };

  const finishSender = async (senderId) => {
    const current = await getState(senderId);
    const targetId = parseState(current)?.id;
    if (targetId == null) {
      await setState(senderId, 'anon_done');
      await send(senderId, SENT_MSG);
      return;
    }
    await setState(senderId, `anon_wait:${targetId}`);
    await send(senderId, WAIT_MSG);
  };

  const compose = async (senderId, targetAndLink, body) => {
    const [targetId, linkKey] = String(targetAndLink || '').split(':');
    if (CANCEL_WORDS.includes(body) || body === connectButton || body === LINK_LABEL) {
      await setState(senderId, null);
      await send(senderId, CANCEL_MSG, await mainKbFor(senderId));
      return true;
    }
    if (body.length === 0 || body.length > MAX_LEN) {
      await send(senderId, LEN_MSG, composeKb());
      return true;
    }
    if (await pairIsBlocked(pool, senderId, targetId)) {
      await send(senderId, SAFE_RESPONSES.blocked, await mainKbFor(senderId));
      await setState(senderId, null);
      return true;
    }
    if (!linkKey) {
      if (await hasConsent(pool, senderId, targetId)) { await deliver(senderId, targetId, body); await finishSender(senderId); return true; }
      const legacy = await queueAnonymousMessage(pool, senderId, targetId, body);
      if (legacy?.status === 'queued') { await setState(targetId, `anon_consent:${senderId}`); await send(targetId, CONSENT_PROMPT, inlineConsent(senderId)); await finishSender(senderId); return true; }
      await send(senderId, SAFE_RESPONSES[legacy?.status] || SAFE_RESPONSES.invalid, composeKb());
      return true;
    }
    const result = await queueInboxMessage(pool, { senderId, recipientId: targetId, linkKey, body });
    const status = result && typeof result === 'object' ? result.status : null;
    if (status !== 'queued') {
      if (status === 'blocked') {
        await send(senderId, SAFE_RESPONSES.blocked, await mainKbFor(senderId));
        await setState(senderId, null);
      } else {
        await send(senderId, SAFE_RESPONSES[status] || SAFE_RESPONSES.invalid, composeKb());
      }
      return true;
    }
    if (!(await isChatting(targetId))) await send(targetId, `📥 پیام جدید در صندوق دریافت\n\n${body}\n\n▫️ از لینک: ${result.linkName || 'ناشناس'}`, inboxActions(result.id));
    await setState(senderId, null);
    await send(senderId, '✅ پیامت ارسال شد؛ لازم نیست منتظر بمانی.', await mainKbFor(senderId));
    return true;
  };

  const consent = async (recipientId, senderId, body) => {
    if (body !== 'بله' && body !== 'خیر') {
      await send(recipientId, CONSENT_PROMPT, inlineConsent(senderId));
      return true;
    }
    const blocked = await pairIsBlocked(pool, recipientId, senderId);
    const accept = body === 'بله' && !blocked;
    const delivered = await decideAnonymousMessage(pool, recipientId, accept);
    if (accept && delivered && typeof delivered.body === 'string' && delivered.body.length > 0) {
      const realSenderId = delivered.senderId != null ? delivered.senderId : senderId;
      await setState(recipientId, `anon_last:${realSenderId}`);
      await deliverMessage(realSenderId, recipientId, MSG_HEADER + delivered.body, inlineActions(realSenderId));
    } else {
      await setState(recipientId, null);
      await send(recipientId, DISCARDED_MSG, await mainKbFor(recipientId));
      if (delivered && delivered.accepted === false && delivered.senderId != null) {
        const senderId = String(delivered.senderId);
        await setState(senderId, null);
        await send(senderId, DECLINED_MSG, await mainKbFor(senderId));
      }
    }
    return true;
  };

  const lastMenu = async (recipientId, senderId, body) => {
    if (body === 'پاسخ دادن') {
      await setState(recipientId, `anon_reply:${senderId}`);
      await send(recipientId, REPLY_PROMPT);
    } else if (body === 'بلاک کردن') {
      await setState(recipientId, `anon_block_confirm:${senderId}`);
      await send(recipientId, BLOCK_CONFIRM_MSG, inlineBlockConfirm(senderId));
    } else {
      await send(recipientId, CHOOSE_MSG, inlineActions(senderId));
    }
    return true;
  };

  const reply = async (replierId, targetId, body) => {
    if (CANCEL_WORDS.includes(body)) {
      await setState(replierId, `anon_last:${targetId}`);
      await send(replierId, BACK_MSG);
      return true;
    }
    if (body === connectButton || body === LINK_LABEL) {
      await setState(replierId, `anon_last:${targetId}`);
      await send(replierId, BACK_MSG);
      return true;
    }
    if (body === 'بلاک کردن') {
      await setState(replierId, `anon_block_confirm:${targetId}`);
      await send(replierId, BLOCK_CONFIRM_MSG, inlineBlockConfirm(targetId));
      return true;
    }
    if (body === 'پاسخ دادن') {
      await send(replierId, REPLY_PROMPT);
      return true;
    }
    if (body.length === 0 || body.length > MAX_LEN) {
      await send(replierId, LEN_MSG);
      return true;
    }
    if (await pairIsBlocked(pool, replierId, targetId)) {
      await send(replierId, SAFE_RESPONSES.blocked, await mainKbFor(replierId));
      await setState(replierId, null);
      return true;
    }
    await deliver(replierId, targetId, body);
    await finishSender(replierId);
    return true;
  };

  const blockConfirm = async (blockerId, otherId, body) => {
    if (body === 'بله مطمئنم') {
      await createAnonymousBlock(pool, blockerId, otherId);
      await clearAnonStates(blockerId, otherId);
      await send(blockerId, BLOCKED_MSG, await mainKbFor(blockerId));
      return true;
    }
    if (body === 'خیر ادامه میدم' || CANCEL_WORDS.includes(body)) {
      await setState(blockerId, `anon_last:${otherId}`);
      await send(blockerId, BACK_MSG, inlineActions(otherId));
      return true;
    }
    await send(blockerId, BLOCK_CONFIRM_MSG, inlineBlockConfirm(otherId));
    return true;
  };

  const handleCallback = async (id, callbackData) => {
    if (callbackData.startsWith('alink:')) {
      const [, action, key] = callbackData.split(':');
      if (action === 'menu') { await setState(id, 'anon_menu'); return send(id, linkMenuText(), linkMenuKeyboard()); }
      if (action === 'list') { await setState(id, 'anon_menu'); return sendLinkList(id); }
      if (action === 'new') { await setState(id, 'anon_new_name'); return send(id, '✏️ نام لینک جدید را بفرست؛ برای نام تصادفی «تصادفی» بنویس.', { reply_markup: { inline_keyboard: [[{ text: '🎲 نام تصادفی', callback_data: 'alink:random' }], [{ text: '↩️ بازگشت', callback_data: 'alink:list' }]] } }); }
      if (action === 'random') { await setState(id, 'anon_new_name'); return handlePanelText(id, 'تصادفی', 'anon_new_name'); }
      if (action === 'view') { const row = (await pool.query("SELECT token_value,link_name,status FROM anon_links WHERE telegram_id=$1 AND encode(token_hash,'hex') LIKE $2 || '%' AND status<>'revoked'", [Number(id), key])).rows[0]; if (!row) return send(id, 'این لینک پیدا نشد.', backMarkup('alink:list')); const username = await ensureBotUsername(); const tokenValue = row.token_value || deterministicToken(process.env.TELEGRAM_BOT_TOKEN, id); return sendLink(id, `🔗 ${row.link_name}\nوضعیت: ${row.status === 'active' ? '🟢 فعال' : '⚪ بسته'}\n\nhttps://t.me/${String(username).replace(/^@+/, '')}?start=${tokenValue}`, linkControls(key, row.status)); }
      if (action === 'close' || action === 'open') { const row = await setLinkStatus(pool, id, key, action === 'close' ? 'closed' : 'active'); return send(id, row ? `✅ لینک «${row.link_name}» ${action === 'close' ? 'بسته' : 'باز'} شد.` : 'عملیات روی لینک انجام نشد.', backMarkup('alink:list')); }
      if (action === 'rename') { await setState(id, `anon_rename_link:${key}`); return send(id, 'نام جدید لینک را بفرست.', backMarkup('alink:list')); }
      if (action === 'revoke') { await setState(id, `anon_revoke_confirm:${key}`); return send(id, '⚠️ باطل‌سازی دائمی است و لینک دیگر قابل بازگشت نیست. تأیید می‌کنی؟', { reply_markup: { inline_keyboard: [[{ text: '✅ بله، باطل کن', callback_data: `alink:revoke_yes:${key}` }, { text: '↩️ انصراف', callback_data: 'alink:list' }]] } }); }
      if (action === 'revoke_yes') { const row = await setLinkStatus(pool, id, key, 'revoked'); await setState(id, 'anon_menu'); return send(id, row ? '🪓 لینک به‌طور کامل باطل شد.' : 'این لینک قبلاً باطل شده است.', linkMenuKeyboard()); }
      return true;
    }
    if (callbackData.startsWith('aout:')) {
      const [, action, raw] = callbackData.split(':');
      if (action === 'page') return sendOutbox(id, Number(raw));
      return true;
    }
    if (callbackData.startsWith('ainbox:')) {
      const [, action, raw] = callbackData.split(':'); const messageId = Number(raw);
      if (action === 'page') return sendInbox(id, messageId);
      if (action === 'view') { const row = (await pool.query("SELECT m.id,m.body,l.link_name FROM anonymous_inbox_messages m JOIN anon_links l ON l.token_hash=m.link_hash WHERE m.id=$1 AND m.recipient_id=$2 AND m.status='pending'", [messageId, Number(id)])).rows[0]; return row ? send(id, `✉️ پیام ناشناس\n\n${row.body}\n\n▫️ از لینک: ${row.link_name}`, inboxActions(row.id)) : send(id, 'این پیام دیگر در صندوق فعال نیست.', backMarkup('alink:menu')); }
      if (action === 'reply') { await setState(id, `anon_inbox_reply:${messageId}`); return send(id, '💬 پاسخ خود را بفرست؛ برای لغو «بازگشت» را بزن.', { reply_markup: { inline_keyboard: [[{ text: '↩️ بازگشت', callback_data: 'alink:menu' }]] } }); }
      if (action === 'block') { const row = (await pool.query("SELECT sender_id FROM anonymous_inbox_messages WHERE id=$1 AND recipient_id=$2 AND status='pending'", [messageId, Number(id)])).rows[0]; if (row) { await createAnonymousBlock(pool, id, row.sender_id); await markInboxMessage(pool, messageId, id, 'blocked'); } return send(id, '🚫 کاربر بلاک شد و پیام از صندوق فعال خارج شد.', linkMenuKeyboard()); }
      return true;
    }
    const match = /^anon:(reply|block|block_confirm|block_cancel|consent_yes|consent_no):(\d{1,20})$/.exec(callbackData);
    if (!match) return false;
    const [, action, rawOtherId] = match;
    const otherId = String(rawOtherId);
    const current = parseState(await getState(id));
    if (action === 'consent_yes' || action === 'consent_no') {
      if (!current || current.name !== 'anon_consent' || String(current.id) !== otherId) {
        await send(id, 'این دکمه دیگر معتبر نیست.');
        return true;
      }
      return consent(String(id), otherId, action === 'consent_yes' ? 'بله' : 'خیر');
    }
    const expectedState = action === 'block_confirm' || action === 'block_cancel'
      ? 'anon_block_confirm'
      : 'anon_last';
    if (!current || current.name !== expectedState || String(current.id) !== otherId) {
      await send(id, 'این دکمه دیگر معتبر نیست.');
      return true;
    }

    if (action === 'reply') {
      await setState(id, `anon_reply:${otherId}`);
      await send(id, REPLY_PROMPT);
      return true;
    }

    if (action === 'block') {
      await setState(id, `anon_block_confirm:${otherId}`);
      await send(id, BLOCK_CONFIRM_MSG, inlineBlockConfirm(otherId));
      return true;
    }
    if (action === 'block_confirm') {
      await createAnonymousBlock(pool, id, otherId);
      await clearAnonStates(id, otherId);
      await send(id, BLOCKED_MSG, await mainKbFor(id));
      return true;
    }
    await setState(id, `anon_last:${otherId}`);
    await send(id, BACK_MSG, inlineActions(otherId));
    return true;
  };

  const done = async (id) => {
    await send(id, DONE_PROMPT, await mainKbFor(id));
    return true;
  };

  const handleText = async (id, text, state) => {
    const parsed = parseState(state);
    if (!parsed || !parsed.name.startsWith('anon_')) return false;
    const body = typeof text === 'string' ? text.trim() : '';
    const sid = String(id);
    if (parsed && (parsed.name === 'anon_menu' || parsed.name === 'anon_new_name' || parsed.name === 'anon_inbox_reply' || parsed.name === 'anon_rename_link' || parsed.name === 'anon_revoke_confirm')) return handlePanelText(sid, body, state);
    switch (parsed.name) {
      case 'anon_compose':
        return compose(sid, parsed.id, body);
      case 'anon_consent':
        return consent(sid, parsed.id, body);
      case 'anon_last':
        return lastMenu(sid, parsed.id, body);
      case 'anon_wait':
        await send(sid, WAIT_MSG);
        return true;
      case 'anon_reply':
        return reply(sid, parsed.id, body);
      case 'anon_block_confirm':
        return blockConfirm(sid, parsed.id, body);
      case 'anon_done':
        return done(sid);
      default:
        await setState(sid, null);
        return true;
    }
  };

  const handleStartPayload = async (id, payload) => {
    if (typeof payload !== 'string' || !START_TOKEN.test(payload)) return false;
    let link = null; let legacyMode = false;
    try { link = await resolveLinkDetails(pool, payload); } catch { link = null; }
    if (!link) {
      const legacyTarget = await resolveLink(pool, payload);
      if (typeof legacyTarget === 'number') { link = { telegram_id: legacyTarget, token_key: payload, link_name: 'لینک ناشناس' }; legacyMode = true; }
    }
    const targetId = link?.telegram_id;
    if (typeof targetId !== 'number' || !Number.isFinite(targetId)) return false;
    if (String(targetId) === String(id)) return false;
    if (await pairIsBlocked(pool, id, targetId)) return false;
    const current = await getState(id);
    if (isActiveState(current) && current !== 'anon_done') {
      await send(id, ACTIVE_ANON_MSG, await mainKbFor(id));
      return true;
    }
    await rewardFirstEntry(id, targetId);
    await setState(id, `anon_compose:${targetId}${legacyMode ? '' : `:${link.token_key}`}`);
    await send(id, legacyMode ? COMPOSE_PROMPT : `✉️ پیام ناشناس برای «${link.link_name || 'لینک ناشناس'}»\n\nمتنت را بفرست؛ لازم نیست منتظر پاسخ بمانی.`, composeKb());
    return true;
  };

  const linkMenuKeyboard = () => kb([[INBOX_LABEL, OUTBOX_LABEL], [LINKS_LABEL], ['↩️ بازگشت']]);
  const linkMenuText = () => `╭────── ✦ ──────╮
        🔗 لینک ناشناس من
╰────── ✦ ──────╯

لینک‌هایت را مدیریت کن؛ پیام‌های ورودی بدون معطل‌کردن تو در صندوق ذخیره می‌شوند.
هر پیام را می‌توانی ببینی، پاسخ بدهی یا بلاک کنی.`;
  const ensureBotUsername = async () => {
    if (!usernamePromise) {
      const token = process.env.TELEGRAM_BOT_TOKEN;
      usernamePromise = fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: AbortSignal.timeout(8000) })
        .then((r) => r.json()).then((j) => { if (!j?.ok || !j.result?.username) throw new Error('getMe failed'); return j.result.username; });
      usernamePromise.catch(() => { usernamePromise = null; });
    }
    return usernamePromise;
  };
  const sendLinkList = async (id) => {
    const username = await ensureBotUsername();
    const links = await getOrCreateUserLinks(pool, id, process.env.TELEGRAM_BOT_TOKEN, username);
    const keyboard = links.map((row) => [{ text: `${row.status === 'active' ? '🟢' : '⚪'} ${row.link_name}`, callback_data: `alink:view:${row.callback_key || row.token_key.slice(0, 40)}` }]);
    keyboard.push([{ text: '➕ لینک جدید', callback_data: 'alink:new' }], [{ text: '↩️ بازگشت', callback_data: 'alink:menu' }]);
    return send(id, `🗂 لینک های من\n\n${links.length ? links.map((x, i) => `${i + 1}. ${x.status === 'active' ? 'فعال' : 'بسته'} — ${x.link_name}`).join('\n') : 'هنوز لینکی نساخته‌ای.'}`, { reply_markup: { inline_keyboard: keyboard } });
  };
  const handlePanelText = async (id, body, state) => {
    const isBack = body === '↩️ بازگشت' || body === 'بازگشت' || body === 'انصراف';
    if (isBack) {
      if (state === 'anon_menu') { await setState(id, null); return send(id, BACK_MSG, await mainKbFor(id)); }
      if (state === 'anon_new_name' || state === 'anon_inbox_reply' || String(state || '').startsWith('anon_rename_link:') || String(state || '').startsWith('anon_revoke_confirm:')) { await setState(id, 'anon_menu'); return send(id, 'مدیریت لینک ناشناس', linkMenuKeyboard()); }
      await setState(id, null); return send(id, BACK_MSG, await mainKbFor(id));
    }
    const renameMatch = /^anon_rename_link:(\w+)$/.exec(state || '');
    if (renameMatch) { const row = await renameUserLink(pool, id, renameMatch[1], body); await setState(id, 'anon_menu'); return send(id, row ? `✅ نام لینک به «${row.link_name}» تغییر کرد.` : 'نام لینک معتبر نیست.', linkMenuKeyboard()); }
    const revokeMatch = /^anon_revoke_confirm:(\w+)$/.exec(state || '');
    if (revokeMatch) { if (body === 'تایید' || body === 'بله') { await setLinkStatus(pool, id, revokeMatch[1], 'revoked'); await setState(id, 'anon_menu'); return send(id, '🪓 لینک باطل شد.', linkMenuKeyboard()); } return send(id, 'برای تأیید، «بله» را بفرست یا «بازگشت» را بزن.', backMarkup('alink:list')); }
    if (state === 'anon_menu') {
      if (body === INBOX_LABEL) return sendInbox(id);
      if (body === OUTBOX_LABEL) return sendOutbox(id);
      if (body === LINKS_LABEL) return sendLinkList(id);
      if (body === LINK_LABEL) return handleLinkButton(id);
      return send(id, linkMenuText(), linkMenuKeyboard());
    }
    if (state === 'anon_new_name') {
      const username = await ensureBotUsername();
      if (!username) return send(id, 'دریافت اطلاعات ربات ناموفق بود؛ دوباره تلاش کن.', { reply_markup: { inline_keyboard: [[{ text: '↩️ بازگشت', callback_data: 'alink:list' }]] } });
      const result = await createUserLink(pool, id, body === 'تصادفی' || body === 'بدون نام' ? '' : body, process.env.TELEGRAM_BOT_TOKEN, username);
      await setState(id, 'anon_menu');
      if (result.limited) return send(id, `ظرفیت ساخت لینک تکمیل است؛ سقف حساب شما ${result.limit} لینک است.`, linkMenuKeyboard());
      return sendLink(id, `✅ لینک جدید ساخته شد\n\n🔗 ${result.link_name}\n${result.url}`, linkControls(result.callback_key || result.token_key.slice(0, 40), 'active'));
    }
    const replyMatch = /^anon_inbox_reply:(\d+)$/.exec(state || '');
    if (replyMatch) {
      if (!body || body.length > MAX_LEN) return send(id, LEN_MSG, { reply_markup: { inline_keyboard: [[{ text: '↩️ بازگشت', callback_data: 'alink:menu' }]] } });
      const messageId = Number(replyMatch[1]);
      const original = (await pool.query("SELECT sender_id,link_hash FROM anonymous_inbox_messages WHERE id=$1 AND recipient_id=$2 AND direction='incoming' AND status='pending'", [messageId, Number(id)])).rows[0];
      if (!original) return send(id, 'این پیام دیگر در صندوق فعال نیست.', linkMenuKeyboard());
      await createOutboxReply(pool, { senderId: id, recipientId: original.sender_id, linkHash: original.link_hash, body });
      await markInboxMessage(pool, messageId, id, 'replied');
      await setState(id, 'anon_menu');
      await send(original.sender_id, `💬 پاسخ جدیدی به پیام ناشناس شما رسید:\n\n${body}`);
      return send(id, '✅ پاسخ ارسال شد.', linkMenuKeyboard());
    }
    return false;
  };
  const sendInbox = async (id, offset = 0) => {
    const rows = await listInbox(pool, id, offset);
    const text = rows.length ? rows.map((r) => `✉️ ${r.body}\n▫️ از: ${r.link_name}\n▫️ ${new Date(r.created_at).toLocaleString('fa-IR')}`).join('\n\n') : 'صندوق دریافتت خالی است.';
    const buttons = rows.map((r) => [{ text: `💬 مدیریت پیام ${r.id}`, callback_data: `ainbox:view:${r.id}` }]);
    if (rows.length === 10) buttons.push([{ text: '📜 پیام‌های قدیمی‌تر', callback_data: `ainbox:page:${offset + 10}` }]);
    buttons.push([{ text: '↩️ بازگشت', callback_data: 'alink:menu' }]);
    return send(id, `📥 صندوق دریافت\n\n${text}`, { reply_markup: { inline_keyboard: buttons } });
  };
  const sendOutbox = async (id, offset = 0) => {
    const rows = await listOutbox(pool, id, offset);
    const text = rows.length ? rows.map((r) => `📨 ${r.body}\n▫️ از لینک: ${r.link_name}\n▫️ ${new Date(r.created_at).toLocaleString('fa-IR')}`).join('\n\n') : 'صندوق ارسال خالی است.';
    const buttons = rows.length === 10 ? [[{ text: '📜 پیام‌های قدیمی‌تر', callback_data: `aout:page:${offset + 10}` }]] : [];
    buttons.push([{ text: '↩️ بازگشت', callback_data: 'alink:menu' }]);
    return send(id, `📤 صندوق ارسال\n\n${text}`, { reply_markup: { inline_keyboard: buttons } });
  };

  const handleLinkButton = async (id) => {
    const sid = String(id);
    const replyWith = async (text) => {
      await send(sid, text, await mainKbFor(sid));
      return true;
    };

    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) return replyWith(LINK_RETRY_MSG);

    try {
      if (!usernamePromise) {
        usernamePromise = fetch(`https://api.telegram.org/bot${token}/getMe`, {
          signal: AbortSignal.timeout(8000),
        })
          .then((r) => r.json())
          .then((j) => {
            if (!j || !j.ok || !j.result || !j.result.username) throw new Error('getMe failed');
            return j.result.username;
          });
        usernamePromise.catch(() => {
          usernamePromise = null;
        });
      }

      let username = null;
      try {
        username = await usernamePromise;
      } catch {
        username = null;
        usernamePromise = null;
      }
      if (!username) return replyWith(LINK_RETRY_MSG);

      let links;
      try { links = await getOrCreateUserLinks(pool, sid, token, username); }
      catch {
        const legacyUrl = await getStableLink(pool, sid, token, username);
        await sendLink(sid, legacyUrl, await mainKbFor(sid));
        return true;
      }
      if (!links.length) return replyWith('ظرفیت ساخت لینک تکمیل است. کاربران عادی حداکثر ۳ و کاربران Plus حداکثر ۱۰ لینک دارند.');
      await setState(sid, 'anon_menu');
      const rendered = links.map((link, index) => `🔗 ${index + 1}) ${link.link_name}\nوضعیت: ${link.status === 'active' ? '🟢 فعال' : '⚪ بسته'}\n${link.url || `https://t.me/${username}?start=${link.token_value || link.token_key}`}`).join('\n\n');
      const listButtons = links.map((link, index) => [{ text: `⚙️ مدیریت لینک ${index + 1}`, callback_data: `alink:view:${link.callback_key || link.token_key.slice(0, 40)}` }]);
      listButtons.push([{ text: '➕ لینک جدید', callback_data: 'alink:new' }], [{ text: '↩️ بازگشت به منو', callback_data: 'alink:menu' }]);
      await sendLink(sid, `🔗 لینک‌های ناشناس شما\n\n${rendered}`, { reply_markup: { inline_keyboard: listButtons } });
      await send(sid, linkMenuText(), linkMenuKeyboard());
      return true;
    } catch {
      usernamePromise = null;
      return replyWith(LINK_RETRY_MSG);
    }
  };

  return { handleLinkButton, handleStartPayload, handleText, handleCallback, handlePanelText, isActiveState };
}
