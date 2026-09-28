import pg from 'pg';
import { processMandatoryLifecycle, syncMandatoryReport } from '../src/mandatory-service.js';
import { mandatoryAudienceIncludesUser } from '../src/mandatory-audience.js';
import { prepareBotDatabase } from './webhook.js';
import { decryptMandatoryTrackingUserId } from '../src/mandatory-tracking-token.js';

const { Pool } = pg;
let pool;
function getPool() {
  if (!pool) pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2, idleTimeoutMillis: 5000, connectionTimeoutMillis: 5000, ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false } });
  return pool;
}

async function telegram(method, body) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is missing');
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(8_000),
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(`Telegram ${method}: ${result.description || response.status}`);
  return result.result;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).send('method not allowed');
  const code = String(req.query?.code || '').trim();
  if (!code) return res.status(400).send('missing tracking code');
  await prepareBotDatabase();
  const client = await getPool().connect();
  try {
    const found = await client.query("SELECT id,target,source_type,status,created_by,audience FROM mandatory_sources WHERE tracking_code=$1", [code]);
    const source = found.rows[0];
    if (!source || source.status !== 'active' || !/^https?:\/\//i.test(source.target)) return res.status(404).send('source unavailable');
    const userId = decryptMandatoryTrackingUserId(String(req.query?.uid || ''), process.env.MANDATORY_TRACKING_SECRET || process.env.TELEGRAM_BOT_TOKEN);
    if (userId) {
      const profile = await client.query('SELECT gender,plus_expires_at FROM users WHERE telegram_id=$1', [userId]);
      const eligible = profile.rows[0] && mandatoryAudienceIncludesUser(source.audience, profile.rows[0]);
      const recorded = eligible ? await client.query("INSERT INTO mandatory_source_events(source_id,telegram_id,event_type) VALUES ($1,$2,'click') ON CONFLICT DO NOTHING RETURNING source_id", [source.id, userId]) : { rowCount: 0 };
      if (recorded.rowCount) {
        await client.query('UPDATE mandatory_sources SET updated_at=NOW() WHERE id=$1', [source.id]);
        try {
          await processMandatoryLifecycle(client, {
            telegramCall: telegram,
            sendAdmin: (chatId, text, markup) => telegram('sendMessage', { chat_id: chatId, text, protect_content: true, ...(markup ? { reply_markup: markup.reply_markup || markup } : {}) }),
          });
          await syncMandatoryReport(client, source.id, telegram);
        } catch (error) { console.error('mandatory_click_lifecycle_error', source.id, String(error?.message || error).slice(0, 200)); }
      }
    }
    res.setHeader('Cache-Control', 'no-store');
    return res.redirect(302, source.target);
  } finally { client.release(); }
}
