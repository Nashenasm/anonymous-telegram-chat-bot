import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import v8 from 'node:v8';
import { createWriteStream } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
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

async function archiveBuffer(entries, format = 'zip') {
  return new Promise((resolve, reject) => {
    const archive = archiver(format === 'tar.gz' ? 'tar' : 'zip', format === 'tar.gz' ? { gzip: true, gzipOptions: { level: 9 } } : { zlib: { level: 9 } });
    const output = new PassThrough(); const chunks = [];
    output.on('data', chunk => chunks.push(chunk)); output.on('end', () => resolve(Buffer.concat(chunks)));
    output.on('error', reject); archive.on('error', reject); archive.pipe(output);
    for (const entry of entries) archive.append(entry.content, { name: entry.name });
    archive.finalize().catch(reject);
  });
}
async function zipBuffer(filename, content) { return archiveBuffer([{ name: filename, content }], 'zip'); }

function csvValue(value) {
  if (value === null || value === undefined) return '';
  const text = Buffer.isBuffer(value) ? `\\x${value.toString('hex')}` : typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export async function createDatabaseBackup(pool, format = 'zip') {
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
  const sqlBuffer = Buffer.from(sqlChunks.join('\n'), 'utf8');
  const jsonBuffer = Buffer.from(JSON.stringify(data, null, 2) + '\n', 'utf8');
  if (format === 'sql') return sqlBuffer;
  if (format === 'json') return jsonBuffer;
  if (format === 'csv') return archiveBuffer(files.filter(file => file.name.endsWith('.csv')), 'zip');
  const entries = [
    { name: 'database.sql', content: sqlBuffer }, { name: 'database.json', content: jsonBuffer },
    { name: 'schema.json', content: Buffer.from(JSON.stringify(schema, null, 2) + '\n', 'utf8') },
    { name: 'README.txt', content: Buffer.from(readme, 'utf8') },
    { name: 'manifest.json', content: Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8') },
    ...files.map(file => ({ name: file.name, content: Buffer.from(file.content, 'utf8') })),
  ];
  return archiveBuffer(entries, 'zip');
}

async function projectRoot() {
  return path.resolve(process.cwd());
}

export async function createSourceArchive(format = 'zip') {
  const root = await projectRoot();
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'anonymous-bot-source-'));
  const extension = format === 'tar.gz' ? 'tar.gz' : 'zip';
  const output = path.join(temp, `anonymous-telegram-chat-bot-updated.${extension}`);
  await new Promise((resolve, reject) => {
    const archive = archiver(format === 'tar.gz' ? 'tar' : 'zip', format === 'tar.gz' ? { gzip: true, gzipOptions: { level: 9 } } : { zlib: { level: 9 } });
    const stream = createWriteStream(output);
    stream.on('close', resolve);
    stream.on('error', reject);
    archive.on('error', reject);
    archive.pipe(stream);
    archive.glob('**/*', { cwd: root, dot: true, ignore: ['node_modules/**', '.git/**', '.env', '*.zip'] });
    archive.append(Buffer.from(JSON.stringify({ format: 'anonymous-telegram-chat-source', createdAt: new Date().toISOString(), excludes: ['.env', '.git', 'node_modules'], restore: 'Extract this ZIP and run npm ci, then apply the database migration.' }, null, 2) + '\n'), { name: 'SOURCE_MANIFEST.json' });
    archive.finalize().catch(reject);
  });
  return { path: output, name: `anonymous-telegram-chat-bot-updated.${extension}` };
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
    const stats = await fs.statfs('/'); const total = Number(stats.blocks) * Number(stats.bsize); const free = Number(stats.bavail) * Number(stats.bsize);
    return { total, free, used: Math.max(0, total - free) };
  } catch { return null; }
}

async function commandText(command, args = []) {
  try { const result = await execFileAsync(command, args, { timeout: 5000, maxBuffer: 256 * 1024 }); return String(result.stdout || '').trim(); }
  catch { return ''; }
}
function formatDuration(seconds) { const n=Math.max(0,Math.floor(Number(seconds)||0)); const d=Math.floor(n/86400),h=Math.floor(n%86400/3600),m=Math.floor(n%3600/60); return [d?`${d} روز`:null,h?`${h} ساعت`:null,`${m} دقیقه`].filter(Boolean).join('، '); }
function percent(value,total) { return total>0 ? `${Math.round(value/total*100)}٪` : 'نامشخص'; }


