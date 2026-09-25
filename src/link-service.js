import { randomBytes, createHash } from 'node:crypto';

const TTL_MIN = 1;
const TTL_MAX = 168;

function digest(token) {
  return createHash('sha256').update(token).digest();
}

function validateTtl(ttlHours) {
  const ttl = Number(ttlHours);
  if (!Number.isFinite(ttl) || ttl < TTL_MIN || ttl > TTL_MAX) {
    throw new Error(`ttlHours must be between ${TTL_MIN} and ${TTL_MAX}`);
  }
  return ttl;
}

export async function createLink(pool, userId, baseUrl, ttlHours) {
  const ttl = validateTtl(ttlHours);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "UPDATE anon_links SET revoked_at = now() WHERE telegram_id = $1 AND revoked_at IS NULL AND expires_at > now()",
      [userId]
    );
    const token = randomBytes(32).toString('hex');
    const tokenHash = digest(token);
    await client.query(
      `INSERT INTO anon_links (token_hash, telegram_id, expires_at)
       VALUES ($1, $2, now() + ($3 * interval '1 hour'))`,
      [tokenHash, userId, ttl]
    );
    await client.query('COMMIT');
    return `${baseUrl}?start=${token}`;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function revokeLink(pool, userId) {
  const client = await pool.connect();
  try {
    const result = await client.query(
      "UPDATE anon_links SET revoked_at = now() WHERE telegram_id = $1 AND revoked_at IS NULL",
      [userId]
    );
    return result.rowCount;
  } finally {
    client.release();
  }
}

export async function resolveLink(pool, rawToken) {
  if (!rawToken) return null;
  let token = String(rawToken);
  if (token.startsWith('/')) token = token.slice(1);
  const client = await pool.connect();
  try {
    const result = await client.query(
      `SELECT telegram_id FROM anon_links
       WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`,
      [digest(token)]
    );
    return result.rowCount ? result.rows[0].telegram_id : null;
  } finally {
    client.release();
  }
}
