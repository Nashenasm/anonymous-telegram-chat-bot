import pg from 'pg';

const { Pool } = pg;
let pool;
function getPool() {
  if (!pool) pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2, idleTimeoutMillis: 5000, connectionTimeoutMillis: 5000, ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false } });
  return pool;
}

export default async function handler(req, res) {
  const code = String(req.query?.code || '').trim();
  if (!code) return res.status(400).send('missing tracking code');
  const client = await getPool().connect();
  try {
    const found = await client.query("SELECT id,target,source_type,status FROM mandatory_sources WHERE tracking_code=$1", [code]);
    const source = found.rows[0];
    if (!source || source.status !== 'active' || !/^https?:\/\//i.test(source.target)) return res.status(404).send('source unavailable');
    const userId = String(req.query?.uid || '').match(/^\d{3,20}$/)?.[0];
    if (userId) await client.query("INSERT INTO mandatory_source_events(source_id,telegram_id,event_type) VALUES ($1,$2,'click') ON CONFLICT DO NOTHING", [source.id, userId]);
    res.setHeader('Cache-Control', 'no-store');
    return res.redirect(302, source.target);
  } finally { client.release(); }
}
