import { inlineButtonKey, normalizeInlineAppearance } from './inline-appearance.js';

const callback = (text, data, extra = {}) => ({ text, callback_data: data, ...extra });
const rowsKeyboard = rows => ({ reply_markup: { inline_keyboard: rows } });

export function inlineEditorGroups(config) {
  const normalized = normalizeInlineAppearance(config);
  const counts = new Map();
  for (const screen of Object.values(normalized.catalog.screens)) counts.set(screen.group, (counts.get(screen.group) || 0) + 1);
  return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b, 'fa')).map(([name, count]) => ({ name, count }));
}

export function inlineEditorRootKeyboard(config) {
  const groups = inlineEditorGroups(config);
  const rows = [];
  for (let i = 0; i < groups.length; i += 2) rows.push(groups.slice(i, i + 2).map((group, offset) => callback(`${group.name} (${group.count})`, `inlinecfg:group:${i + offset}`)));
  rows.push([callback('بازگشت', 'inlinecfg:back')]);
  return rowsKeyboard(rows);
}

export function inlineEditorGroupKeyboard(config, group, page = 0) {
  const normalized = normalizeInlineAppearance(config);
  const ids = Object.entries(normalized.catalog.screens).filter(([, screen]) => screen.group === group).map(([id]) => id).sort();
  const pageSize = 18;
  const start = Math.max(0, Number(page) || 0) * pageSize;
  const rows = ids.slice(start, start + pageSize).map((id, index) => {
    const screen = normalized.catalog.screens[id];
    const count = (screen.rows || []).flat().length;
    return [callback(`صفحه ${start + index + 1} · ${count} دکمه`, `inlinecfg:screen:${id}`)];
  });
  const nav = [];
  if (start > 0) nav.push(callback('صفحه قبل', `inlinecfg:group:${group}:page:${page - 1}`));
  if (start + pageSize < ids.length) nav.push(callback('صفحه بعد', `inlinecfg:group:${group}:page:${page + 1}`));
  if (nav.length) rows.push(nav);
  rows.push([callback('بازگشت', 'inlinecfg:root')]);
  return rowsKeyboard(rows);
}

export function inlineEditorScreenText(config, screenId, note = '') {
  const normalized = normalizeInlineAppearance(config);
  const screen = normalized.catalog.screens[screenId];
  if (!screen) return 'این صفحهٔ شیشه‌ای در فهرست پیدا نشد.';
  const settings = normalized.screens[screenId] || {};
  const layout = ({ single: 'تک‌ستونه', columns2: 'دو ستونه', columns3: 'سه‌ستونه', original: 'چیدمان اولیه' }[settings.layout] || 'چیدمان اولیه');
  const hasSourceText = /^[a-f0-9]{64}$/.test(screen.sourceTextSignature || '');
  const messageLine = screen.editableMessage && hasSourceText
    ? `متن صفحه: ${settings.message || 'متن پیش‌فرض ربات'}\n`
    : screen.editableMessage
      ? 'متن صفحه هنوز از پیام ربات ثبت نشده است؛ یک‌بار صفحه را در ربات باز کن.\n'
      : 'متن صفحه: به‌دلیل داشتن اطلاعات حساس/تراکنشی از این پنل قابل جایگزینی نیست.\n';
  return `${note ? `${note}\n\n` : ''}ویرایش دکمه‌های شیشه‌ای · ${screen.group}\nشناسه صفحه: ${screenId}\nچیدمان: ${layout}\n${messageLine}\nیکی از دکمه‌ها را برای ویرایش انتخاب کن.`;
}

export function inlineEditorScreenKeyboard(config, screenId, page = 0) {
  const normalized = normalizeInlineAppearance(config);
  const screen = normalized.catalog.screens[screenId];
  if (!screen) return inlineEditorRootKeyboard(config);
  const keys = inlineEditorOrder(normalized, screenId);
  const pageSize = 20;
  const start = Math.max(0, Number(page) || 0) * pageSize;
  const rows = keys.slice(start, start + pageSize).map((key, index) => {
    const item = normalized.catalog.buttons[key] || { label: key };
    const override = normalized.buttons[key] || {};
    const label = String(override.label || item.label || key).slice(0, 54);
    const status = override.enabled === false ? ' 🔴' : '';
    return [callback(`${start + index + 1}. ${label}${status}`, `inlinecfg:pick:${screenId}:${start + index}`)];
  });
  const nav = [];
  if (start > 0) nav.push(callback('صفحه قبل', `inlinecfg:screenpage:${screenId}:${page - 1}`));
  if (start + pageSize < keys.length) nav.push(callback('صفحه بعد', `inlinecfg:screenpage:${screenId}:${page + 1}`));
  if (nav.length) rows.push(nav);
  if (screen.editableMessage && /^[a-f0-9]{64}$/.test(screen.sourceTextSignature || '')) rows.push([callback('متن همین صفحه', `inlinecfg:screenmsg:${screenId}`)]);
  rows.push([callback('چیدمان صفحه', `inlinecfg:layout:${screenId}`)]);
  rows.push([callback('بازگشت', `inlinecfg:groupopen:${screen.group}`)]);
  return rowsKeyboard(rows);
}

