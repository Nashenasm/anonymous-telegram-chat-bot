export const BROADCAST_AUDIENCE_KEYS = ['regular_male', 'regular_female', 'plus_male', 'plus_female'];
export const BROADCAST_SCOPE_KEYS = ['online', 'recent', 'all'];

export const DEFAULT_BROADCAST_AUDIENCE = {
  regular_male: false,
  regular_female: false,
  plus_male: false,
  plus_female: false,
  scope: null,
};

export function normalizeBroadcastAudience(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    regular_male: source.regular_male === true,
    regular_female: source.regular_female === true,
    plus_male: source.plus_male === true,
    plus_female: source.plus_female === true,
    scope: BROADCAST_SCOPE_KEYS.includes(source.scope) ? source.scope : null,
  };
}

export function broadcastAudienceLabel(audience) {
  const a = normalizeBroadcastAudience(audience);
  const labels = {
    regular_male: 'کاربران معمولی پسر',
    regular_female: 'کاربران معمولی دختر',
    plus_male: 'کاربران پلاس پسر',
    plus_female: 'کاربران پلاس دختر',
  };
  const selected = BROADCAST_AUDIENCE_KEYS.filter(key => a[key]).map(key => labels[key]);
  if (a.scope === 'online') selected.push('فقط آنلاین‌ها');
  if (a.scope === 'recent') selected.push('کاربران جدید ۴۸ ساعت اخیر');
  if (a.scope === 'all') selected.push('تمامی کاربران');
  return selected.join('، ') || 'بدون مخاطب';
}

