import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWriteStream } from 'node:fs';
import archiver from 'archiver';
import { PassThrough } from 'node:stream';

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

async function zipBuffer(filename, content) {
  return new Promise((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 9 } });
    const output = new PassThrough(); const chunks = [];
    output.on('data', chunk => chunks.push(chunk));
    output.on('end', () => resolve(Buffer.concat(chunks)));
    output.on('error', reject); archive.on('error', reject); archive.pipe(output);
    archive.append(content, { name: filename }); archive.finalize().catch(reject);
  });
}

function csvValue(value) {
  if (value === null || value === undefined) return '';
  const text = Buffer.isBuffer(value) ? `\\x${value.toString('hex')}` : typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export async function createDatabaseBackup(pool) {
  const tables = await pool.query(`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`);
  const sqlChunks = ['-- Anonymous Telegram Chat database backup', `-- Created at ${new Date().toISOString()}`, 'BEGIN;'];
  const data = {};
  const schema = {};
  const files = [];
  for (const table of tables.rows) {
    const name = table.tablename;
    const columns = await pool.query('SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema=\'public\' AND table_name=$1 ORDER BY ordinal_position', [name]);
    const definitions = columns.rows.map(row => ({ name: row.column_name, type: row.data_type, nullable: row.is_nullable === 'YES', default: row.column_default }));
    schema[name] = definitions;
    const names = definitions.map(row => row.name);
    if (!names.length) continue;
    const quotedTable = `"${name.replaceAll('"', '""')}"`;
    const quotedColumns = names.map(x => `"${x.replaceAll('"', '""')}"`).join(', ');
    const rows = await pool.query(`SELECT ${names.map(x => `"${x.replaceAll('"', '""')}"`).join(',')} FROM ${quotedTable}`);
    data[name] = rows.rows;
    sqlChunks.push(`-- ${name}: ${rows.rowCount} rows`);
    for (const row of rows.rows) sqlChunks.push(`INSERT INTO ${quotedTable} (${quotedColumns}) VALUES (${names.map(x => sqlLiteral(row[x])).join(', ')});`);
    const csv = [names.map(csvValue).join(','), ...rows.rows.map(row => names.map(name => csvValue(row[name])).join(','))].join('\n') + '\n';
    files.push({ name: `tables/${name}.csv`, content: csv });
    files.push({ name: `tables/${name}.json`, content: JSON.stringify(rows.rows, null, 2) + '\n' });
  }
  sqlChunks.push('COMMIT;', '');
  const manifest = {
    format: 'anonymous-telegram-chat-backup', version: 2, createdAt: new Date().toISOString(),
    files: ['database.sql', 'database.json', 'schema.json', 'README.txt', ...files.map(file => file.name)],
    restore: 'Use database.sql for PostgreSQL restore. JSON and CSV files are portable exports for inspection or migration.',
  };
  const readme = `Anonymous Telegram Chat database backup\n\nPrimary restore: database.sql\nPortable data: database.json and tables/*.json\nSpreadsheet/import data: tables/*.csv\nSchema metadata: schema.json\nCreated: ${manifest.createdAt}\n`;
  const archive = archiver('zip', { zlib: { level: 9 } });
  const output = new PassThrough(); const chunks = [];
  output.on('data', chunk => chunks.push(chunk));
  const finished = new Promise((resolve, reject) => { output.on('end', () => resolve(Buffer.concat(chunks))); output.on('error', reject); archive.on('error', reject); });
  archive.pipe(output);
  archive.append(Buffer.from(sqlChunks.join('\n'), 'utf8'), { name: 'database.sql' });
  archive.append(Buffer.from(JSON.stringify(data, null, 2) + '\n', 'utf8'), { name: 'database.json' });
  archive.append(Buffer.from(JSON.stringify(schema, null, 2) + '\n', 'utf8'), { name: 'schema.json' });
  archive.append(Buffer.from(readme, 'utf8'), { name: 'README.txt' });
  archive.append(Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8'), { name: 'manifest.json' });
  for (const file of files) archive.append(Buffer.from(file.content, 'utf8'), { name: file.name });
  await archive.finalize();
  return finished;
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
    archive.append(Buffer.from(JSON.stringify({ format: 'anonymous-telegram-chat-source', createdAt: new Date().toISOString(), excludes: ['.env', '.git', 'node_modules'], restore: 'Extract this ZIP and run npm ci, then apply the database migration.' }, null, 2) + '\n'), { name: 'SOURCE_MANIFEST.json' });
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
