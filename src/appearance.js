const clone = value => JSON.parse(JSON.stringify(value));


const PUBLIC_SCREENS = {
  connect: { title: 'آماده‌ای؟', message: 'برای شروع، انتخابت را با دقت ثبت کن؛ ناشناس مناسب پیدا می‌شود.', buttons: [], feedback: {} },
  preference: { title: 'انتخاب ترجیح', message: 'دوست داری گفت‌وگو با چه کسی شکل بگیرد؟', buttons: [{ id: 'male', label: 'پسر' }, { id: 'female', label: 'دختر' }, { id: 'any', label: 'مهم نیست' }], feedback: {} },
  gender: { title: 'یک قدم کوچک', message: 'جنسیت خودت را انتخاب کن تا جفت‌سازی دوطرفه و منصفانه باشد.', buttons: [{ id: 'male', label: 'پسرم' }, { id: 'female', label: 'دخترم' }], feedback: {} },
  waiting: { title: 'در صف انتظار', message: 'چراغ جست‌وجو روشن است؛ به‌محض پیدا شدن گزینهٔ مناسب خبرت می‌کنیم.', buttons: [{ id: 'cancel', label: 'انصراف' }], feedback: {} },
  chat: { title: 'مکالمه برقرار است', message: 'یک سلام ساده می‌تواند شروع یک داستان خوب باشد.', buttons: [{ id: 'disconnect', label: 'قطع مکالمه' }], feedback: {} },
  confirm_stop: { title: 'پایان مکالمه؟', message: 'اگر گفت‌وگو را ببندی، این فرصت همین‌جا تمام می‌شود.', buttons: [{ id: 'confirm', label: 'اره مطمئنم' }, { id: 'continue', label: 'نه ادامه میدم' }], feedback: {} },
  after_stop: { title: 'حالا چه؟', message: 'می‌توانی دوباره وارد گفت‌وگو شوی یا این ارتباط را ببندی.', buttons: [{ id: 'block', label: 'بلاکش کن' }, { id: 'later', label: 'بعدا وصلش کن' }], feedback: {} },
  block_reason: { title: 'دلیل بلاک', message: 'یک دلیل را انتخاب کن تا گزارش داخلی دقیق‌تر بماند.', buttons: [{ id: 'rude', label: 'باهاش حال نکردم' }, { id: 'abusive', label: 'بی ادب بود' }, { id: 'wrong_gender', label: 'جنسیتش اشتباه بود' }, { id: 'advertising', label: 'تبلیغ فرستاد' }, { id: 'later', label: 'بذار بعدا هم وصل بشم' }], feedback: {} },
  profile: { title: 'پروفایل من', message: 'جزئیاتت را ببین و امضای ایموجی خودت را بساز.', buttons: [{ id: 'emoji', label: 'ظاهر ایموجی پلاس' }, { id: 'back', label: 'بازگشت' }], feedback: {} },
  emoji: { title: 'ظاهر ایموجی پلاس', message: 'امضای ایموجی خودت را انتخاب کن؛ این نشانه کنار پیام‌هایت دیده می‌شود.', buttons: [{ id: 'reset', label: 'ریست ایموجی' }, { id: 'back', label: 'بازگشت' }], feedback: {} },
  coins: { title: 'مانو کوین', message: 'هر کوین، یک قدم برای باز کردن امکانات بیشتر است.', buttons: [{ id: 'free_coins', label: 'افزایش مانو کوین رایگان' }, { id: 'back', label: 'بازگشت' }], feedback: {} },
  plus: { title: 'اکانت پلاس', message: 'یک تجربهٔ آرام‌تر، زیباتر و پرامکانات‌تر.', buttons: [{ id: 'back', label: 'بازگشت' }], feedback: {} },
  anonymous_link: { title: 'لینک ناشناس', message: 'لینک تو آمادهٔ یک گفت‌وگوی امن و ناشناس است.', buttons: [{ id: 'back', label: 'بازگشت' }], feedback: {} },
};
const PRIVATE_SCREENS = {
  reports: { title: 'گزارش‌ها', message: 'هر گزارش یک سیگنال است؛ آن را با دقت بررسی کن.', buttons: [], feedback: {} },
  technical: { title: 'بخش فنی مالک', message: 'ابزارهای پشتیبان‌گیری و مشاهدهٔ سلامت ربات.', buttons: [{ id: 'source', label: 'فایل اوپن سورس' }, { id: 'database', label: 'بک آپ دیتابیس' }, { id: 'server', label: 'وضعیت سرور' }, { id: 'back', label: 'بازگشت' }], feedback: {} },
  ads: { title: 'مدیریت تبلیغات', message: 'جریان توجه کاربران را با نظم مدیریت کن.', buttons: [], feedback: {} },
  control: { title: 'کنترل ربات', message: 'ظاهر و رفتار سطح کاربر را با حوصله تنظیم کن.', buttons: [], feedback: {} },
  appearance: { title: 'استودیو ظاهر', message: 'اینجا هر کلمه، فاصله و دکمه یک انتخاب طراحی است.', buttons: [{ id: 'templates', label: 'قالب‌های آماده' }, { id: 'edit', label: 'ویرایش لایه‌ها' }, { id: 'layout', label: 'چیدمان' }, { id: 'reset', label: 'بازگردانی پیش‌فرض' }, { id: 'back', label: 'بازگشت' }], feedback: {} },
  user_search: { title: 'کنترل کاربران', message: 'آیدی عددی کاربر را بفرست تا کارت وضعیت او ساخته شود.', buttons: [{ id: 'back', label: 'بازگشت' }], feedback: {} },
};
function styleScreens(screens, style) {
  const config = {
    luxury: { glyph: '✦', open: '╭────── ✦ ──────╮', close: '╰────── ✦ ──────╯' },
    halloween: { glyph: '🕯', open: '╭────── 🕸 ──────╮', close: '╰────── 🎃 ──────╯' },
    friendly: { glyph: '✧', open: '╭────── 👋 ──────╮', close: '╰────── 😊 ──────╯' },
  }[style];
  if (!config) return clone(screens);
  return Object.fromEntries(Object.entries(screens).map(([id, screen]) => [id, {
    ...clone(screen), title: `${config.glyph} ${screen.title}`,
    message: `${config.open}\n${screen.message}\n${config.close}`,
    buttons: (screen.buttons || []).map(item => ({ ...item, label: `${config.glyph} ${item.label}` })),
    feedback: Object.fromEntries(Object.entries(screen.feedback || {}).map(([key, value]) => [key, `${config.glyph} ${value}`])),
  }]));
}