export async function ensureBroadcastSchema(client) {
  await client.query(`CREATE TABLE IF NOT EXISTS broadcast_campaigns (
    id BIGSERIAL PRIMARY KEY,
    created_by BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE RESTRICT,
    source_chat_id BIGINT NOT NULL,
    source_message_id BIGINT NOT NULL,
    message_kind TEXT NOT NULL DEFAULT 'unknown',
    audience JSONB NOT NULL DEFAULT '{}'::jsonb,
    scheduled_at TIMESTAMPTZ,
    delete_after_seconds INTEGER,
    target_limit INTEGER,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','scheduled','running','completed','cancelled','deleting','deleted','failed')),
    saved BOOLEAN NOT NULL DEFAULT FALSE,
    report_channel_id TEXT,
    report_message_id BIGINT,
    admin_message_id BIGINT,
    total_targets INTEGER NOT NULL DEFAULT 0,
    sent_count INTEGER NOT NULL DEFAULT 0,
    failed_count INTEGER NOT NULL DEFAULT 0,
    deleted_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await client.query(`CREATE TABLE IF NOT EXISTS broadcast_deliveries (
    campaign_id BIGINT NOT NULL REFERENCES broadcast_campaigns(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
    message_id BIGINT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','deleted')),
    error_text TEXT,
    sent_at TIMESTAMPTZ,
    deleted_at TIMESTAMPTZ,
    PRIMARY KEY (campaign_id, user_id)
  )`);
  await client.query(`CREATE TABLE IF NOT EXISTS broadcast_templates (
    id BIGSERIAL PRIMARY KEY,
    owner_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    campaign_id BIGINT NOT NULL REFERENCES broadcast_campaigns(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await client.query('ALTER TABLE broadcast_campaigns ADD COLUMN IF NOT EXISTS admin_chat_id BIGINT');
  await client.query('CREATE INDEX IF NOT EXISTS broadcast_campaigns_schedule_idx ON broadcast_campaigns(status, scheduled_at)');
  await client.query('CREATE INDEX IF NOT EXISTS broadcast_deliveries_status_idx ON broadcast_deliveries(campaign_id, status)');
}

export function broadcastMessageKind(message = {}) {
  if (message.text) return 'text';
  if (message.photo) return 'photo';
  if (message.video) return 'video';
  if (message.animation) return 'animation';
  if (message.document) return 'document';
  if (message.audio) return 'audio';
  if (message.voice) return 'voice';
  if (message.sticker) return 'sticker';
  if (message.video_note) return 'video_note';
  if (message.location) return 'location';
  if (message.contact) return 'contact';
  if (message.poll) return 'poll';
  return 'unknown';
}

export async function broadcastStats(client) {
  const result = await client.query(`SELECT
    COUNT(*)::int AS total,
    COUNT(*) FILTER (WHERE status IN ('waiting','chatting'))::int AS online,
    COUNT(*) FILTER (WHERE banned_until IS NOT NULL AND banned_until > NOW())::int AS blocked,
    COUNT(*) FILTER (WHERE gender='male' AND COALESCE(plus_expires_at,NOW()-INTERVAL '1 second') <= NOW())::int AS regular_male,
    COUNT(*) FILTER (WHERE gender='female' AND COALESCE(plus_expires_at,NOW()-INTERVAL '1 second') <= NOW())::int AS regular_female,
    COUNT(*) FILTER (WHERE gender='male' AND plus_expires_at > NOW())::int AS plus_male,
    COUNT(*) FILTER (WHERE gender='female' AND plus_expires_at > NOW())::int AS plus_female,
    COUNT(*) FILTER (WHERE gender='male' AND COALESCE(plus_expires_at,NOW()-INTERVAL '1 second') <= NOW() AND status IN ('waiting','chatting'))::int AS regular_male_online,
    COUNT(*) FILTER (WHERE gender='female' AND COALESCE(plus_expires_at,NOW()-INTERVAL '1 second') <= NOW() AND status IN ('waiting','chatting'))::int AS regular_female_online,
    COUNT(*) FILTER (WHERE gender='male' AND plus_expires_at > NOW() AND status IN ('waiting','chatting'))::int AS plus_male_online,
    COUNT(*) FILTER (WHERE gender='female' AND plus_expires_at > NOW() AND status IN ('waiting','chatting'))::int AS plus_female_online,
    COUNT(*) FILTER (WHERE created_at >= NOW()-INTERVAL '48 hours')::int AS recent
    FROM users`);
  return result.rows[0];
}

export function broadcastStatsText(stats) {
  const s = stats || {};
  const line = (label, total, online) => `${label}: ${Number(total || 0)} (${Number(online || 0)}🟢)`;
  return `وضعیت ربات\n\nتعداد کل کاربران ربات: ${Number(s.total || 0)}\nتعداد کل کاربران آنلاین: ${Number(s.online || 0)}\nتعداد بلاک بات: ${Number(s.blocked || 0)}\n\n${line('کاربر معمولی (دختر)', s.regular_female, s.regular_female_online)}\n${line('کاربر معمولی (پسر)', s.regular_male, s.regular_male_online)}\n${line('کاربر پلاس (دختر)', s.plus_female, s.plus_female_online)}\n${line('کاربر پلاس (پسر)', s.plus_male, s.plus_male_online)}\n\nکاربران جدید در ۴۸ ساعت اخیر: ${Number(s.recent || 0)}`;
}

export function broadcastTargetWhere(audience = {}) {
  const a = normalizeBroadcastAudience(audience);
  const segments = [];
  if (a.regular_male) segments.push("(gender='male' AND COALESCE(plus_expires_at,NOW()-INTERVAL '1 second') <= NOW())");
  if (a.regular_female) segments.push("(gender='female' AND COALESCE(plus_expires_at,NOW()-INTERVAL '1 second') <= NOW())");
  if (a.plus_male) segments.push("(gender='male' AND plus_expires_at > NOW())");
  if (a.plus_female) segments.push("(gender='female' AND plus_expires_at > NOW())");
  if (!segments.length) return 'FALSE';
  const base = `(${segments.join(' OR ')})`;
  if (a.scope === 'online') return `${base} AND status IN ('waiting','chatting')`;
  if (a.scope === 'recent') return `${base} AND created_at >= NOW()-INTERVAL '48 hours'`;
  return base;
}

export async function broadcastTargetCount(client, audience) {
  const where = broadcastTargetWhere(audience);
  const result = await client.query(`SELECT COUNT(*)::int AS count FROM users WHERE ${where}`);
  return Number(result.rows[0]?.count || 0);
}

export async function prepareBroadcastTargets(client, campaignId, audience, limit = null) {
  const where = broadcastTargetWhere(audience);
  const limited = Number.isInteger(limit) && limit > 0;
  const params = limited ? [campaignId, limit] : [campaignId];
  const selection = limited
    ? `SELECT telegram_id FROM users WHERE ${where} ORDER BY telegram_id LIMIT $2`
    : `SELECT telegram_id FROM users WHERE ${where} ORDER BY telegram_id`;
  await client.query(`INSERT INTO broadcast_deliveries(campaign_id,user_id)
    SELECT $1,telegram_id FROM (${selection}) AS targets
    ON CONFLICT (campaign_id,user_id) DO NOTHING`, params);
  const count = await client.query('SELECT COUNT(*)::int AS count FROM broadcast_deliveries WHERE campaign_id=$1', [campaignId]);
  return Number(count.rows[0]?.count || 0);
}

export async function copyBroadcastMessage(telegramCall, campaign, userId) {
  return telegramCall('copyMessage', {
    chat_id: userId,
    from_chat_id: campaign.source_chat_id,
    message_id: campaign.source_message_id,
    protect_content: true,
  });
}

function iranDate(value) { return new Intl.DateTimeFormat('fa-IR', { timeZone: 'Asia/Tehran', dateStyle: 'short', timeStyle: 'short', hourCycle: 'h23', hour12: false }).format(new Date(value)); }

function broadcastStatusLabel(status) {
  return ({ draft: 'پیش‌نویس', scheduled: 'زمان‌بندی‌شده', running: 'در حال ارسال', completed: 'تکمیل‌شده', cancelled: 'لغوشده', deleting: 'در حال حذف', deleted: 'حذف‌شده', failed: 'ناموفق' }[status] || status || 'نامشخص');
}
function broadcastReportKeyboard(row) {
  const id = row.id;
  if (row.status === 'scheduled') return { inline_keyboard: [[{ text: 'ارسال الان | Send NOW‼️', callback_data: `broadcast:report:send_now:${id}` }], [{ text: 'کنسل | Cancel⭕️', callback_data: `broadcast:report:cancel:${id}` }]] };
  if (row.status === 'running') return { inline_keyboard: [[{ text: 'کنسل | Cancel⭕️', callback_data: `broadcast:report:cancel:${id}` }]] };
  if (row.status === 'deleting') return { inline_keyboard: [[{ text: 'در حال حذف...', callback_data: `broadcast:report:noop:${id}` }]] };
  if (row.status === 'deleted') return { inline_keyboard: [[{ text: 'ارسال دوباره | Again♻️', callback_data: `broadcast:report:resend:${id}` }], [{ text: row.saved ? 'برداشتن ذخیره | Unsaved☑️' : 'ذخیره | Save✅', callback_data: `broadcast:report:${row.saved ? 'unsave' : 'save'}:${id}` }]] };
  if (row.status === 'completed' || row.status === 'failed' || row.status === 'cancelled') return { inline_keyboard: [[{ text: 'حذف پیام | Delete❌', callback_data: `broadcast:report:delete:${id}` }, { text: 'ارسال دوباره | Again♻️', callback_data: `broadcast:report:resend:${id}` }], [{ text: row.saved ? 'برداشتن ذخیره | Unsaved☑️' : 'ذخیره | Save✅', callback_data: `broadcast:report:${row.saved ? 'unsave' : 'save'}:${id}` }]] };
  return { inline_keyboard: [] };
}

export function broadcastProgressText(campaign, extra = '') {
  const total = Number(campaign.total_targets || 0);
  const sent = Number(campaign.sent_count || 0);
  const failed = Number(campaign.failed_count || 0);
  return `📢 وضعیت ارسال پیام همگانی\n\nوضعیت: ${broadcastStatusLabel(campaign.status)}\nکاربران کل (ALL): ${total}\nارسال موفق🟢: ${sent}/${total}\nارسال ناموفق🔴: ${failed}/${total}\nسرعت/آخرین بروزرسانی: ${iranDate(campaign.updated_at || new Date())}\n${extra}`.trim();
}
async function publishBroadcastReport(client, telegramCall, campaignId) {
  const row = (await client.query('SELECT * FROM broadcast_campaigns WHERE id=$1', [campaignId])).rows[0];
  if (!row) return;
  const counts = (await client.query(`SELECT
    COUNT(*)::int AS total,
    COUNT(*) FILTER (WHERE d.status='sent')::int AS sent,
    COUNT(*) FILTER (WHERE d.status='failed')::int AS failed,
    COUNT(*) FILTER (WHERE d.status='pending')::int AS pending,
    COUNT(*) FILTER (WHERE d.status='deleted')::int AS deleted,
    COUNT(*) FILTER (WHERE u.gender='male' AND u.plus_expires_at > NOW())::int AS plus_male,
    COUNT(*) FILTER (WHERE u.gender='male' AND u.plus_expires_at > NOW() AND d.status='sent')::int AS plus_male_sent,
    COUNT(*) FILTER (WHERE u.gender='female' AND u.plus_expires_at > NOW())::int AS plus_female,
    COUNT(*) FILTER (WHERE u.gender='female' AND u.plus_expires_at > NOW() AND d.status='sent')::int AS plus_female_sent,
    COUNT(*) FILTER (WHERE u.gender='male' AND COALESCE(u.plus_expires_at,NOW()-INTERVAL '1 second') <= NOW())::int AS regular_male,
    COUNT(*) FILTER (WHERE u.gender='male' AND COALESCE(u.plus_expires_at,NOW()-INTERVAL '1 second') <= NOW() AND d.status='sent')::int AS regular_male_sent,
    COUNT(*) FILTER (WHERE u.gender='female' AND COALESCE(u.plus_expires_at,NOW()-INTERVAL '1 second') <= NOW())::int AS regular_female,
    COUNT(*) FILTER (WHERE u.gender='female' AND COALESCE(u.plus_expires_at,NOW()-INTERVAL '1 second') <= NOW() AND d.status='sent')::int AS regular_female_sent,
    COUNT(*) FILTER (WHERE u.created_at >= NOW()-INTERVAL '48 hours')::int AS recent,
    COUNT(*) FILTER (WHERE u.created_at >= NOW()-INTERVAL '48 hours' AND d.status='sent')::int AS recent_sent,
    COUNT(*) FILTER (WHERE u.status IN ('waiting','chatting'))::int AS online,
    COUNT(*) FILTER (WHERE u.status IN ('waiting','chatting') AND d.status='sent')::int AS online_sent,
    COUNT(*) FILTER (WHERE u.status NOT IN ('waiting','chatting'))::int AS offline,
    COUNT(*) FILTER (WHERE u.status NOT IN ('waiting','chatting') AND d.status='sent')::int AS offline_sent,
    COUNT(*) FILTER (WHERE u.banned_until IS NOT NULL AND u.banned_until > NOW())::int AS blocked
    FROM broadcast_deliveries d JOIN users u ON u.telegram_id=d.user_id WHERE d.campaign_id=$1`, [row.id])).rows[0] || {};
  const pair = (sent, total) => `${Number(sent || 0)}/${Number(total || 0)}`;
  const elapsedSeconds = Math.max(1, (Date.now() - new Date(row.started_at || row.created_at || Date.now()).getTime()) / 1000);
  const speed = `${(Number(counts.sent || 0) / elapsedSeconds).toFixed(2)} پیام/ثانیه`;
  const details = `کاربران پلاس(پسر): ${pair(counts.plus_male_sent, counts.plus_male)}\nکاربران پلاس(دختر): ${pair(counts.plus_female_sent, counts.plus_female)}\nکاربران معمولی(پسر): ${pair(counts.regular_male_sent, counts.regular_male)}\nکاربران معمولی(دختر): ${pair(counts.regular_female_sent, counts.regular_female)}\nکاربران جدید(48h): ${pair(counts.recent_sent, counts.recent)}\nکاربران آنلاین(ON): ${pair(counts.online_sent, counts.online)}\nکاربران آفلاین(OFF): ${pair(counts.offline_sent, counts.offline)}\nکاربران بلاک ربات(BLOCK): ${Number(counts.blocked || 0)}\nکاربران کل(ALL): ${pair(counts.sent, counts.total)}\n\nمیزان ارسال موفق🟢: ${pair(counts.sent, counts.total)}\nمیزان ارسال ناموفق🔴: ${Number(counts.failed || 0)}/${Number(counts.total || 0)}\nسرعت ارسال: ${speed}\nمیزان مشاهده: قابل اندازه‌گیری توسط Bot API تلگرام نیست\nدر انتظار: ${Number(counts.pending || 0)} | حذف‌شده: ${Number(counts.deleted || 0)}\nزمان ایران: ${iranDate(row.finished_at || row.updated_at)}`;
  const text = broadcastProgressText({ ...row, total_targets: counts.total || row.total_targets, sent_count: counts.sent, failed_count: counts.failed }, details);
  const markup = broadcastReportKeyboard(row);
  try {
    if (row.report_channel_id) {
      if (row.report_message_id) await telegramCall('editMessageText', { chat_id: row.report_channel_id, message_id: row.report_message_id, text, reply_markup: markup });
      else {
        const sent = await telegramCall('sendMessage', { chat_id: row.report_channel_id, text, reply_markup: markup, protect_content: true });
        await client.query('UPDATE broadcast_campaigns SET report_message_id=$2,updated_at=NOW() WHERE id=$1', [row.id, sent.message_id]);
      }
    }
    if (row.admin_chat_id && row.admin_message_id) {
      await telegramCall('editMessageText', { chat_id: row.admin_chat_id, message_id: row.admin_message_id, text, reply_markup: markup });
    }
  } catch (error) { if (!/message is not modified/i.test(String(error?.message || error))) console.error('broadcast_report_error', String(error?.message || error).slice(0, 300)); }
}

export async function runBroadcastJobs({ pool, telegramCall, sendAdmin, batchSize = 100 } = {}) {
  const client = await pool.connect();
  const result = { started: 0, sent: 0, failed: 0, deleted: 0, completed: 0 };
  try {
    await ensureBroadcastSchema(client);
    const waitingReports = await client.query(`SELECT id FROM broadcast_campaigns WHERE report_channel_id IS NOT NULL AND status IN ('scheduled','running','cancelled','completed','deleting','deleted') ORDER BY updated_at DESC,id DESC LIMIT 50`);
    for (const report of waitingReports.rows) await publishBroadcastReport(client, telegramCall, report.id);
    const due = await client.query(`SELECT * FROM broadcast_campaigns WHERE status='scheduled' AND scheduled_at <= NOW() ORDER BY scheduled_at,id LIMIT 10`);
    for (const row of due.rows) {
      await client.query("UPDATE broadcast_campaigns SET status='running',started_at=COALESCE(started_at,NOW()),updated_at=NOW() WHERE id=$1 AND status='scheduled'", [row.id]);
      result.started += 1;
    }
    const running = await client.query("SELECT * FROM broadcast_campaigns WHERE status='running' ORDER BY id LIMIT 10");
    for (const campaign of running.rows) {
      const pending = await client.query('SELECT * FROM broadcast_deliveries WHERE campaign_id=$1 AND status=\'pending\' ORDER BY user_id LIMIT $2', [campaign.id, batchSize]);
      for (const target of pending.rows) {
        try {
          const sent = await copyBroadcastMessage(telegramCall, campaign, target.user_id);
          await client.query("UPDATE broadcast_deliveries SET status='sent',message_id=$3,sent_at=NOW() WHERE campaign_id=$1 AND user_id=$2", [campaign.id, target.user_id, sent.message_id]);
          await client.query('UPDATE broadcast_campaigns SET sent_count=sent_count+1,updated_at=NOW() WHERE id=$1', [campaign.id]);
          result.sent += 1;
        } catch (error) {
          await client.query("UPDATE broadcast_deliveries SET status='failed',error_text=$3 WHERE campaign_id=$1 AND user_id=$2", [campaign.id, target.user_id, String(error?.message || error).slice(0, 500)]);
          await client.query('UPDATE broadcast_campaigns SET failed_count=failed_count+1,updated_at=NOW() WHERE id=$1', [campaign.id]);
          result.failed += 1;
        }
      }
      await publishBroadcastReport(client, telegramCall, campaign.id);
      const left = await client.query("SELECT COUNT(*)::int AS count FROM broadcast_deliveries WHERE campaign_id=$1 AND status='pending'", [campaign.id]);
      if (!Number(left.rows[0]?.count)) {
        await client.query("UPDATE broadcast_campaigns SET status='completed',finished_at=NOW(),updated_at=NOW() WHERE id=$1", [campaign.id]);
        await publishBroadcastReport(client, telegramCall, campaign.id);
        result.completed += 1;
      }
    }
    const deletable = await client.query(`SELECT * FROM broadcast_campaigns
      WHERE (status='deleting' OR (status='completed' AND delete_after_seconds IS NOT NULL AND finished_at IS NOT NULL AND finished_at <= NOW() - (delete_after_seconds * INTERVAL '1 second')))
      ORDER BY finished_at LIMIT 10`);
    for (const campaign of deletable.rows) {
      await client.query("UPDATE broadcast_campaigns SET status='deleting',updated_at=NOW() WHERE id=$1 AND status IN ('completed','deleting')", [campaign.id]);
      const delivered = await client.query("SELECT user_id,message_id FROM broadcast_deliveries WHERE campaign_id=$1 AND status='sent' AND message_id IS NOT NULL LIMIT 500", [campaign.id]);
      let deletedForCampaign = 0;
      for (const row of delivered.rows) {
        try { await telegramCall('deleteMessage', { chat_id: row.user_id, message_id: row.message_id }); await client.query("UPDATE broadcast_deliveries SET status='deleted',deleted_at=NOW() WHERE campaign_id=$1 AND user_id=$2", [campaign.id, row.user_id]); result.deleted += 1; deletedForCampaign += 1; }
        catch (error) { await client.query("UPDATE broadcast_deliveries SET error_text=$3 WHERE campaign_id=$1 AND user_id=$2", [campaign.id, row.user_id, String(error?.message || error).slice(0, 500)]); }
      }
      const left = await client.query("SELECT COUNT(*)::int AS count FROM broadcast_deliveries WHERE campaign_id=$1 AND status='sent'", [campaign.id]);
      if (!Number(left.rows[0]?.count)) await client.query("UPDATE broadcast_campaigns SET status='deleted',deleted_count=$2,updated_at=NOW() WHERE id=$1", [campaign.id, result.deleted]);
    }
    return result;
  } finally { client.release(); }
}
