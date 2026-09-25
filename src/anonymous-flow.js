import {
  getStableLink,
  resolveLink,
  pairIsBlocked,
  hasConsent,
  queueAnonymousMessage,
  decideAnonymousMessage,
  createAnonymousBlock,
} from './anonymous-link-service.js';

const CANCEL_WORDS = ['انصراف', 'بازگشت'];
const MAX_LEN = 4096;
const HEX64 = /^[0-9a-fA-F]{64}$/;
const LINK_LABEL = 'لینک ناشناس من';

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

export function createAnonymousFlow({ pool, send, sendLink = send, connectButton, disconnectButton }) {
  const uid = (id) => Number(id);

  const kb = (rows) => ({ reply_markup: { keyboard: rows, resize_keyboard: true } });
  const inlineActions = (otherId) => ({
    reply_markup: {
      inline_keyboard: [[
        { text: 'پاسخ دادن', callback_data: `anon:reply:${otherId}` },
        { text: 'بلاک کردن', callback_data: `anon:block:${otherId}` },
      ]],
    },
  });
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
    kb([[connectButton, LINK_LABEL], ...(chatting ? [[disconnectButton]] : [])]);
  const composeKb = () => kb([[connectButton, LINK_LABEL], ['انصراف']]);

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
    await send(recipientId, MSG_HEADER + body, inlineActions(senderId));
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

  const compose = async (senderId, targetId, body) => {
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
    if (await hasConsent(pool, senderId, targetId)) {
      await deliver(senderId, targetId, body);
      await finishSender(senderId);
      return true;
    }
    const result = await queueAnonymousMessage(pool, senderId, targetId, body);
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
    await setState(targetId, `anon_consent:${senderId}`);
    await send(targetId, CONSENT_PROMPT, inlineConsent(senderId));
    await finishSender(senderId);
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
      await send(recipientId, MSG_HEADER + delivered.body, inlineActions(realSenderId));
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
    if (typeof payload !== 'string' || !HEX64.test(payload)) return false;
    const targetId = await resolveLink(pool, payload);
    if (typeof targetId !== 'number' || !Number.isFinite(targetId)) return false;
    if (String(targetId) === String(id)) return false;
    if (await pairIsBlocked(pool, id, targetId)) return false;
    const current = await getState(id);
    if (isActiveState(current) && current !== 'anon_done') {
      await send(id, ACTIVE_ANON_MSG, await mainKbFor(id));
      return true;
    }
    await setState(id, `anon_compose:${targetId}`);
    await send(id, COMPOSE_PROMPT, composeKb());
    return true;
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

      const url = await getStableLink(pool, sid, token, username);
      if (!url) return replyWith(LINK_RETRY_MSG);
      await sendLink(sid, url, await mainKbFor(sid));
      return true;
    } catch {
      usernamePromise = null;
      return replyWith(LINK_RETRY_MSG);
    }
  };

  return { handleLinkButton, handleStartPayload, handleText, handleCallback, isActiveState };
}
