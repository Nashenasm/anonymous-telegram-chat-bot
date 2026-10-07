import { randomBytes, createHash, createHmac } from 'node:crypto';

const MAX_BODY_LENGTH = 4096;
const normalizeId = (id) => Number(id);
const deterministicToken = (botToken, userId) => createHmac('sha256', botToken).update(`anon-link:v1:${userId}`).digest('hex');
const tokenDigest = (token) => createHash('sha256').update(String(token), 'utf8').digest();
async function withTransaction(pool, fn) { const client = await pool.connect(); try { await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result; } catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; } finally { client.release(); } }

export function randomLinkToken() {
  return randomBytes(32).toString('base64url');
}

export function linkLimitForUser(user) {
  const expiry = user?.plus_expires_at ? new Date(user.plus_expires_at).getTime() : 0;
  return expiry > Date.now() ? 10 : 3;
}

export async function listUserLinks(pool, userId, { includeClosed = true } = {}) {
  const statusClause = includeClosed ? "status IN ('active','closed')" : "status='active'";
  const result = await pool.query(`SELECT encode(token_hash,'hex') AS token_key, substring(encode(token_hash,'hex') from 1 for 40) AS callback_key, token_value, token_hash, link_name, status, created_at, closed_at
    FROM anon_links WHERE telegram_id=$1 AND ${statusClause} ORDER BY created_at ASC`, [normalizeId(userId)]);
  return result.rows;
}

export async function createUserLink(pool, userId, name, botToken, username) {
  const id = normalizeId(userId);
  if (!Number.isFinite(id) || !botToken || !username) throw new Error('Invalid link arguments');
  const token = randomLinkToken();
  const safeName = String(name || '').trim().slice(0, 48) || `لینک ${Math.floor(Math.random() * 900 + 100)}`;
  const digest = tokenDigest(token);
  const result = await withTransaction(pool, async (client) => {
    await client.query('INSERT INTO users (telegram_id) VALUES ($1) ON CONFLICT DO NOTHING', [id]);
    const user = (await client.query('SELECT plus_expires_at FROM users WHERE telegram_id=$1 FOR UPDATE', [id])).rows[0];
    const limit = linkLimitForUser(user);
    const count = Number((await client.query("SELECT COUNT(*)::int AS count FROM anon_links WHERE telegram_id=$1 AND status IN ('active','closed')", [id])).rows[0]?.count || 0);
    if (count >= limit) return { limited: true, limit };
    const row = (await client.query(`INSERT INTO anon_links(token_hash,token_value,telegram_id,link_name,status) VALUES($1,$2,$3,$4,'active') RETURNING encode(token_hash,'hex') AS token_key,substring(encode(token_hash,'hex') from 1 for 40) AS callback_key,token_value,link_name,status,created_at`, [digest, token, id, safeName])).rows[0];
    return { row, token };
  });
  if (result.limited) return result;
  return { ...result.row, token, url: `https://t.me/${String(username).replace(/^@+/, '')}?start=${result.token}` };
}

export async function getOrCreateUserLinks(pool, userId, botToken, username) {
  const links = await listUserLinks(pool, userId);
  if (links.length) {
    const legacy = deterministicToken(botToken, userId);
    return links.map((row) => ({ ...row, token: row.token_value || legacy, url: `https://t.me/${String(username).replace(/^@+/, '')}?start=${row.token_value || legacy}` }));
  }
  const created = await createUserLink(pool, userId, 'لینک اصلی', botToken, username);
  return created.limited ? [] : [created];
}

export async function resolveLinkDetails(pool, rawToken) {
  if (typeof rawToken !== 'string' || !/^[A-Za-z0-9_-]{32,64}$/.test(rawToken)) return null;
  const result = await pool.query(`SELECT telegram_id,encode(token_hash,'hex') AS token_key,link_name,status
    FROM anon_links WHERE token_hash=$1 AND status='active' AND (expires_at IS NULL OR expires_at>now())`, [tokenDigest(rawToken)]);
  if (!result.rows.length) return null;
  const row = result.rows[0];
  return { ...row, telegram_id: Number(row.telegram_id) };
}

export async function setLinkStatus(pool, userId, tokenKey, status) {
  if (!['active', 'closed', 'revoked'].includes(status)) throw new Error('Invalid link status');
  const result = await pool.query(`UPDATE anon_links SET status=$3,closed_at=CASE WHEN $3='closed' THEN now() ELSE NULL END,revoked_at=CASE WHEN $3='revoked' THEN now() ELSE revoked_at END
    WHERE telegram_id=$1 AND encode(token_hash,'hex') LIKE $2 || '%' AND status<>'revoked' RETURNING encode(token_hash,'hex') AS token_key,substring(encode(token_hash,'hex') from 1 for 40) AS callback_key,link_name,status`, [normalizeId(userId), String(tokenKey), status]);
  return result.rows[0] || null;
}