const PUBLIC_BASE = {
  title: 'منوی اصلی',
  message: 'به چت ناشناس خوش آمدی.',
  layout: 'rows',
  screens: PUBLIC_SCREENS,
  buttons: [
    [{ id: 'connect', label: 'وصل کن به ناشناس' }, { id: 'anonymous_link', label: 'لینک ناشناس من' }],
    [{ id: 'profile', label: 'پروفایل من' }],
    [{ id: 'coins', label: 'افزایش مانو کوین' }, { id: 'plus', label: 'اکانت پلاس' }],
  ],
  feedback: {
    connect: 'برای اتصال، گزینه‌های جنسیت و ترجیح خودت را انتخاب کن.',
    connect_prompt: 'دوست داری به چه کسی وصل شوی؟',
    waiting: 'در صف انتظار قرار گرفتی؛ هنوز کسی با این انتخاب پیدا نشده است. به‌محض اتصال خبرت می‌دهم.',
    connected: 'اتصال برقرار شد؛ گفت‌وگو را شروع کن.',
    anonymous_link: 'لینک ناشناس خودت را مدیریت کن.',
    profile: 'پروفایل شما',
    coins: 'افزایش مانو کوین',
    plus: 'اکانت پلاس',
    back: 'بازگشت',
  },
};

const PRIVATE_BASE = {
  title: 'پنل مدیریت',
  message: 'مرکز کنترل ربات؛ یک بخش را انتخاب کن.',
  layout: 'rows',
  screens: PRIVATE_SCREENS,
  buttons: [
    [{ id: 'ads', label: 'تبلیغات' }, { id: 'control', label: 'کنترل ربات' }],
    [{ id: 'users', label: 'کنترل کاربران' }, { id: 'status', label: 'وضعیت ربات' }],
    [{ id: 'reports', label: 'گزارش‌ها' }, { id: 'admins', label: 'مدیران' }],
    [{ id: 'exit', label: 'خروج از پنل' }],
  ],
  feedback: {
    ads: 'مدیریت تبلیغات',
    control: 'کنترل ربات',
    users: 'آیدی عددی کاربر را بفرست.',
    status: 'وضعیت ربات',
    reports: 'گزارش‌ها',
    admins: 'مدیران فعلی',
    exit: 'از پنل مدیریت خارج شدی.',
    back: 'بازگشت پنل',
  },
};

export const APPEARANCE_SECTIONS = {
  public: { key: 'appearance_public', title: 'پابلیک', base: PUBLIC_BASE },
  private: { key: 'appearance_private', title: 'پرایویسی', base: PRIVATE_BASE },
};

