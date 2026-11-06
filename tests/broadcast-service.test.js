import { describe, expect, it } from 'vitest';
import {
  broadcastReportKeyboard,
  callWithRateLimitRetry,
  ensureBroadcastSchema,
  publishBroadcastReport,
  runBroadcastJobs,
  runBroadcastPinJob,
} from '../src/broadcast-service.js';

describe('broadcast worker safeguards', () => {
  it('skips a broadcast run when another worker holds the database lock', async () => {
    const client = {
      released: false,
      async query(sql) {
        if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: false }] };
        return { rows: [] };
      },
      release() { this.released = true; },
    };
    const result = await runBroadcastJobs({ pool: { connect: async () => client } });
    expect(result.skipped).toBe(true);
    expect(client.released).toBe(true);
  });

  it('retries Telegram 429 responses using retry_after metadata', async () => {
    let attempts = 0;
    const result = await callWithRateLimitRetry(async () => {
      attempts += 1;
      if (attempts === 1) {
        const error = new Error('Too Many Requests');
        error.error_code = 429;
        error.parameters = { retry_after: 0.001 };
        throw error;
      }
      return { message_id: 12 };
    }, 'copyMessage', { chat_id: 99 });
    expect(result).toEqual({ message_id: 12 });
    expect(attempts).toBe(2);
  });

  it('backfills report versions only once so later refresh requests stay queued', async () => {
    const queries = [];
    await ensureBroadcastSchema({ query: async sql => { queries.push(sql); return { rows: [], rowCount: 0 }; } });
    const migration = queries.find(sql => sql.includes('broadcast-report-version-v1'));
    expect(migration).toContain('ON CONFLICT DO NOTHING');
    expect(migration).toContain('WHERE EXISTS (SELECT 1 FROM inserted)');
    expect(queries.filter(sql => sql.includes('report_channel_updated_at=updated_at'))).toHaveLength(0);
  });
});

