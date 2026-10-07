import { describe, expect, it, vi } from 'vitest';
import {
  createUserLink,
  listOutbox,
  queueInboxMessage,
  randomLinkToken,
} from '../src/anonymous-inbox-service.js';

function poolWith(handler) {
  const client = { query: vi.fn(handler), release: vi.fn() };
  return { pool: { query: vi.fn(handler), connect: vi.fn(async () => client) }, client };
}

describe('anonymous inbox and multi-link service', () => {
  it('creates cryptographically random 64-character link tokens', () => {
    const a = randomLinkToken();
    const b = randomLinkToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(b).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
  });

  it('rejects messages sent through a closed link', async () => {
    const { pool } = poolWith(async (sql) => {
      if (sql.includes('SELECT 1 FROM anonymous_blocks')) return { rows: [], rowCount: 0 };
      if (sql.includes('FROM anon_links')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 1 };
    });
    await expect(queueInboxMessage(pool, {
      senderId: 100,
      recipientId: 200,
      linkKey: 'a'.repeat(64),
      body: 'سلام',
    })).resolves.toEqual({ status: 'closed' });
  });

  it('queues a message without selecting link_name from the inbox table', async () => {
    const tokenHash = Buffer.from('link-hash');
    const calls = [];
    const { pool } = poolWith(async (sql) => {
      calls.push(sql);
      if (sql.includes('FROM anonymous_blocks')) return { rows: [], rowCount: 0 };
      if (sql.includes('FROM anon_links')) return { rows: [{ token_hash: tokenHash, link_name: 'لینک اصلی' }], rowCount: 1 };
      if (sql.includes('INSERT INTO anonymous_inbox_messages')) return { rows: [{ id: 12, link_hash: tokenHash }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });
    await expect(queueInboxMessage(pool, {
      senderId: 100,
      recipientId: 200,
      linkKey: 'a'.repeat(64),
      body: 'سلام',
    })).resolves.toEqual({ status: 'queued', id: 12, linkName: 'لینک اصلی' });
    expect(calls.find((sql) => sql.includes('INSERT INTO anonymous_inbox_messages'))).not.toContain('RETURNING id,link_hash,link_name');
  });

  it('lists the sender’s own messages, including legacy incoming rows and replies', async () => {
    const rows = [{ id: 7, body: 'سلام', direction: 'incoming', status: 'replied', link_name: 'لینک اصلی' }];
    const { pool } = poolWith(async (sql) => sql.includes('FROM anonymous_inbox_messages') ? { rows, rowCount: 1 } : { rows: [], rowCount: 1 });
    await expect(listOutbox(pool, 100, 10, 10)).resolves.toEqual(rows);
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('WHERE m.sender_id=$1'), [100, 10, 10]);
    expect(pool.query).toHaveBeenCalledWith(expect.not.stringContaining("m.direction='outgoing'"), expect.anything());
  });

  it('enforces the account link limit while allowing Plus users more links', async () => {
    const calls = [];
    const { pool } = poolWith(async (sql, params = []) => {
      calls.push([sql, params]);
      if (sql.includes('SELECT plus_expires_at')) return { rows: [{ plus_expires_at: null }], rowCount: 1 };
      if (sql.includes('COUNT(*)')) return { rows: [{ count: 3 }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });
    await expect(createUserLink(pool, 100, 'چهارم', 'bot-token', 'my_bot')).resolves.toMatchObject({ limited: true, limit: 3 });
    expect(calls.some(([sql]) => sql.includes('FOR UPDATE'))).toBe(true);
  });

  it('returns a short callback key while retaining the full token key', async () => {
    const full = 'a'.repeat(64);
    const short = full.slice(0, 40);
    const { pool } = poolWith(async (sql) => {
      if (sql.includes('SELECT plus_expires_at')) return { rows: [{ plus_expires_at: null }], rowCount: 1 };
      if (sql.includes('COUNT(*)')) return { rows: [{ count: 0 }], rowCount: 1 };
      if (sql.includes('INSERT INTO anon_links')) return { rows: [{ token_key: full, callback_key: short, token_value: 'b'.repeat(64), link_name: 'لینک تست', status: 'active', created_at: new Date() }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });
    const result = await createUserLink(pool, 100, 'لینک تست', 'bot-token', 'my_bot');
    expect(result.token_key).toHaveLength(64);
    expect(result.callback_key).toHaveLength(40);
    expect(result.url).toContain('?start=');
  });
});
