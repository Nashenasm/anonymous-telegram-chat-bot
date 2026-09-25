import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/anonymous-link-service.js', () => ({
  getStableLink: vi.fn(),
  resolveLink: vi.fn(),
  pairIsBlocked: vi.fn(),
  hasConsent: vi.fn(),
  queueAnonymousMessage: vi.fn(),
  decideAnonymousMessage: vi.fn(),
  createAnonymousBlock: vi.fn(),
}));

import { createAnonymousFlow } from '../src/anonymous-flow.js';
import {
  createAnonymousBlock,
  decideAnonymousMessage,
  getStableLink,
  hasConsent,
  pairIsBlocked,
  queueAnonymousMessage,
  resolveLink,
} from '../src/anonymous-link-service.js';

function harness(initial = {}) {
  const states = new Map(Object.entries(initial));
  const statuses = new Map();
  const pool = {
    query: vi.fn(async (sql, params = []) => {
      if (sql.includes('SELECT action_state FROM users')) {
        const id = String(params[0]);
        return { rows: states.has(id) ? [{ action_state: states.get(id) }] : [] };
      }
      if (sql.includes('SELECT status FROM users')) {
        const id = String(params[0]);
        return { rows: [{ status: statuses.get(id) || 'idle' }] };
      }
      if (sql.includes('UPDATE users SET action_state')) {
        if (sql.includes('telegram_id = ANY')) {
          for (const id of params[0] || []) states.set(String(id), null);
          return { rows: [], rowCount: (params[0] || []).length };
        }
        states.set(String(params[1]), params[0]);
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('SELECT telegram_id, action_state FROM users')) {
        return {
          rows: params
            .map((id) => String(id))
            .filter((id) => states.has(id))
            .map((id) => ({ telegram_id: id, action_state: states.get(id) })),
        };
      }
      if (sql.includes('UPDATE users SET action_state = NULL WHERE telegram_id = ANY')) {
        for (const id of params[0] || []) states.set(String(id), null);
        return { rows: [], rowCount: (params[0] || []).length };
      }
      return { rows: [], rowCount: 0 };
    }),
  };
  const send = vi.fn(async () => undefined);
  const sendLink = vi.fn(async () => undefined);
  const flow = createAnonymousFlow({
    pool,
    send,
    sendLink,
    connectButton: 'وصل کن به ناشناس',
    disconnectButton: 'قطع مکالمه',
  });
  return { flow, pool, send, sendLink, states, statuses };
}