export async function renameUserLink(pool, userId, tokenKey, name) {
  const safeName = String(name || '').trim().slice(0, 48);
  if (!safeName) return null;
  const result = await pool.query(`UPDATE anon_links SET link_name=$3 WHERE telegram_id=$1 AND encode(token_hash,'hex') LIKE $2 || '%' AND status<>'revoked' RETURNING encode(token_hash,'hex') AS token_key,substring(encode(token_hash,'hex') from 1 for 40) AS callback_key,link_name,status`, [normalizeId(userId), String(tokenKey), safeName]);
  return result.rows[0] || null;
}

export async function queueInboxMessage(pool, { senderId, recipientId, linkKey, body }) {
  const sender = normalizeId(senderId); const recipient = normalizeId(recipientId);
  const text = typeof body === 'string' ? body.trim() : '';
  if (!Number.isFinite(sender) || !Number.isFinite(recipient) || sender === recipient || !text || text.length > MAX_BODY_LENGTH) return { status: 'invalid' };
  return withTransaction(pool, async (client) => {
    const blocked = await client.query('SELECT 1 FROM anonymous_blocks WHERE user_low=LEAST($1::bigint,$2::bigint) AND user_high=GREATEST($1::bigint,$2::bigint) AND expires_at>now()', [sender, recipient]);
    if (blocked.rowCount) return { status: 'blocked' };
    const link = (await client.query("SELECT token_hash,link_name FROM anon_links WHERE telegram_id=$1 AND encode(token_hash,'hex')=$2 AND status='active'", [recipient, linkKey])).rows[0];
    if (!link) return { status: 'closed' };
    const row = (await client.query(`INSERT INTO anonymous_inbox_messages(sender_id,recipient_id,link_hash,body,direction,status)
      VALUES($1,$2,$3,$4,'incoming','pending') RETURNING id,link_hash`, [sender, recipient, link.token_hash, text])).rows[0];
    return { status: 'queued', id: Number(row.id), linkName: link.link_name };
  });
}

export async function listInbox(pool, recipientId, offset = 0, limit = 10) {
  const result = await pool.query(`SELECT m.id,m.sender_id,m.body,m.created_at,l.link_name
    FROM anonymous_inbox_messages m JOIN anon_links l ON l.token_hash=m.link_hash
    WHERE m.recipient_id=$1 AND m.direction='incoming' AND m.status='pending'
    ORDER BY m.id DESC LIMIT $2 OFFSET $3`, [normalizeId(recipientId), limit, Math.max(0, offset)]);
  return result.rows;
}

export async function listOutbox(pool, senderId, offset = 0, limit = 10) {
  const result = await pool.query(`SELECT m.id,m.recipient_id,m.body,m.created_at,m.direction,m.status,l.link_name
    FROM anonymous_inbox_messages m JOIN anon_links l ON l.token_hash=m.link_hash
    WHERE m.sender_id=$1
    ORDER BY m.id DESC LIMIT $2 OFFSET $3`, [normalizeId(senderId), limit, Math.max(0, offset)]);
  return result.rows;
}

export async function getOutboxMessage(pool, id, senderId) {
  const result = await pool.query(`SELECT id,recipient_id,link_hash,body,status
    FROM anonymous_inbox_messages
    WHERE id=$1 AND sender_id=$2 AND direction='outgoing'`, [Number(id), normalizeId(senderId)]);
  return result.rows[0] || null;
}

export async function blockOutboxMessage(pool, id, senderId) {
  const result = await pool.query(`UPDATE anonymous_inbox_messages SET status='blocked',responded_at=now()
    WHERE id=$1 AND sender_id=$2 AND direction='outgoing' AND status='pending' RETURNING *`, [Number(id), normalizeId(senderId)]);
  return result.rows[0] || null;
}

export async function markInboxMessage(pool, id, recipientId, status) {
  if (!['replied', 'blocked'].includes(status)) throw new Error('Invalid inbox status');
  const result = await pool.query(`UPDATE anonymous_inbox_messages SET status=$3,responded_at=now() WHERE id=$1 AND recipient_id=$2 AND direction='incoming' AND status='pending' RETURNING *`, [Number(id), normalizeId(recipientId), status]);
  return result.rows[0] || null;
}

export async function createOutboxReply(pool, { senderId, recipientId, linkHash, body }) {
  const result = await pool.query(`INSERT INTO anonymous_inbox_messages(sender_id,recipient_id,link_hash,body,direction,status)
    VALUES($1,$2,$3,$4,'outgoing','pending') RETURNING id`, [normalizeId(senderId), normalizeId(recipientId), linkHash, String(body).trim()]);
  return result.rows[0];
}