export const APPEARANCE_TEMPLATES = {
  default: { name: 'پیش‌فرض فعلی', description: 'همان ظاهر فعلی ربات، بدون تغییر در منطق فنی.', public: PUBLIC_BASE, private: PRIVATE_BASE },
  luxury: {
    name: 'لوکس', description: 'لحن رسمی‌تر با قاب‌بندی و ایموجی‌های شیک.',
    public: { ...PUBLIC_BASE, screens: styleScreens(PUBLIC_SCREENS, 'luxury'), title: '✦ چت ناشناس لوکس ✦', message: '╭────── ✦ ──────╮\n  به فضای گفت‌وگوی لوکس خوش آمدی\n╰────── ✦ ──────╯', buttons: [[{ id: 'connect', label: '✦ شروع گفت‌وگوی ناشناس' }, { id: 'anonymous_link', label: '⌁ لینک اختصاصی من' }], [{ id: 'profile', label: '♕ پروفایل من' }], [{ id: 'coins', label: '◈ مانو کوین' }, { id: 'plus', label: '♛ اکانت پلاس' }]] },
    private: { ...PRIVATE_BASE, screens: styleScreens(PRIVATE_SCREENS, 'luxury'), title: '♛ کنسول مدیریت لوکس', message: '╭────── ♛ ──────╮\n  مرکز فرماندهی ربات\n╰────── ♛ ──────╯', buttons: [[{ id: 'ads', label: '◈ تبلیغات' }, { id: 'control', label: '⚙ کنترل ربات' }], [{ id: 'users', label: '♙ کاربران' }, { id: 'status', label: '◉ وضعیت ربات' }], [{ id: 'reports', label: '⚑ گزارش‌ها' }, { id: 'admins', label: '♛ مدیران' }], [{ id: 'exit', label: '↩ خروج از پنل' }]] },
  },
  halloween: {
    name: 'هالووینی', description: 'ظاهر سرگرم‌کنندهٔ نارنجی و مرموز، بدون تغییر زیرساخت.',
    public: { ...PUBLIC_BASE, screens: styleScreens(PUBLIC_SCREENS, 'halloween'), title: '🎃 کلبهٔ چت ناشناس 🎃', message: '🕯 شب بخیر! آماده‌ای با یک ناشناس مرموز آشنا شوی؟ 🕸', buttons: [[{ id: 'connect', label: '🦇 احضار یک ناشناس' }, { id: 'anonymous_link', label: '🕸 لینک من' }], [{ id: 'profile', label: '🧛 پروفایل' }], [{ id: 'coins', label: '🪙 مانو کوین' }, { id: 'plus', label: '🔮 اکانت پلاس' }]] },
    private: { ...PRIVATE_BASE, screens: styleScreens(PRIVATE_SCREENS, 'halloween'), title: '🎃 اتاق کنترل تاریک', message: '🕯 مدیر محترم، یک عملیات را انتخاب کن.', buttons: [[{ id: 'ads', label: '🕸 تبلیغات' }, { id: 'control', label: '🧪 کنترل ربات' }], [{ id: 'users', label: '🧛 کاربران' }, { id: 'status', label: '👁 وضعیت' }], [{ id: 'reports', label: '⚰ گزارش‌ها' }, { id: 'admins', label: '🧙 مدیران' }], [{ id: 'exit', label: '🚪 خروج' }]] },
  },
  friendly: {
    name: 'فرندلی', description: 'لحن گرم و ساده برای استفادهٔ روزمره.',
    public: { ...PUBLIC_BASE, screens: styleScreens(PUBLIC_SCREENS, 'friendly'), title: 'سلام رفیق! 👋', message: 'خوش اومدی! از دکمه‌های زیر هر چیزی خواستی انتخاب کن 😊', buttons: [[{ id: 'connect', label: '😊 پیدا کردن یک دوست' }, { id: 'anonymous_link', label: '🔗 لینک من' }], [{ id: 'profile', label: '🙋 پروفایل من' }], [{ id: 'coins', label: '🪙 سکه‌هام' }, { id: 'plus', label: '⭐ امکانات پلاس' }]] },
    private: { ...PRIVATE_BASE, screens: styleScreens(PRIVATE_SCREENS, 'friendly'), title: '👋 پنل مدیریت دوستانه', message: 'همه‌چیز آماده است؛ یک گزینه را انتخاب کن.', buttons: [[{ id: 'ads', label: '📣 تبلیغات' }, { id: 'control', label: '🛠 کنترل ربات' }], [{ id: 'users', label: '👥 کاربران' }, { id: 'status', label: '📊 وضعیت ربات' }], [{ id: 'reports', label: '📝 گزارش‌ها' }, { id: 'admins', label: '👑 مدیران' }], [{ id: 'exit', label: '👋 خروج' }]] },
  },
};