describe('anonymous deep-link flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'test-telegram-token');
    vi.stubGlobal('fetch', vi.fn(async () => ({
      json: async () => ({ ok: true, result: { username: 'anonymous_test_bot' } }),
    })));
    getStableLink.mockResolvedValue('https://t.me/anonymous_test_bot?start=' + 'a'.repeat(64));
    resolveLink.mockResolvedValue(200);
    pairIsBlocked.mockResolvedValue(false);
    hasConsent.mockResolvedValue(false);
    queueAnonymousMessage.mockResolvedValue({ status: 'queued' });
    decideAnonymousMessage.mockResolvedValue(null);
    createAnonymousBlock.mockResolvedValue(undefined);
  });

  it('shows a stable, forwardable link using the dedicated sendLink path', async () => {
    const { flow, send, sendLink } = harness();
    await flow.handleLinkButton(100);
    expect(getStableLink).toHaveBeenCalledWith(expect.any(Object), '100', expect.any(String), 'anonymous_test_bot');
    expect(sendLink).toHaveBeenCalledWith(
      '100',
      'https://t.me/anonymous_test_bot?start=' + 'a'.repeat(64),
      expect.objectContaining({ reply_markup: expect.objectContaining({ keyboard: expect.any(Array) }) }),
    );
    expect(send).not.toHaveBeenCalledWith('100', expect.stringContaining('?start='), expect.anything());
  });

  it('rejects malformed and self-targeting payloads without opening a compose state', async () => {
    const { flow, send, states } = harness();
    await expect(flow.handleStartPayload(100, 'short')).resolves.toBe(false);
    resolveLink.mockResolvedValueOnce(100);
    await expect(flow.handleStartPayload(100, 'b'.repeat(64))).resolves.toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(states.has('100')).toBe(false);
  });

  it('starts message composition for a valid recipient link', async () => {
    const { flow, send, states } = harness();
    await expect(flow.handleStartPayload(100, 'c'.repeat(64))).resolves.toBe(true);
    expect(states.get('100')).toBe('anon_compose:200');
    expect(send).toHaveBeenCalledWith(100, 'پیام ناشناس خود را بنویسید:', expect.any(Object));
  });

  it('preserves an in-progress anonymous action but lets a completed sender open a new link', async () => {
    const { flow, states, send } = harness({ '100': 'anon_compose:300' });
    await expect(flow.handleStartPayload(100, 'd'.repeat(64))).resolves.toBe(true);
    expect(states.get('100')).toBe('anon_compose:300');
    expect(send).toHaveBeenCalledWith(100, expect.stringContaining('عملیات ناشناس'), expect.any(Object));

    states.set('100', 'anon_done');
    await expect(flow.handleStartPayload(100, 'e'.repeat(64))).resolves.toBe(true);
    expect(states.get('100')).toBe('anon_compose:200');
  });

  it('sends directly after this sender has already received permission', async () => {
    hasConsent.mockResolvedValue(true);
    const { flow, states, send } = harness({ '100': 'anon_compose:200' });
    await expect(flow.handleText(100, 'سلام', 'anon_compose:200')).resolves.toBe(true);
    expect(queueAnonymousMessage).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith('200', 'پیام ناشناس:\nسلام', {
      reply_markup: {
        inline_keyboard: [[
          { text: 'پاسخ دادن', callback_data: 'anon:reply:100' },
          { text: 'بلاک کردن', callback_data: 'anon:block:100' },
        ]],
      },
    });
    expect(states.get('200')).toBe('anon_last:100');
    expect(states.get('100')).toBe('anon_wait:200');
    expect(send).toHaveBeenCalledWith('100', 'پیامتون ارسال شد منتظر پاسخ بمونید');
  });

  it('asks for consent once and finishes the sender turn after queueing', async () => {
    const { flow, states, send } = harness({ '100': 'anon_compose:200' });
    await expect(flow.handleText(100, 'سلام', 'anon_compose:200')).resolves.toBe(true);
    expect(queueAnonymousMessage).toHaveBeenCalledWith(expect.any(Object), '100', '200', 'سلام');
    expect(states.get('200')).toBe('anon_consent:100');
    expect(states.get('100')).toBe('anon_wait:200');
    expect(send).toHaveBeenCalledWith('200', 'شما یک پیام ناشناس دارید، آیا قبول میکنید؟', {
      reply_markup: {
        inline_keyboard: [[
          { text: 'بله', callback_data: 'anon:consent_yes:100' },
          { text: 'خیر', callback_data: 'anon:consent_no:100' },
        ]],
      },
    });
    expect(send).toHaveBeenCalledWith('100', 'پیامتون ارسال شد منتظر پاسخ بمونید');
  });

  it('does not forward a second message while waiting and keeps reply/block controls', async () => {
    const { flow, send } = harness({ '100': 'anon_wait:200' });
    await expect(flow.handleText(100, 'متن دوم', 'anon_wait:200')).resolves.toBe(true);
    expect(queueAnonymousMessage).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith('100', 'پیامتون ارسال شد منتظر پاسخ بمونید');
    expect(send).not.toHaveBeenCalledWith('200', expect.stringContaining('متن دوم'), expect.anything());
  });

  it('turns each reply into a single delivered message and waits for the other person', async () => {
    const { flow, states, send } = harness({ '200': 'anon_reply:100' });
    await expect(flow.handleText(200, 'پاسخ', 'anon_reply:100')).resolves.toBe(true);
    expect(send).toHaveBeenCalledWith('100', 'پیام ناشناس:\nپاسخ', expect.any(Object));
    expect(states.get('100')).toBe('anon_last:200');
    expect(states.get('200')).toBe('anon_wait:100');
  });

  it('routes inline reply and block actions only for the current anonymous conversation', async () => {
    const { flow, states, send } = harness({ '200': 'anon_last:100' });
    await expect(flow.handleCallback('200', 'anon:reply:100')).resolves.toBe(true);
    expect(states.get('200')).toBe('anon_reply:100');
    expect(send).toHaveBeenCalledWith('200', 'جواب خود را بنویسید:');

    states.set('200', 'anon_last:100');
    await expect(flow.handleCallback('200', 'anon:block:100')).resolves.toBe(true);
    expect(states.get('200')).toBe('anon_block_confirm:100');
    expect(send).toHaveBeenLastCalledWith('200', 'آیا از بلاک کردن این کاربر مطمئن هستید؟', {
      reply_markup: {
        inline_keyboard: [[
          { text: 'بله مطمئنم', callback_data: 'anon:block_confirm:100' },
          { text: 'خیر ادامه میدم', callback_data: 'anon:block_cancel:100' },
        ]],
      },
    });
  });

  it('does not allow stale inline controls to act on a different recipient', async () => {
    const { flow, states, send } = harness({ '200': 'anon_last:100' });
    await expect(flow.handleCallback('200', 'anon:block:999')).resolves.toBe(true);
    expect(states.get('200')).toBe('anon_last:100');
    expect(createAnonymousBlock).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith('200', 'این دکمه دیگر معتبر نیست.');
  });

  it('uses the inline consent choice to approve only its matching pending sender', async () => {
    decideAnonymousMessage.mockResolvedValue({ accepted: true, senderId: 100, body: 'سلام' });
    const { flow, states, send } = harness({ '200': 'anon_consent:100' });
    await expect(flow.handleCallback('200', 'anon:consent_yes:100')).resolves.toBe(true);
    expect(decideAnonymousMessage).toHaveBeenCalledWith(expect.any(Object), '200', true);
    expect(states.get('200')).toBe('anon_last:100');
    expect(send).toHaveBeenCalledWith('200', 'پیام ناشناس:\nسلام', expect.objectContaining({
      reply_markup: expect.objectContaining({ inline_keyboard: expect.any(Array) }),
    }));
  });

  it('blocks only when the inline confirmation is approved and resumes safely when canceled', async () => {
    const { flow, states } = harness({ '200': 'anon_block_confirm:100' });
    await expect(flow.handleCallback('200', 'anon:block_cancel:100')).resolves.toBe(true);
    expect(createAnonymousBlock).not.toHaveBeenCalled();
    expect(states.get('200')).toBe('anon_last:100');

    states.set('200', 'anon_block_confirm:100');
    await expect(flow.handleCallback('200', 'anon:block_confirm:100')).resolves.toBe(true);
    expect(createAnonymousBlock).toHaveBeenCalledWith(expect.any(Object), '200', '100');
    expect(states.get('200')).toBe(null);
  });

  it('declines without granting continuing permission or delivering the message', async () => {
    decideAnonymousMessage.mockResolvedValue({ accepted: false, senderId: 100, body: null });
    const { flow, states, send } = harness({ '100': 'anon_wait:200', '200': 'anon_consent:100' });
    await expect(flow.handleText(200, 'خیر', 'anon_consent:100')).resolves.toBe(true);
    expect(decideAnonymousMessage).toHaveBeenCalledWith(expect.any(Object), '200', false);
    expect(hasConsent).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith('200', 'پیام ناشناس حذف شد.', expect.any(Object));
    expect(states.get('200')).toBe(null);
    expect(states.get('100')).toBe(null);
    expect(send).toHaveBeenCalledWith('100', expect.stringContaining('پیامت دریافت نشد'), expect.any(Object));
    expect(send).not.toHaveBeenCalledWith('100', expect.stringContaining('سلام'), expect.anything());
  });

  it('blocks only after explicit confirmation', async () => {
    const { flow, states } = harness({ '100': 'anon_block_confirm:200' });
    await expect(flow.handleText(100, 'بله مطمئنم', 'anon_block_confirm:200')).resolves.toBe(true);
    expect(createAnonymousBlock).toHaveBeenCalledWith(expect.any(Object), '100', '200');
    expect(states.get('100')).toBe(null);
  });

  it('returns to the conversation without blocking when confirmation is declined', async () => {
    const { flow, states } = harness({ '100': 'anon_block_confirm:200' });
    await expect(flow.handleText(100, 'خیر ادامه میدم', 'anon_block_confirm:200')).resolves.toBe(true);
    expect(createAnonymousBlock).not.toHaveBeenCalled();
    expect(states.get('100')).toBe('anon_last:200');
  });
});
