export const CHAT_PERMISSION_LABELS = {
  photo: 'عکس', gif: 'گیف', video: 'فیلم', text: 'متن', sticker: 'استیکر', emoji: 'ایموجی',
  telegram_link: 'لینک t.me', mention: 'تگ @', english: 'کلمات انگلیسی', profanity: 'الفاظ رکیک',
  voice: 'ویس', music: 'آهنگ', instagram_link: 'لینک اینستا', website_link: 'لینک سایت', app: 'اپلیکیشن',
  file: 'فایل', location: 'موقعیت مکانی', contact: 'مخاطب',
};
export const DEFAULT_CHAT_PERMISSIONS = Object.fromEntries(Object.keys(CHAT_PERMISSION_LABELS).map(k => [k, !['profanity'].includes(k)]));
export function parseDuration(value) {
  const m = String(value || '').trim().match(/^(\d+)\s*([SMH])$/i);
  if (!m || Number(m[1]) < 0) return null;
  return Number(m[1]) * ({ S: 1, M: 60, H: 3600 }[m[2].toUpperCase()]);
}
export function durationLabel(seconds) {
  const n = Number(seconds || 0);
  if (n % 3600 === 0) return `${n / 3600}H`;
  if (n % 60 === 0) return `${n / 60}M`;
  return `${n}S`;
}
export function permissionKeyboard(permissions = DEFAULT_CHAT_PERMISSIONS) {
  return Object.entries(CHAT_PERMISSION_LABELS).map(([key, label]) => ({ key, label: `${permissions[key] ? '✅' : '❌'} ${label}` }));
}
export function adminUserSummary(user, metrics = {}, extra = {}) {
  const plus = extra.isPlus ? 'پلاس' : 'معمولی';
  return [
    '👤 پنل مدیریت کاربر', '', `نام کاربری تلگرام: ${user.username ? '@' + user.username : 'ثبت نشده'}`,
    `آیدی عددی: ${user.telegram_id}`, `جنسیت: ${user.gender === 'male' ? 'مرد' : user.gender === 'female' ? 'زن' : 'نامشخص'}`,
    `نوع حساب: ${plus}`, `میزان کل خرید: ${extra.totalPurchase ?? 0}`, `زمان عضویت: ${extra.membershipTime || '-'}`,
    `مانو کوین فعلی: ${user.coins || 0}`, `مانو پلاس فعلی: ${extra.plusRemaining || 'ندارد'}`,
    `آخرین خرید: ${extra.lastPurchase || 'ندارد'}`, `مدت استفاده: ${durationLabel(metrics.total_chat_seconds || 0)}`,
    `تعداد روزهای فعال: ${metrics.active_days || 0}`, `آخرین فعالیت: ${extra.lastActivity || '-'}`,
    `تعداد چت‌ها: ${metrics.total_chats || 0}`, `طولانی‌ترین چت: ${durationLabel(metrics.longest_chat_seconds || 0)}`,
    `تعداد پیام‌ها: ${metrics.total_messages || 0}`, `چند نفر بلاک کرده: ${extra.blockedByUser ?? 0}`,
    `چند نفر اینو بلاک کردن: ${extra.blockedUser ?? 0}`, `وضعیت: ${user.banned_until ? 'بن‌شده' : user.status}`,
  ].join('\n');
}