export function inlineEditorButtonText(config, screenId, index, note = '') {
  const normalized = normalizeInlineAppearance(config);
  const screen = normalized.catalog.screens[screenId];
  const key = screen ? inlineEditorOrder(normalized, screenId)[Number(index)] : null;
  if (!key) return 'این دکمهٔ شیشه‌ای پیدا نشد.';
  const base = normalized.catalog.buttons[key] || { label: key };
  const item = normalized.buttons[key] || {};
  const style = ({ primary: 'آبی', success: 'سبز', danger: 'قرمز' }[item.style] || 'پیش‌فرض');
  return `${note ? `${note}\n\n` : ''}دکمه انتخاب‌شده: ${item.label || base.label || key}\nرنگ: ${style}\nایموجی پرمیوم: ${item.icon_custom_emoji_id ? 'تنظیم‌شده' : 'ندارد'}\nوضعیت: ${item.enabled === false ? 'خاموش' : 'روشن'}\nشناسهٔ عملکرد داخلی دست‌نخورده می‌ماند.`;
}

export function inlineEditorButtonKeyboard(config, screenId, index) {
  const normalized = normalizeInlineAppearance(config);
  const screen = normalized.catalog.screens[screenId];
  const key = screen ? inlineEditorOrder(normalized, screenId)[Number(index)] : null;
  if (!key) return inlineEditorScreenKeyboard(config, screenId);
  const current = normalized.buttons[key] || {};
  const status = current.enabled === false ? 'روشن‌کردن 🟢' : 'خاموش‌کردن 🔴';
  return rowsKeyboard([
    [callback('👆🏻', `inlinecfg:move:${screenId}:${index}:up`), callback('👇🏻', `inlinecfg:move:${screenId}:${index}:down`)],
    [callback('Name⭕️', `inlinecfg:name:${screenId}:${index}`), callback('Icon✨', `inlinecfg:icon:${screenId}:${index}`)],
    [callback('Style🎨', `inlinecfg:style:${screenId}:${index}`)],
    [callback(status, `inlinecfg:toggle:${screenId}:${index}`)],
    [callback('صفحه‌های هم‌گروه', `inlinecfg:nested:${screenId}:${index}`)],
    [callback('بازگشت', `inlinecfg:screen:${screenId}`)],
  ]);
}

export function inlineEditorStyleKeyboard(screenId, index) {
  return rowsKeyboard([
    [callback('پیش‌فرض', `inlinecfg:setstyle:${screenId}:${index}:default`)],
    [callback('آبی', `inlinecfg:setstyle:${screenId}:${index}:primary`, { style: 'primary' }), callback('سبز', `inlinecfg:setstyle:${screenId}:${index}:success`, { style: 'success' }), callback('قرمز', `inlinecfg:setstyle:${screenId}:${index}:danger`, { style: 'danger' })],
    [callback('بازگشت', `inlinecfg:pick:${screenId}:${index}`)],
  ]);
}

export function inlineEditorLayoutKeyboard(screenId) {
  return rowsKeyboard([
    [callback('چیدمان اصلی', `inlinecfg:setlayout:${screenId}:original`)],
    [callback('تک‌ستونه', `inlinecfg:setlayout:${screenId}:single`), callback('دو ستونه', `inlinecfg:setlayout:${screenId}:columns2`)],
    [callback('سه‌ستونه', `inlinecfg:setlayout:${screenId}:columns3`)],
    [callback('بازگشت', `inlinecfg:screen:${screenId}`)],
  ]);
}

export function inlineEditorNestedKeyboard(config, currentScreenId, index) {
  const normalized = normalizeInlineAppearance(config);
  const screen = normalized.catalog.screens[currentScreenId];
  const key = screen ? inlineEditorOrder(normalized, currentScreenId)[Number(index)] : null;
  const prefix = String(key || '').replace(/^callback:/, '').split(':')[0];
  const ids = Object.entries(normalized.catalog.screens).filter(([id, item]) => id !== currentScreenId && item.group === prefix).map(([id]) => id).sort();
  const rows = ids.slice(0, 30).map((id, i) => [callback(`صفحهٔ مرتبط ${i + 1} · ${(normalized.catalog.screens[id].rows || []).flat().length} دکمه`, `inlinecfg:screen:${id}`)]);
  if (!rows.length) rows.push([callback('هنوز صفحهٔ مرتبطی دیده نشده', `inlinecfg:pick:${currentScreenId}:${index}`)]);
  rows.push([callback('بازگشت', `inlinecfg:pick:${currentScreenId}:${index}`)]);
  return rowsKeyboard(rows);
}

export function inlineEditorGroupsForScreen(config, screenId) {
  const normalized = normalizeInlineAppearance(config);
  return normalized.catalog.screens[screenId]?.group || '';
}

export function inlineEditorOrder(config, screenId) {
  const normalized = normalizeInlineAppearance(config);
  const current = (normalized.catalog.screens[screenId]?.rows || []).flat();
  const saved = normalized.screens[screenId]?.order;
  if (!Array.isArray(saved) || !saved.length) return current;
  const present = new Set(current);
  return [...saved.filter(key => present.has(key)), ...current.filter(key => !saved.includes(key))];
}

export function inlineEditorButtonKey(config, screenId, index) {
  const normalized = normalizeInlineAppearance(config);
  return normalized.catalog.screens[screenId] ? inlineEditorOrder(normalized, screenId)[Number(index)] || null : null;
}