describe('broadcast report controls', () => {
  it('shows the requested pin and unpin labels based on campaign state', () => {
    const pinButton = row => broadcastReportKeyboard(row).inline_keyboard.flat().find(button => button.callback_data.includes(':pin:') || button.callback_data.includes(':unpin:'));
    expect(pinButton({ id: 7, status: 'completed', pin_state: 'unpinned' })).toMatchObject({ text: 'پین کردن🤌', callback_data: 'broadcast:report:pin:7' });
    expect(pinButton({ id: 7, status: 'completed', pin_state: 'pinned' })).toMatchObject({ text: 'برداشتن پین😶‍🌫️', callback_data: 'broadcast:report:unpin:7' });
  });

  it('pins each delivered message in its recipient private chat and completes the campaign state', async () => {
    const campaign = { id: '8', status: 'completed', pin_state: 'pinning', report_channel_id: null, admin_chat_id: null, created_at: new Date(), updated_at: new Date() };
    const called = [];
    const client = {
      released: false,
      async query(sql) {
        if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
        if (sql.includes('SELECT * FROM broadcast_campaigns')) return { rows: [campaign] };
        if (sql.includes('FROM broadcast_deliveries d JOIN users')) return { rows: [{}] };
        if (sql.includes('SELECT user_id,message_id FROM broadcast_deliveries')) return { rows: [{ user_id: '101', message_id: 501 }, { user_id: '102', message_id: 502 }] };
        if (sql.includes('SELECT COUNT(*)::int AS count FROM broadcast_deliveries')) return { rows: [{ count: 0 }] };
        called.push(sql);
        return { rows: [], rowCount: 1 };
      },
      release() { this.released = true; },
    };
    const result = await runBroadcastPinJob({
      pool: { connect: async () => client },
      campaignId: 8,
      telegramCall: async (method, payload) => {
        called.push({ method, payload });
        return true;
      },
    });
    expect(called.filter(item => item?.method === 'pinChatMessage')).toHaveLength(2);
    expect(result.state).toBe('pinned');
    expect(client.released).toBe(true);
  });

  it('forwards the broadcast into the report channel and replies with the report', async () => {
    const date = new Date();
    const campaign = {
      id: '9', status: 'completed', pin_state: 'unpinned', report_channel_id: '-100123',
      report_message_id: null, report_source_message_id: null, admin_chat_id: null, admin_message_id: null,
      source_chat_id: '321', source_message_id: 654, created_at: date, updated_at: date, started_at: date,
      report_version: '2026-11-06 21:00:00.123456+00',
      total_targets: 1, sent_count: 1, failed_count: 0, saved: false,
    };
    const calls = [];
    const updates = [];
    const client = {
      async query(sql, values) {
        if (sql.includes('FROM broadcast_campaigns WHERE id=$1')) return { rows: [{ ...campaign, report_channel_needs_update: true, admin_report_needs_update: false }] };
        if (sql.includes('FROM broadcast_deliveries d JOIN users')) return { rows: [{ total: 1, sent: 1, failed: 0, pending: 0, deleted: 0, pinned: 0, pin_errors: 0 }] };
        updates.push({ sql, values });
        return { rows: [], rowCount: 1 };
      },
    };
    await publishBroadcastReport(client, async (method, payload) => {
      calls.push({ method, payload });
      return { message_id: method === 'forwardMessage' ? 88 : 89 };
    }, 9);
    expect(calls[0]).toMatchObject({ method: 'forwardMessage', payload: { chat_id: '-100123', from_chat_id: '321', message_id: 654 } });
    expect(calls[1].method).toBe('sendMessage');
    expect(calls[1].payload.reply_parameters).toMatchObject({ message_id: 88, allow_sending_without_reply: true });
    expect(updates.find(update => update.sql.includes('report_reply_to_source=$4')).values[2]).toBe(campaign.report_version);
  });

  it('replaces a legacy standalone report with a reply to the forwarded campaign message', async () => {
    const date = new Date();
    const campaign = {
      id: '11', status: 'completed', pin_state: 'unpinned', report_channel_id: '-100123',
      report_message_id: 77, report_source_message_id: null, admin_chat_id: null, admin_message_id: null,
      source_chat_id: '321', source_message_id: 654, created_at: date, updated_at: date, started_at: date,
      total_targets: 1, sent_count: 1, failed_count: 0, saved: false,
    };
    const calls = [];
    const updates = [];
    const client = {
      async query(sql) {
        if (sql.includes('FROM broadcast_campaigns WHERE id=$1')) return { rows: [{ ...campaign, report_channel_needs_update: true, admin_report_needs_update: false }] };
        if (sql.includes('FROM broadcast_deliveries d JOIN users')) return { rows: [{ total: 1, sent: 1, failed: 0, pending: 0, deleted: 0, pinned: 0, pin_errors: 0 }] };
        updates.push(sql);
        return { rows: [], rowCount: 1 };
      },
    };
    await publishBroadcastReport(client, async (method, payload) => {
      calls.push({ method, payload });
      return { message_id: method === 'forwardMessage' ? 88 : 99 };
    }, 11);
    expect(calls.map(call => call.method)).toEqual(['forwardMessage', 'deleteMessage', 'sendMessage']);
    expect(calls[2].payload.reply_parameters.message_id).toBe(88);
    expect(updates.some(sql => sql.includes('report_message_id=NULL'))).toBe(true);
    expect(updates.some(sql => sql.includes('report_message_id=$2'))).toBe(true);
  });

  it('keeps an undeletable legacy report useful and creates the linked report reply', async () => {
    const date = new Date();
    const campaign = {
      id: '12', status: 'completed', pin_state: 'unpinned', report_channel_id: '-100123',
      report_message_id: 77, report_source_message_id: 88, report_reply_to_source: false,
      admin_chat_id: null, admin_message_id: null, source_chat_id: '321', source_message_id: 654,
      created_at: date, updated_at: date, started_at: date, total_targets: 1, sent_count: 1,
      failed_count: 0, saved: false,
    };
    const calls = [];
    const updates = [];
    const client = {
      async query(sql) {
        if (sql.includes('FROM broadcast_campaigns WHERE id=$1')) return { rows: [{ ...campaign, report_channel_needs_update: false, admin_report_needs_update: false }] };
        if (sql.includes('FROM broadcast_deliveries d JOIN users')) return { rows: [{ total: 1, sent: 1, failed: 0, pending: 0, deleted: 0, pinned: 0, pin_errors: 0 }] };
        updates.push(sql);
        return { rows: [], rowCount: 1 };
      },
    };
    await publishBroadcastReport(client, async (method, payload) => {
      calls.push({ method, payload });
      if (method === 'deleteMessage') throw new Error("Bad Request: message can't be deleted");
      return { message_id: 99 };
    }, 12);
    expect(calls.map(call => call.method)).toEqual(['deleteMessage', 'editMessageText', 'sendMessage']);
    expect(calls[1].payload.text).toContain('در پاسخ به پیام اصلی');
    expect(calls[1].payload.reply_markup.inline_keyboard).toEqual([]);
    expect(calls[2].payload.reply_parameters.message_id).toBe(88);
    expect(updates.some(sql => sql.includes('report_message_id=NULL'))).toBe(true);
    expect(updates.some(sql => sql.includes('report_reply_to_source=$4'))).toBe(true);
  });

  it('does not edit an unchanged completed report on every scheduled job run', async () => {
    let queryCount = 0;
    let telegramCalls = 0;
    const client = {
      async query() {
        queryCount += 1;
        return { rows: [{ id: '10', status: 'completed', report_channel_id: '-100123', report_message_id: 90, report_channel_needs_update: false, admin_report_needs_update: false }] };
      },
    };
    await publishBroadcastReport(client, async () => { telegramCalls += 1; }, 10);
    expect(queryCount).toBe(1);
    expect(telegramCalls).toBe(0);
  });
});
