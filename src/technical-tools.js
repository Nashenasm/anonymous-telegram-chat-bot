import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWriteStream } from 'node:fs';
import archiver from 'archiver';
import { gzip } from 'node:zlib';
import { promisify as promisifyFn } from 'node:util';

const gzipAsync = promisifyFn(gzip);

function sqlLiteral(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (value instanceof Date) return `'${value.toISOString().replaceAll("'", "''")}'`;
  if (Buffer.isBuffer(value)) return `decode('${value.toString('hex')}', 'hex')`;
  if (Array.isArray(value)) return `ARRAY[${value.map(sqlLiteral).join(', ')}]`;
  if (typeof value === 'object') return `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
  return `'${String(value).replaceAll("'", "''")}'`;
}

export async function createDatabaseBackup(pool) {
  const tables = await pool.query(`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`);
  const chunks = ['-- Anonymous Telegram Chat database backup', `-- Created at ${new Date().toISOString()}`, 'BEGIN;'];
  for (const table of tables.rows) {
    const name = table.tablename;
    const columns = await pool.query('SELECT column_name FROM information_schema.columns WHERE table_schema=\'public\' AND table_name=$1 ORDER BY ordinal_position', [name]);
    const names = columns.rows.map(row => row.column_name);
    if (!names.length) continue;
    const rows = await pool.query(`SELECT ${names.map(x => `"${x.replaceAll('"', '""')}"`).join(',')} FROM "${name.replaceAll('"', '""')}"`);
    chunks.push(`-- ${name}: ${rows.rowCount} rows`);
    for (const row of rows.rows) chunks.push(`INSERT INTO "${name.replaceAll('"', '""')}" (${names.map(x => `"${x.replaceAll('"', '""')}"`).join(', ')}) VALUES (${names.map(x => sqlLiteral(row[x])).join(', ')});`);
  }
  chunks.push('COMMIT;', '');
  return gzipAsync(Buffer.from(chunks.join('\n'), 'utf8'));
}

async function projectRoot() {
  return path.resolve(process.cwd());
}

export async function createSourceArchive() {
  const root = await projectRoot();
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'anonymous-bot-source-'));
  const output = path.join(temp, 'anonymous-telegram-chat-bot-updated.zip');
  await new Promise((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 9 } });
    const stream = createWriteStream(output);
    stream.on('close', resolve);
    stream.on('error', reject);
    archive.on('error', reject);
    archive.pipe(stream);
    archive.glob('**/*', { cwd: root, dot: true, ignore: ['node_modules/**', '.git/**', '.env', '*.zip'] });
    archive.finalize().catch(reject);
  });
  return { path: output, name: 'anonymous-telegram-chat-bot-updated.zip' };
}

export async function collectServerStatus(pool, telegramCall) {
  const startedAt = new Date(Date.now() - process.uptime() * 1000).toISOString();
  const db = await pool.query('SELECT NOW() AS now, current_database() AS database, version() AS version');
  const counts = await pool.query(`SELECT COUNT(*)::int AS users, COUNT(*) FILTER (WHERE status='waiting')::int AS waiting, COUNT(*) FILTER (WHERE status='chatting')::int AS chatting FROM users`);
  let telegram = 'نامشخص';
  try { const me = await telegramCall('getMe', {}); telegram = `متصل — @${me.username || me.first_name || me.id}`; } catch (error) { telegram = `خطا — ${String(error?.message || error).slice(0, 120)}`; }
  const memory = process.memoryUsage();
  return [
    'وضعیت جامع سرور', '',
    `زمان بررسی: ${new Date().toISOString()}`,
    `Uptime: ${Math.floor(process.uptime())} ثانیه`,
    `شروع پردازش: ${startedAt}`,
    `محیط: ${process.env.NODE_ENV || 'production'}`,
    `نسخه Node: ${process.version}`,
    `پلتفرم اجرا: ${process.env.VERCEL ? 'Vercel Serverless' : 'Node.js'}`,
    `حافظه RSS: ${Math.round(memory.rss / 1024 / 1024)} MB`,
    `حافظه Heap: ${Math.round(memory.heapUsed / 1024 / 1024)} / ${Math.round(memory.heapTotal / 1024 / 1024)} MB`,
    `پایگاه داده: سالم — ${db.rows[0]?.database || 'unknown'}`,
    `کاربران: ${counts.rows[0]?.users || 0}`,
    `در صف: ${counts.rows[0]?.waiting || 0}`,
    `در مکالمه: ${counts.rows[0]?.chatting || 0}`,
    `Telegram: ${telegram}`,
  ].join('\n');
}

export async function removeTempFile(filePath) {
  try { await fs.rm(filePath, { force: true }); } catch {}
}
