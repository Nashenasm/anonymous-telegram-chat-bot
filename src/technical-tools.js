import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import v8 from 'node:v8';
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

function humanBytes(value) {
  if (!Number.isFinite(value)) return 'نامشخص';
  const units = ['B', 'KB', 'MB', 'GB', 'TB']; let number = Math.max(0, value); let index = 0;
  while (number >= 1024 && index < units.length - 1) { number /= 1024; index += 1; }
  return `${number >= 10 || index === 0 ? Math.round(number) : number.toFixed(1)} ${units[index]}`;
}
function usageBar(used, limit, width = 16) {
  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return '░'.repeat(width);
  const ratio = Math.max(0, Math.min(1, used / limit)); const filled = Math.round(ratio * width);
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)} ${Math.round(ratio * 100)}٪`;
}
function level(used, limit) {
  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return { icon: 'ℹ️', text: 'سقف دقیق اعلام نشده' };
  const ratio = used / limit;
  if (ratio >= 0.9) return { icon: '🔴', text: 'خطر؛ تقریباً پر است' };
  if (ratio >= 0.75) return { icon: '🟡', text: 'توجه؛ بهتر است مراقب باشی' };
  return { icon: '🟢', text: 'خوب و عادی' };
}
async function cgroupMemoryLimit() {
  for (const file of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    try {
      const raw = (await fs.readFile(file, 'utf8')).trim();
      if (raw && raw !== 'max') { const number = Number(raw); if (Number.isFinite(number) && number > 0) return number; }
    } catch {}
  }
  return null;
}
async function temporaryDisk() {
  try {
    const stats = await fs.statfs('/tmp'); const total = Number(stats.blocks) * Number(stats.bsize); const free = Number(stats.bavail) * Number(stats.bsize);
    return { total, free, used: Math.max(0, total - free) };
  } catch { return null; }
}

export async function collectServerStatus(pool, telegramCall) {
  const checkedAt = new Date(); const startedAt = new Date(Date.now() - process.uptime() * 1000);
  let db = null; let counts = { users: '?', waiting: '?', chatting: '?' }; let dbError = null;
  try {
    const dbResult = await pool.query('SELECT current_database() AS database'); db = dbResult.rows[0];
    const countResult = await pool.query(`SELECT COUNT(*)::int AS users, COUNT(*) FILTER (WHERE status='waiting')::int AS waiting, COUNT(*) FILTER (WHERE status='chatting')::int AS chatting FROM users`);
    counts = countResult.rows[0] || counts;
  } catch (error) { dbError = String(error?.message || error).slice(0, 140); }
  let telegram = '⚪ نامشخص';
  try { const me = await telegramCall('getMe', {}); telegram = `🟢 وصل است — @${me.username || me.first_name || me.id}`; } catch (error) { telegram = `🔴 وصل نیست — ${String(error?.message || error).slice(0, 120)}`; }
  const memory = process.memoryUsage(); const memoryLimit = await cgroupMemoryLimit(); const visibleMemoryLimit = memoryLimit || os.totalmem();
  const memoryLevel = level(memory.rss, visibleMemoryLimit); const disk = await temporaryDisk(); const heapLimit = v8.getHeapStatistics().heap_size_limit;
  const load = os.loadavg?.()[0]; const cores = os.cpus()?.length || 1;
  const overall = memoryLevel.icon === '🔴' || dbError || telegram.startsWith('🔴') ? '🔴 نیاز به بررسی' : memoryLevel.icon === '🟡' ? '🟡 فعلاً خوب است، ولی نزدیک سقف شده' : '🟢 همه‌چیز عادی به نظر می‌رسد';
  const lines = [
    '📊 گزارش سادهٔ وضعیت ربات',
    '━━━━━━━━━━━━━━━━',
    `نتیجهٔ کلی: ${overall}`,
    `زمان بررسی: ${checkedAt.toLocaleString('fa-IR', { timeZone: 'Asia/Tehran' })}`,
    '',
    '🧠 حافظهٔ ربات',
    `مصرف فعلی: ${humanBytes(memory.rss)} از ${humanBytes(visibleMemoryLimit)}`,
    `باقی‌ماندهٔ تقریبی: ${humanBytes(Math.max(0, visibleMemoryLimit - memory.rss))}`,
    `${usageBar(memory.rss, visibleMemoryLimit)}  ${memoryLevel.icon} ${memoryLevel.text}`,
    memoryLimit ? 'این سقف از محدودیت محیط اجرا خوانده شده است.' : 'سقف دقیق محیط اعلام نشده؛ عدد بالا سقف قابل‌مشاهدهٔ سیستم است.',
    `حافظهٔ داخلی Node: ${humanBytes(memory.heapUsed)} از ${humanBytes(heapLimit)} استفاده شده`,
    '',
    '⚙️ پردازنده',
    `تعداد هستهٔ قابل‌مشاهده: ${cores}`,
    `فشار پردازنده در یک دقیقهٔ اخیر: ${Number.isFinite(load) ? load.toFixed(2) : 'نامشخص'} (هرچه کمتر، بهتر)`,
    '',
    '💾 فضای موقت سرور',
    disk ? `مصرف: ${humanBytes(disk.used)} از ${humanBytes(disk.total)} — باقی‌مانده: ${humanBytes(disk.free)}` : 'اطلاعات فضای موقت در این محیط قابل‌خواندن نیست.',
    disk ? `${usageBar(disk.used, disk.total)} ${level(disk.used, disk.total).icon}` : '',
    '',
    '🗄️ دیتابیس',
    dbError ? `🔴 وصل نشد: ${dbError}` : `🟢 وصل است — ${db?.database || 'نام پایگاه‌داده نامشخص'}`,
    `کاربران: ${counts.users} | در صف: ${counts.waiting} | در مکالمه: ${counts.chatting}`,
    '',
    '🤖 تلگرام', telegram,
    '',
    '⏱️ معنی این اعداد',
    'اگر نوار حافظه به ۹۰٪ برسد، یعنی ربات به سقف نزدیک شده و باید مصرف یا ظرفیت بررسی شود.',
    'Uptime در Vercel ثابت نیست؛ چون هر اجرای Serverless ممکن است از یک محیط تازه شروع شود.',
    process.env.VERCEL ? 'محدودیت زمانی این پروژه: webhook حداکثر ۳۰ ثانیه و پنل فنی حداکثر ۱۵ ثانیه برای هر درخواست.' : 'این ربات خارج از Vercel با محدودیت زمانی هاست فعلی اجرا می‌شود.',
    `شروع این پردازش: ${startedAt.toLocaleString('fa-IR', { timeZone: 'Asia/Tehran' })}`,
  ];
  return lines.filter((line, index) => line || lines[index - 1] !== '').join('\n');
}

export async function removeTempFile(filePath) {
  try { await fs.rm(filePath, { force: true }); } catch {}
}
