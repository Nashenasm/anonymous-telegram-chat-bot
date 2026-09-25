import { createHmac, createHash } from 'node:crypto';

const TOKEN_CONTEXT = 'anon-link:v1';
const MAX_BODY_LENGTH = 4096;
const HEX_TOKEN = /^[0-9a-f]{64}$/;

function canonicalPair(a, b) {
  const an = Number(a);
  const bn = Number(b);
  if (!Number.isFinite(an) || !Number.isFinite(bn)) {
    throw new Error('Invalid telegram id');
  }
  return an <= bn ? [an, bn] : [bn, an];
}

async function withTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Rollback failed: nothing to surface beyond the original error.
    }
    throw err;
  } finally {
    client.release();
  }
}

export function deterministicToken(botToken, userId) {
  if (!botToken || typeof botToken !== 'string') {
    throw new Error('Invalid bot token');
  }
  if (userId === undefined || userId === null) {
    throw new Error('Invalid user id');
  }
  const hmac = createHmac('sha256', botToken);
  hmac.update(`${TOKEN_CONTEXT}:${userId}`);
  return hmac.digest('hex').toLowerCase();
}

export function tokenDigest(token) {
  return createHash('sha256').update(String(token), 'utf8').digest();
}

export async function getStableLink(pool, userId, botToken, username) {
  if (!pool) throw new Error('Database pool is required');
  if (userId === undefined || userId === null) throw new Error('User id is required');
  if (!botToken || typeof botToken !== 'string') throw new Error('Bot token is required');
  if (!username || typeof username !== 'string') throw new Error('Username is required');

  const token = deterministicToken(botToken, userId);
  const digest = tokenDigest(token);

  await withTransaction(pool, async (client) => {
    await client.query(
      'INSERT INTO users (telegram_id) VALUES ($1) ON CONFLICT DO NOTHING',
      [userId]
    );

    await client.query(
      `UPDATE anon_links
          SET revoked_at = now()
        WHERE telegram_id = $1
          AND expires_at IS NOT NULL
          AND expires_at < now()
          AND revoked_at IS NULL`,
      [userId]
    );

    await client.query(
      `UPDATE anon_links
          SET revoked_at = now()
        WHERE telegram_id = $1
          AND token_hash <> $2
          AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > now())`,
      [userId, digest]
    );

    await client.query(
      `INSERT INTO anon_links (token_hash, telegram_id, expires_at)
       VALUES ($1, $2, NULL)
       ON CONFLICT (token_hash) DO UPDATE
       SET revoked_at = NULL, expires_at = NULL
       WHERE anon_links.telegram_id = $2`,
      [digest, userId]
    );
  });

  const handle = username.replace(/^@+/, '');
  return `https://t.me/${handle}?start=${token}`;
}

export async function resolveLink(pool, rawToken) {
  if (!pool) throw new Error('Database pool is required');
  if (typeof rawToken !== 'string' || !HEX_TOKEN.test(rawToken)) return null;

  const digest = tokenDigest(rawToken);
  const result = await pool.query(
    `SELECT telegram_id
       FROM anon_links
      WHERE token_hash = $1
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > now())`,
    [digest]
  );

  if (result.rows.length === 0) return null;
  const telegramId = result.rows[0].telegram_id;
  return typeof telegramId === 'number' ? telegramId : Number(telegramId);
}

export async function pairIsBlocked(pool, a, b) {
  if (!pool) throw new Error('Database pool is required');
  const [lo, hi] = canonicalPair(a, b);
  const result = await pool.query(
    'SELECT 1 FROM anonymous_blocks WHERE user_low = $1 AND user_high = $2',
    [lo, hi]
  );
  return result.rows.length > 0;
}

export async function hasConsent(pool, sender, recipient) {
  if (!pool) throw new Error('Database pool is required');
  if (sender === undefined || sender === null) throw new Error('Sender is required');
  if (recipient === undefined || recipient === null) throw new Error('Recipient is required');
  const result = await pool.query(
    'SELECT 1 FROM anonymous_pair_permissions WHERE sender_id = $1 AND recipient_id = $2',
    [Number(sender), Number(recipient)]
  );
  return result.rows.length > 0;
}