function merge(base, value) {
  if (Array.isArray(base)) return Array.isArray(value) ? value : clone(base);
  if (base && typeof base === 'object') {
    const out = {};
    for (const key of Object.keys(base)) out[key] = merge(base[key], value?.[key]);
    for (const [key, item] of Object.entries(value || {})) if (!(key in out)) out[key] = item;
    return out;
  }
  return value === undefined ? base : value;
}

export function normalizeAppearance(section, value) {
  const definition = APPEARANCE_SECTIONS[section] || APPEARANCE_SECTIONS.public;
  try { return merge(definition.base, typeof value === 'string' ? JSON.parse(value) : (value || {})); } catch { return clone(definition.base); }
}
export function templateAppearance(templateId, section) { const template = APPEARANCE_TEMPLATES[templateId] || APPEARANCE_TEMPLATES.default; return normalizeAppearance(section, template[section]); }
export function appearanceKeyboard(appearance) {
  const rows = Array.isArray(appearance?.buttons) ? appearance.buttons : [];
  const labels = rows.flat().map(button => String(button.label || button.id || '').slice(0, 64)).filter(Boolean);
  if (appearance?.layout === 'single') return labels.map(label => [label]);
  if (appearance?.layout === 'columns2') { const result = []; for (let i = 0; i < labels.length; i += 2) result.push(labels.slice(i, i + 2)); return result; }
  return rows.map(row => row.map(button => String(button.label || button.id || '').slice(0, 64)).filter(Boolean)).filter(row => row.length);
}
export function appearanceScreen(appearance, id) { return appearance?.screens?.[id] || {}; }
export function screenText(appearance, id, fallback) { return String(appearanceScreen(appearance, id).message || fallback); }
export function screenKeyboard(appearance, id, fallbackRows = []) { const screen = appearanceScreen(appearance, id); return (screen.buttons?.length ? [screen.buttons.map(item => item.label || item.id)] : fallbackRows); }
export function appearanceButton(appearance, id, fallback) { for (const row of appearance?.buttons || []) for (const item of row || []) if (item.id === id) return item.label || fallback; return fallback; }
export function appearanceFeedback(appearance, id, fallback) { return String(appearance?.feedback?.[id] || fallback); }
export function appearanceItems(section, appearance) {
  const items = [{ path: 'title', label: 'عنوان منو', value: appearance.title }, { path: 'message', label: 'متن منو', value: appearance.message }, { path: 'layout', label: 'نوع چیدمان', value: appearance.layout }];
  for (const [screenId, screen] of Object.entries(appearance.screens || {})) {
    items.push({ path: `screens.${screenId}.title`, label: `عنوان صفحه ${screenId}`, value: screen.title });
    items.push({ path: `screens.${screenId}.message`, label: `متن صفحه ${screenId}`, value: screen.message });
    for (const [index, item] of (screen.buttons || []).entries()) items.push({ path: `screens.${screenId}.buttons.${index}.label`, label: `دکمه ${screenId} ${item.id}`, value: item.label });
    for (const [key, value] of Object.entries(screen.feedback || {})) items.push({ path: `screens.${screenId}.feedback.${key}`, label: `پاسخ داخلی ${screenId} ${key}`, value });
  }
  for (const [rowIndex, row] of (appearance.buttons || []).entries()) for (const [colIndex, button] of (row || []).entries()) items.push({ path: `buttons.${rowIndex}.${colIndex}.label`, label: `نام دکمه ${button.id}`, value: button.label });
  for (const [id, value] of Object.entries(appearance.feedback || {})) items.push({ path: `feedback.${id}`, label: `پاسخ ${id}`, value });
  return items;
}
export function setAppearancePath(appearance, path, value) { const out = clone(appearance); const parts = path.split('.'); let current = out; for (let i = 0; i < parts.length - 1; i += 1) current = current[parts[i]]; current[parts.at(-1)] = value; return out; }
export function templateListText() { return Object.entries(APPEARANCE_TEMPLATES).map(([id, item], index) => `${index + 1}. ${item.name} — ${item.description} (${id})`).join('\n'); }
export function templateIdFromText(value) { const text = String(value || '').trim().toLowerCase(); const entries = Object.entries(APPEARANCE_TEMPLATES); const numeric = Number(text); if (Number.isInteger(numeric) && numeric >= 1 && numeric <= entries.length) return entries[numeric - 1][0]; return entries.find(([id, item]) => id === text || item.name === value.trim())?.[0] || null; }