export async function collectServerStatus(pool, telegramCall) {
  const checkedAt=new Date(); const totalMem=os.totalmem(); const freeMem=os.freemem(); const usedMem=totalMem-freeMem; const load=os.loadavg?.()[0] || 0; const cores=os.cpus()?.length || 1;
  let db=null,counts={users:'?',waiting:'?',chatting:'?'},dbError=null;
  try { db=(await pool.query('SELECT current_database() AS database')).rows[0]; counts=(await pool.query("SELECT COUNT(*)::int AS users, COUNT(*) FILTER (WHERE status='waiting')::int AS waiting, COUNT(*) FILTER (WHERE status='chatting')::int AS chatting FROM users")).rows[0]||counts; } catch(error) { dbError=String(error?.message||error).slice(0,140); }
  let telegram='⚪ نامشخص'; try { const me=await telegramCall('getMe',{}); telegram=`🟢 وصل است — @${me.username||me.first_name||me.id}`; } catch(error) { telegram=`🔴 وصل نیست — ${String(error?.message||error).slice(0,120)}`; }
  const disk=await temporaryDisk(); const uptimeSec=os.uptime(); const serviceState=await commandText('systemctl',['is-active','anonymous-telegram-chat.service']); const serviceSince=await commandText('systemctl',['show','anonymous-telegram-chat.service','--property=ActiveEnterTimestamp','--value']); const portState=await commandText('sh',['-lc',"ss -ltn '( sport = :3000 )' | tail -n +2"]); const hostname=os.hostname();
  const memIcon=usedMem/totalMem>=.9?'🔴':usedMem/totalMem>=.75?'🟡':'🟢'; const loadRatio=load/cores; const loadIcon=loadRatio>=1?'🔴':loadRatio>=.7?'🟡':'🟢'; const diskIcon=disk && disk.used/disk.total>=.9?'🔴':disk && disk.used/disk.total>=.75?'🟡':'🟢'; const serviceIcon=serviceState==='active'?'🟢':'🔴'; const portIcon=portState?'🟢':'🔴';
  const overall=[serviceState==='active',Boolean(db&&!dbError),Boolean(portState),usedMem/totalMem<.9].every(Boolean)?'🟢 سالم و در حال سرویس‌دهی':'🔴 نیازمند بررسی';
  const lines=['🖥️ گزارش اختصاصی VPS ربات','━━━━━━━━━━━━━━━━',`وضعیت کلی: ${overall}`,`نام سرور: ${hostname}`,`زمان بررسی: ${checkedAt.toLocaleString('fa-IR',{timeZone:'Asia/Tehran'})}`,'','⚙️ سرویس ربات',`${serviceIcon} anonymous-telegram-chat.service: ${serviceState||'نامشخص'}`,`شروع سرویس: ${serviceSince||'نامشخص'}`,`${portIcon} پورت ۳۰۰۰: ${portState?'در حال listen':'باز نیست'}`,`Uptime سیستم: ${formatDuration(uptimeSec)}`,'','🧠 RAM کل VPS',`مصرف: ${humanBytes(usedMem)} از ${humanBytes(totalMem)} — ${percent(usedMem,totalMem)} ${memIcon}`,`آزاد: ${humanBytes(freeMem)}`,'','⚡ CPU و Load',`هسته‌ها: ${cores}`,`Load یک دقیقه: ${load.toFixed(2)} — نسبت به هسته‌ها: ${(loadRatio*100).toFixed(0)}٪ ${loadIcon}`,'','💾 دیسک ریشه VPS',disk?`مصرف: ${humanBytes(disk.used)} از ${humanBytes(disk.total)} — ${percent(disk.used,disk.total)} ${diskIcon}`:'اطلاعات دیسک خوانده نشد.',disk?`آزاد: ${humanBytes(disk.free)}`:'','', '🗄️ PostgreSQL',dbError?`🔴 خطا: ${dbError}`:`🟢 وصل است — ${db?.database||'نامشخص'}`,`کاربران: ${counts.users} | در صف: ${counts.waiting} | در مکالمه: ${counts.chatting}`,'','🤖 اتصال تلگرام',telegram,'','این گزارش از خود VPS، systemd، RAM/CPU، دیسک، پورت و PostgreSQL خوانده شده است؛ دیگر گزارش Vercel یا Serverless نیست.'];
  return lines.filter((line,index)=>line||lines[index-1]!=='').join('\n');
}

export async function removeTempFile(filePath) {
  try { await fs.rm(filePath, { force: true }); } catch {}
}
