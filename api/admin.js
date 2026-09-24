import crypto from 'crypto';
import pg from 'pg';

const { Pool } = pg;
let pool;

function getPool() {
  if (!pool) pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2, idleTimeoutMillis: 5000, connectionTimeoutMillis: 5000 });
  return pool;
}

function safeCompare(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    const key = process.env.ADMIN_PANEL_KEY;
    if (!key || !safeCompare(req.headers['x-admin-panel-key'] || '', key)) return res.status(401).json({ error: 'Unauthorized' });
    const expectedId = process.env.ADMIN_TELEGRAM_ID || '5551857686';
    if (!safeCompare(req.headers['x-admin-telegram-id'] || '', expectedId)) return res.status(401).json({ error: 'Unauthorized' });
    if (req.query.action !== 'health') return res.status(400).json({ error: 'Invalid action' });
    const client = await getPool().connect();
    try {
      const result = await client.query(`SELECT
        (SELECT COUNT(*) FROM users) AS users,
        (SELECT COUNT(*) FROM reports) AS reports,
        (SELECT COUNT(*) FROM anon_links) AS anon_links`);
      const row = result.rows[0];
      return res.status(200).json({ users: Number(row.users), reports: Number(row.reports), anon_links: Number(row.anon_links) });
    } finally { client.release(); }
  } catch { return res.status(500).json({ error: 'Internal server error' }); }
}
