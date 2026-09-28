const SOURCE_TYPES = { channel: 'کانال', group: 'گروه', bot: 'ربات', web_app: 'وب اپ', website: 'وب سایت' };
const SOURCE_MODES = { time: 'براساس زمان', count: 'براساس عضویت تأییدشده', start: 'براساس استارت', click: 'براساس کلیک' };
const SOURCE_STATUSES = { scheduled: 'زمان‌بندی‌شده', active: 'درحال اجرا', paused: 'متوقف موقت', completed: 'تکمیل‌شده', failed: 'ناموفق', cancelled: 'لغوشده' };
const HISTORY_LABELS = { created: 'ثبت شد', queued: 'به صف اضافه شد', scheduled: 'زمان‌بندی شد', started: 'شروع شد', paused: 'متوقف شد', rescheduled: 'زمان شروع تغییر کرد', completed: 'تکمیل شد', cancelled: 'لغو شد', removed: 'از اجرای فعال خارج شد', resumed: 'دوباره فعال شد' };
import { mandatoryAudienceLabels } from './mandatory-audience.js';

export function trackingCommand(trackingCode) {
  const suffix = String(trackingCode || '').trim().replace(/^MJ[-_]?/i, '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 28);
  return `/mj_${suffix || 'unknown'}`;
}

export function trackingLookupKey(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function parseTrackingCommand(commandText) {
  const first = String(commandText || '').trim().split(/\s+/, 1)[0];
  const match = first.match(/^\/(mj_[a-z0-9_]{1,28})(?:@[a-z0-9_]{5,32})?$/i);
  return match ? trackingLookupKey(match[1]) : null;
}

function encodeCode(trackingCode) { return Buffer.from(String(trackingCode), 'utf8').toString('base64url'); }
export function decodeTrackingCode(encoded) {
  try { return Buffer.from(String(encoded), 'base64url').toString('utf8'); }
  catch { return ''; }
}

function callback(action, code) { return `mandatory:${action}:${encodeCode(code)}`; }

export function mandatorySourceKeyboard(source) {
  const rows = [[{ text: trackingCommand(source.tracking_code), callback_data: callback('details', source.tracking_code) }]];
  if (source.status === 'scheduled') {
    const scheduleLabel = source.queue_position ? 'زمان‌بندی کردن' : 'تغییر زمان‌بندی';
    rows.push([
      { text: 'الان ست کن', callback_data: callback('activate', source.tracking_code) },
      { text: scheduleLabel, callback_data: callback('schedule', source.tracking_code) },
    ]);
    rows.push([{ text: 'کنسل کردن', callback_data: callback('cancel', source.tracking_code) }]);
  } else if (source.status === 'active') {
    rows.push([
      { text: 'توقف موقت', callback_data: callback('pause', source.tracking_code) },
      { text: 'کنسل کردن', callback_data: callback('cancel', source.tracking_code) },
    ]);
  } else if (source.status === 'paused') {
    rows.push([
      { text: 'ادامه دادن', callback_data: callback('resume', source.tracking_code) },
      { text: 'کنسل کردن', callback_data: callback('cancel', source.tracking_code) },
    ]);
  }
  return { reply_markup: { inline_keyboard: rows } };
}

export function mandatoryTrackingListKeyboard(sources) {
  const rows = sources.slice(0, 50).map(source => [{
    text: trackingCommand(source.tracking_code),
    callback_data: callback('details', source.tracking_code),
  }]);
  return { reply_markup: { inline_keyboard: rows } };
}

function iranDate(value) {
  if (!value) return 'ثبت نشده';
  return new Intl.DateTimeFormat('fa-IR', { timeZone: 'Asia/Tehran', dateStyle: 'short', timeStyle: 'short', hourCycle: 'h23', hour12: false }).format(new Date(value));
}

export function formatMandatorySourceDetails(source, history = [], { includePrivateDetails = false } = {}) {
  const sourceType = SOURCE_TYPES[source.source_type] || source.source_type || 'نامشخص';
  const status = SOURCE_STATUSES[source.status] || source.status || 'نامشخص';
  const mode = SOURCE_MODES[source.mode] || source.mode || 'نامشخص';
  const lines = [
    `گزارش جویین اجباری: ${source.title || 'بدون عنوان'}`,
    `دستور پیگیری: ${trackingCommand(source.tracking_code)}`,
    `کد داخلی: ${source.tracking_code}`,
    `نوع منبع: ${sourceType}`,
    `وضعیت: ${status}`,
    `روش: ${mode}`,
    `مخاطبان: ${mandatoryAudienceLabels(source.audience)}`,
    `آیدی/هدف منبع: ${source.target || 'ثبت نشده'}`,
    `عضویت تأییدشده: ${Number(source.join_count || 0)}`,
    `استارت ثبت‌شده: ${Number(source.start_count || 0)}`,
    `کلیک ثبت‌شده: ${Number(source.click_count || 0)}`,
    `مقدار هدف: ${source.quota || (source.duration_seconds ? `${source.duration_seconds} ثانیه` : 'ثبت نشده')}`,
    `جایگاه صف: ${source.queue_position || 'در صف نیست'}`,
    `زمان‌بندی برای: ${iranDate(source.starts_at)}`,
    `شروع واقعی: ${iranDate(source.started_at)}`,
    `زمان ثبت: ${iranDate(source.created_at)}`,
    `آخرین تغییر: ${iranDate(source.updated_at)}`,
  ];
  if (includePrivateDetails && source.join_url) lines.push(`لینک دعوت خصوصی: ${source.join_url}`);
  if (history.length) {
    lines.push('', 'تاریخچه وضعیت:');
    for (const event of history) {
      const label = HISTORY_LABELS[event.event_type] || event.event_type;
      const detail = event.details && typeof event.details === 'object' ? event.details.note : null;
      lines.push(`• ${iranDate(event.created_at)} — ${label}${detail ? ` — ${detail}` : ''}`);
    }
  }
  const text = lines.join('\n');
  return text.length > 3900 ? `${text.slice(0, 3880)}\n… ادامه جزئیات در پایگاه داده نگه‌داری می‌شود.` : text;
}

export async function getMandatorySourceDetails(client, { id, lookupKey, trackingCode } = {}) {
  const match = id !== undefined
    ? { where: 'ms.id=$1', value: id }
    : trackingCode
      ? { where: 'ms.tracking_code=$1', value: trackingCode }
      : { where: "REGEXP_REPLACE(LOWER(ms.tracking_code), '[^a-z0-9]', '', 'g')=$1", value: lookupKey };
  const result = await client.query(`
    SELECT ms.*,
      (SELECT COUNT(*) FROM mandatory_source_events e WHERE e.source_id=ms.id AND e.event_type='join') AS join_count,
      (SELECT COUNT(*) FROM mandatory_source_events e WHERE e.source_id=ms.id AND e.event_type='start') AS start_count,
      (SELECT COUNT(*) FROM mandatory_source_events e WHERE e.source_id=ms.id AND e.event_type='click') AS click_count,
      (SELECT q.position FROM mandatory_source_queue q WHERE q.source_id=ms.id) AS queue_position
    FROM mandatory_sources ms WHERE ${match.where} LIMIT 1`, [match.value]);
  return result.rows[0] || null;
}

export async function getMandatorySourceHistory(client, sourceId, limit = 12) {
  const result = await client.query('SELECT event_type,details,created_at FROM mandatory_source_history WHERE source_id=$1 ORDER BY id DESC LIMIT $2', [sourceId, limit]);
  return result.rows.reverse();
}

export async function recordMandatorySourceHistory(client, source, eventType, { fromStatus = null, toStatus = source?.status || null, details = {}, notifyAdmin = false } = {}) {
  if (!source?.id) return null;
  const notifyAdminId = notifyAdmin ? (source.created_by || null) : null;
  const result = await client.query(
    `INSERT INTO mandatory_source_history(source_id,event_type,from_status,to_status,details,notify_admin_id)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [source.id, eventType, fromStatus, toStatus, details, notifyAdminId]
  );
  return result.rows[0] || null;
}

export async function syncMandatoryReport(client, sourceId, telegramCall) {
  const configured = await client.query("SELECT value FROM bot_settings WHERE key='mandatory_report_channel_id' AND value <> ''");
  const channelId = configured.rows[0]?.value;
  if (!channelId) return false;

  await client.query('SELECT pg_advisory_lock($1::bigint)', [sourceId]);
  try {
    const source = await getMandatorySourceDetails(client, { id: sourceId });
    if (!source) return false;
    const history = await getMandatorySourceHistory(client, source.id, 12);
    const privacySetting = await client.query("SELECT value FROM bot_settings WHERE key='mandatory_report_channel_private'");
    const text = formatMandatorySourceDetails(source, history, { includePrivateDetails: privacySetting.rows[0]?.value === 'true' });
    const markup = mandatorySourceKeyboard(source).reply_markup;
    const existing = await client.query('SELECT message_id FROM mandatory_source_reports WHERE source_id=$1 AND channel_chat_id=$2', [source.id, channelId]);
    let messageId = existing.rows[0]?.message_id;

    if (messageId) {
      try {
        await telegramCall('editMessageText', { chat_id: channelId, message_id: messageId, text, reply_markup: markup });
      } catch (error) {
        const message = String(error?.message || error);
        if (/message is not modified/i.test(message)) {
          await client.query('UPDATE mandatory_source_reports SET updated_at=NOW() WHERE source_id=$1 AND channel_chat_id=$2', [source.id, channelId]);
          return true;
        }
        if (!/message to edit not found|message_id_invalid|message can't be edited/i.test(message)) throw error;
        messageId = null;
      }
    }

    if (!messageId) {
      const sent = await telegramCall('sendMessage', { chat_id: channelId, text, protect_content: true, reply_markup: markup });
      messageId = sent.message_id;
    }
    await client.query(
      `INSERT INTO mandatory_source_reports(source_id,channel_chat_id,message_id,updated_at)
       VALUES ($1,$2,$3,NOW())
       ON CONFLICT (source_id,channel_chat_id) DO UPDATE SET message_id=EXCLUDED.message_id,updated_at=NOW()`,
      [source.id, channelId, messageId]
    );
    return true;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1::bigint)', [sourceId]);
  }
}

export async function syncPendingMandatoryReports(client, telegramCall, limit = 10) {
  const configured = await client.query("SELECT value FROM bot_settings WHERE key='mandatory_report_channel_id' AND value <> ''");
  const channelId = configured.rows[0]?.value;
  if (!channelId) return 0;
  const pending = await client.query(
    `SELECT ms.id FROM mandatory_sources ms
     LEFT JOIN mandatory_source_reports r ON r.source_id=ms.id AND r.channel_chat_id=$1
     WHERE r.source_id IS NULL OR r.updated_at < ms.updated_at
     ORDER BY ms.updated_at,ms.id LIMIT $2`,
    [channelId, limit]
  );
  let updated = 0;
  for (const row of pending.rows) {
    try { if (await syncMandatoryReport(client, row.id, telegramCall)) updated++; }
    catch (error) { console.error('mandatory_report_sync_error', row.id, String(error?.message || error).slice(0, 200)); }
  }
  return updated;
}

async function promoteNextQueuedSource(client) {
  const active = await client.query("SELECT 1 FROM mandatory_sources WHERE status IN ('active','paused') LIMIT 1");
  if (active.rowCount) return null;
  const next = await client.query(
    `SELECT q.id AS queue_id,q.position,s.* FROM mandatory_source_queue q
     JOIN mandatory_sources s ON s.id=q.source_id
     WHERE s.status='scheduled' AND s.starts_at IS NULL
     ORDER BY q.position,q.id LIMIT 1 FOR UPDATE OF q,s SKIP LOCKED`
  );
  if (!next.rows[0]) return null;
  const queued = next.rows[0];
  const updated = await client.query(
    "UPDATE mandatory_sources SET status='active',started_at=COALESCE(started_at,NOW()),updated_at=NOW() WHERE id=$1 AND status='scheduled' RETURNING *",
    [queued.id]
  );
  await client.query('DELETE FROM mandatory_source_queue WHERE id=$1', [queued.queue_id]);
  const source = updated.rows[0];
  if (source) await recordMandatorySourceHistory(client, source, 'started', { fromStatus: 'queued', toStatus: 'active', details: { queue_position: queued.position, note: 'نوبت منبع در صف رسید.' }, notifyAdmin: true });
  return source || null;
}

export async function processMandatoryLifecycle(client, { telegramCall, sendAdmin, backfillLimit = 0, changedReportLimit = Infinity } = {}) {
  const changed = [];
  let started = 0;
  let completed = 0;
  let promoted = 0;
  await client.query('BEGIN');
  try {
    await client.query('SELECT pg_advisory_xact_lock(83742519::bigint)');
    const due = await client.query(
      `UPDATE mandatory_sources SET status='active',started_at=COALESCE(started_at,NOW()),updated_at=NOW()
       WHERE status='scheduled' AND starts_at IS NOT NULL AND starts_at <= NOW() RETURNING *`
    );
    for (const source of due.rows) {
      await recordMandatorySourceHistory(client, source, 'started', { fromStatus: 'scheduled', toStatus: 'active', details: { note: 'زمان‌بندی به زمان شروع رسید.' }, notifyAdmin: true });
      changed.push(source); started++;
    }

    const ended = await client.query(
      `UPDATE mandatory_sources ms SET status='completed',updated_at=NOW()
       WHERE ms.status='active' AND (
         (ms.mode='time' AND ms.duration_seconds IS NOT NULL AND COALESCE(ms.started_at,ms.created_at) + (ms.duration_seconds * INTERVAL '1 second') <= NOW())
         OR (ms.mode='count' AND ms.quota IS NOT NULL AND (SELECT COUNT(*) FROM mandatory_source_events e WHERE e.source_id=ms.id AND e.event_type='join') >= ms.quota)
         OR (ms.mode='start' AND ms.quota IS NOT NULL AND (SELECT COUNT(*) FROM mandatory_source_events e WHERE e.source_id=ms.id AND e.event_type='start') >= ms.quota)
         OR (ms.mode='click' AND ms.quota IS NOT NULL AND (SELECT COUNT(*) FROM mandatory_source_events e WHERE e.source_id=ms.id AND e.event_type='click') >= ms.quota)
       ) RETURNING ms.*`
    );
    for (const source of ended.rows) {
      await recordMandatorySourceHistory(client, source, 'completed', { fromStatus: 'active', toStatus: 'completed', details: { note: 'شرط تکمیل منبع انجام شد.' } });
      changed.push(source); completed++;
    }

    const next = await promoteNextQueuedSource(client);
    if (next) { changed.push(next); started++; promoted++; }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }

  if (telegramCall) {
    const sourcesToSync = Number.isFinite(changedReportLimit) ? changed.slice(0, changedReportLimit) : changed;
    for (const source of sourcesToSync) {
      try { await syncMandatoryReport(client, source.id, telegramCall); }
      catch (error) { console.error('mandatory_report_sync_error', source.id, String(error?.message || error).slice(0, 200)); }
    }
    if (sendAdmin) {
      await client.query('SELECT pg_advisory_lock(83742518::bigint)');
      try {
        const pending = await client.query(
          `SELECT h.id AS history_id,h.notify_admin_id,s.id,s.tracking_code,s.title,s.status,s.source_type,s.mode FROM mandatory_source_history h
           JOIN mandatory_sources s ON s.id=h.source_id
           WHERE h.event_type='started' AND h.notified_at IS NULL AND h.notify_admin_id IS NOT NULL AND h.notification_attempts < 10
           ORDER BY h.id LIMIT 1`
        );
        for (const row of pending.rows) {
          try {
            await sendAdmin(row.notify_admin_id, `منبع «${row.title}» از الان ست شد.\nکد پیگیری: ${trackingCommand(row.tracking_code)}`, mandatorySourceKeyboard(row));
            await client.query('UPDATE mandatory_source_history SET notified_at=NOW(),notification_attempts=notification_attempts+1,last_notification_error=NULL WHERE id=$1 AND notified_at IS NULL', [row.history_id]);
          } catch (error) {
            await client.query('UPDATE mandatory_source_history SET notification_attempts=notification_attempts+1,last_notification_error=$2 WHERE id=$1 AND notified_at IS NULL', [row.history_id, String(error?.message || error).slice(0, 500)]);
            console.error('mandatory_start_notification_error', row.history_id, String(error?.message || error).slice(0, 200));
          }
        }
      } finally { await client.query('SELECT pg_advisory_unlock(83742518::bigint)'); }
    }
  }
  const reportsUpdated = telegramCall && backfillLimit > 0 && changed.length === 0 ? await syncPendingMandatoryReports(client, telegramCall, backfillLimit) : 0;
  return { started, completed, promoted, reportsUpdated };
}