export async function queueAnonymousMessage(pool, sender, recipient, body) {
  if (!pool) throw new Error('Database pool is required');
  if (sender === undefined || sender === null) return { status: 'invalid' };
  if (recipient === undefined || recipient === null) return { status: 'invalid' };

  const senderId = Number(sender);
  const recipientId = Number(recipient);
  if (!Number.isFinite(senderId) || !Number.isFinite(recipientId)) {
    return { status: 'invalid' };
  }
  if (senderId === recipientId) return { status: 'invalid' };

  const text = typeof body === 'string' ? body.trim() : '';
  if (!text || text.length > MAX_BODY_LENGTH) return { status: 'invalid' };

  return withTransaction(pool, async (client) => {
    await client.query(
      'INSERT INTO users (telegram_id) VALUES ($1) ON CONFLICT DO NOTHING',
      [senderId]
    );

    const recipientRow = await client.query(
      'SELECT 1 FROM users WHERE telegram_id = $1',
      [recipientId]
    );
    if (recipientRow.rows.length === 0) return { status: 'invalid' };

    const [lo, hi] = canonicalPair(senderId, recipientId);
    const blocked = await client.query(
      'SELECT 1 FROM anonymous_blocks WHERE user_low = $1 AND user_high = $2',
      [lo, hi]
    );
    if (blocked.rows.length > 0) return { status: 'blocked' };

    const insert = await client.query(
      `INSERT INTO anonymous_pending_messages (sender_id, recipient_id, message_body)
       VALUES ($1, $2, $3)
       ON CONFLICT (recipient_id) DO NOTHING`,
      [senderId, recipientId, text]
    );
    if (insert.rowCount === 0) return { status: 'busy' };

    return { status: 'queued' };
  });
}

export async function decideAnonymousMessage(pool, recipient, accept) {
  if (!pool) throw new Error('Database pool is required');
  if (recipient === undefined || recipient === null) throw new Error('Recipient is required');
  const recipientId = Number(recipient);
  if (!Number.isFinite(recipientId)) throw new Error('Invalid recipient id');

  return withTransaction(pool, async (client) => {
    const result = await client.query(
      `SELECT sender_id, recipient_id, message_body
         FROM anonymous_pending_messages
        WHERE recipient_id = $1
        FOR UPDATE`,
      [recipientId]
    );
    if (result.rows.length === 0) return null;

    const pending = result.rows[0];
    const senderId =
      typeof pending.sender_id === 'number' ? pending.sender_id : Number(pending.sender_id);

    if (accept) {
      await client.query(
        `INSERT INTO anonymous_pair_permissions (sender_id, recipient_id)
         VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [senderId, recipientId]
      );
    }

    await client.query(
      'DELETE FROM anonymous_pending_messages WHERE recipient_id = $1',
      [recipientId]
    );

    return {
      senderId,
      recipientId,
      accepted: Boolean(accept),
      body: accept ? pending.message_body : null
    };
  });
}

export async function createAnonymousBlock(pool, a, b) {
  if (!pool) throw new Error('Database pool is required');
  if (a === undefined || a === null || b === undefined || b === null) {
    throw new Error('Both telegram ids are required');
  }
  const [lo, hi] = canonicalPair(a, b);

  await withTransaction(pool, async (client) => {
    await client.query(
      'INSERT INTO anonymous_blocks (user_low, user_high) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [lo, hi]
    );

    await client.query(
      `DELETE FROM anonymous_pending_messages
        WHERE (sender_id = $1 AND recipient_id = $2)
           OR (sender_id = $2 AND recipient_id = $1)`,
      [lo, hi]
    );

    await client.query(
      `DELETE FROM anonymous_pair_permissions
        WHERE (sender_id = $1 AND recipient_id = $2)
           OR (sender_id = $2 AND recipient_id = $1)`,
      [lo, hi]
    );
  });
}

export { withTransaction };
