import { describe, expect, it, vi } from 'vitest';
import {
  decideAnonymousMessage,
  deterministicToken,
  getStableLink,
  hasConsent,
  queueAnonymousMessage,
  tokenDigest,
} from '../src/anonymous-link-service.js';

function makePool(handler = async () => ({ rows: [], rowCount: 1 })) {
  const client = {
    query: vi.fn(handler),
    release: vi.fn(),
  };
  return { pool: { connect: vi.fn(async () => client), query: vi.fn(handler) }, client };
}

describe('anonymous link storage service', () => {
  it('creates a deterministic, opaque deep-link payload and stores only its digest', async () => {
    const { pool, client } = makePool();
    const token = deterministicToken('private-bot-token', 12345);
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(deterministicToken('private-bot-token', 12345)).toBe(token);
    expect(token).not.toContain('12345');
    expect(tokenDigest(token)).toHaveLength(32);

    await expect(getStableLink(pool, 12345, 'private-bot-token', '@anonymous_bot'))
      .resolves.toBe(`https://t.me/anonymous_bot?start=${token}`);
    const insert = client.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO anon_links'));
    expect(insert).toBeDefined();
    expect(insert[1][0]).toHaveLength(32);
  });

  it('queues one pending message per recipient and reports a busy recipient on conflict', async () => {
    const { pool, client } = makePool(async (sql) => {
      if (sql.includes('INSERT INTO anonymous_pending_messages')) return { rows: [], rowCount: 0 };
      if (sql.includes('SELECT 1 FROM users')) return { rows: [{ '?column?': 1 }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });
    await expect(queueAnonymousMessage(pool, 100, 200, 'hello')).resolves.toEqual({ status: 'busy' });
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('ON CONFLICT (recipient_id) DO NOTHING'), [100, 200, 'hello']);
  });

  it('grants sender-to-recipient permission only after acceptance', async () => {
    const { pool, client } = makePool(async (sql) => {
      if (sql.includes('SELECT sender_id, recipient_id, message_body')) {
        return { rows: [{ sender_id: '100', recipient_id: '200', message_body: 'hello' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });
    await expect(decideAnonymousMessage(pool, 200, true)).resolves.toMatchObject({
      senderId: 100,
      recipientId: 200,
      accepted: true,
      body: 'hello',
    });
    expect(client.query.mock.calls.some(([sql]) => sql.includes('INSERT INTO anonymous_pair_permissions'))).toBe(true);
    expect(client.query.mock.calls.some(([sql]) => sql.includes('DELETE FROM anonymous_pending_messages'))).toBe(true);
  });

  it('deletes a declined pending message without granting permission', async () => {
    const { pool, client } = makePool(async (sql) => {
      if (sql.includes('SELECT sender_id, recipient_id, message_body')) {
        return { rows: [{ sender_id: '100', recipient_id: '200', message_body: 'hello' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });
    await expect(decideAnonymousMessage(pool, 200, false)).resolves.toMatchObject({
      senderId: 100,
      recipientId: 200,
      accepted: false,
      body: null,
    });
    expect(client.query.mock.calls.some(([sql]) => sql.includes('INSERT INTO anonymous_pair_permissions'))).toBe(false);
    expect(client.query.mock.calls.some(([sql]) => sql.includes('DELETE FROM anonymous_pending_messages'))).toBe(true);
  });

  it('looks up permission by directed sender and recipient pair', async () => {
    const { pool } = makePool();
    pool.query = vi.fn(async () => ({ rows: [{ '?column?': 1 }] }));
    await expect(hasConsent(pool, 100, 200)).resolves.toBe(true);
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('sender_id = $1 AND recipient_id = $2'), [100, 200]);
  });
});
