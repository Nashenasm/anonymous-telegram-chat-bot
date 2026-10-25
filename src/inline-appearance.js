import { createHash } from 'node:crypto';

const STYLES = new Set(['primary', 'success', 'danger']);
const LAYOUTS = new Set(['original', 'single', 'columns2', 'columns3']);
const ACTION_FIELDS = [
  'callback_data', 'url', 'web_app', 'login_url', 'switch_inline_query',
  'switch_inline_query_current_chat', 'switch_inline_query_chosen_chat',
  'copy_text', 'callback_game', 'pay',
];

// These surfaces can contain payment, identity, safety, or irreversible-action
// details. Their button appearance remains editable, but their page text does not.
const PROTECTED_MESSAGE_GROUPS = new Set([
  'admins', 'admin', 'bonus', 'broadcast', 'chatgift', 'coins', 'contact',
  'finance', 'financecard', 'gift', 'mandatory', 'plus', 'wallet', 'url', 'web_app', 'copy_text', 'pay',
]);

const asObject = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const clone = value => JSON.parse(JSON.stringify(value));

function normalizeDynamicPart(value) {
  const part = String(value || '');
  if (/^\d{5,}$/.test(part)) return '{id}';
  if (/^[0-9a-f]{8}-[0-9a-f-]{20,}$/i.test(part)) return '{id}';
  if (/^[A-Za-z0-9_-]{24,}$/.test(part)) return '{token}';
  return part;
}

export function inlineButtonKey(button) {
  if (!button || typeof button !== 'object') return null;
  if (typeof button.callback_data === 'string' && button.callback_data) {
    return `callback:${button.callback_data.split(':').map(normalizeDynamicPart).join(':')}`.slice(0, 240);
  }
  for (const field of ACTION_FIELDS) {
    if (!Object.hasOwn(button, field)) continue;
    let action = JSON.stringify(button[field]);
    if ((field === 'url' || field === 'web_app') && button[field]) {
      try {
        const rawUrl = typeof button[field] === 'string' ? button[field] : button[field].url;
        const parsed = new URL(rawUrl);
        action = `${parsed.origin}${parsed.pathname}`;
      } catch {}
    }
    const digest = createHash('sha256').update(`${field}:${action}`).digest('hex').slice(0, 20);
    return `${field}:${digest}`;
  }
  return null;
}

function actionGroup(buttonKey) {
  if (String(buttonKey).startsWith('callback:')) {
    return String(buttonKey).slice('callback:'.length).split(':')[0] || 'other';
  }
  return String(buttonKey || 'other').split(':')[0] || 'other';
}

function sourceTextSignature(value) {
  const normalized = String(value || '').replace(/https?:\/\/\S+/gi, '{url}').replace(/\d{3,}/g, '{n}').replace(/\b\d{1,2}:\d{2}\b/g, '{time}').replace(/\s+/g, ' ').trim().slice(0, 1200);
  return normalized ? createHash('sha256').update(normalized).digest('hex') : '';
}

export function inlineSurfaceId(rows) {
  const shape = (Array.isArray(rows) ? rows : []).map(row =>
    (Array.isArray(row) ? row : []).map(inlineButtonKey).filter(Boolean),
  );
  return createHash('sha256').update(JSON.stringify(shape)).digest('hex').slice(0, 20);
}

export function observeInlineKeyboard(markup, sourceText = '') {
  const wrapped = markup && typeof markup === 'object' && !Array.isArray(markup) && Object.hasOwn(markup, 'reply_markup');
  const replyMarkup = wrapped ? markup.reply_markup : markup;
  const rows = replyMarkup?.inline_keyboard;
  if (!Array.isArray(rows)) return null;
  const screenId = inlineSurfaceId(rows);
  const buttonRows = rows.map(row => (Array.isArray(row) ? row : []).map(button => ({
    key: inlineButtonKey(button),
    label: String(button?.text || '').slice(0, 80),
  })).filter(item => item.key));
  const buttons = buttonRows.flat();
  if (buttons.length && buttons.every(item => item.key?.startsWith('callback:inlinecfg:') || item.key?.startsWith('callback:beauty:'))) return null;
  const group = actionGroup(buttons[0]?.key);
  return {
    screenId,
    group,
    rows: buttonRows.map(row => row.map(item => item.key)),
    buttons,
    editableMessage: !buttons.some(item => PROTECTED_MESSAGE_GROUPS.has(actionGroup(item.key))),
    sourceTextSignature: sourceTextSignature(sourceText),
  };
}

export function normalizeInlineAppearance(value) {
  const source = asObject(value);
  const buttons = {};
  for (const [key, raw] of Object.entries(asObject(source.buttons))) {
    if (!key || key.length > 240) continue;
    const item = asObject(raw);
    const normalized = {};
    if (typeof item.label === 'string') normalized.label = item.label.trim().slice(0, 64);
    if (item.enabled === false) normalized.enabled = false;
    if (STYLES.has(item.style)) normalized.style = item.style;
    if (typeof item.icon_custom_emoji_id === 'string' && /^\d{5,30}$/.test(item.icon_custom_emoji_id)) {
      normalized.icon_custom_emoji_id = item.icon_custom_emoji_id;
    }
    if (Object.keys(normalized).length) buttons[key] = normalized;
  }
  const screens = {};
  for (const [key, raw] of Object.entries(asObject(source.screens))) {
    if (!/^[a-f0-9]{20}$/.test(key)) continue;
    const item = asObject(raw);
    const normalized = {};
    if (LAYOUTS.has(item.layout)) normalized.layout = item.layout;
    if (typeof item.message === 'string' && item.message.trim()) normalized.message = item.message.trim().slice(0, 4000);
    const messageText = normalized.message || '';
    const messageEntities = Array.isArray(item.messageEntities) ? item.messageEntities.filter(entity =>
      entity?.type === 'custom_emoji' && Number.isInteger(entity.offset) && Number.isInteger(entity.length)
      && entity.offset >= 0 && entity.length > 0 && entity.offset + entity.length <= messageText.length
      && /^\d{5,30}$/.test(String(entity.custom_emoji_id || '')),
    ).map(entity => ({ type: 'custom_emoji', offset: entity.offset, length: entity.length, custom_emoji_id: String(entity.custom_emoji_id) })) : [];
    if (messageEntities.length) normalized.messageEntities = messageEntities;
    const order = Array.isArray(item.order) ? item.order.filter(x => typeof x === 'string' && x.length <= 240).slice(0, 100) : [];
    if (order.length) normalized.order = [...new Set(order)];
    if (Object.keys(normalized).length) screens[key] = normalized;
  }
  const catalog = asObject(source.catalog);
  const catalogButtons = {};
  for (const [key, raw] of Object.entries(asObject(catalog.buttons))) {
    if (!key || key.length > 240) continue;
    const item = asObject(raw);
    catalogButtons[key] = { label: String(item.label || key).slice(0, 80), group: String(item.group || actionGroup(key)).slice(0, 40) };
  }
  const catalogScreens = {};
  for (const [key, raw] of Object.entries(asObject(catalog.screens))) {
    if (!/^[a-f0-9]{20}$/.test(key)) continue;
    const item = asObject(raw);
    catalogScreens[key] = {
      group: String(item.group || 'other').slice(0, 40),
      rows: Array.isArray(item.rows) ? item.rows.slice(0, 20).map(row => Array.isArray(row) ? row.filter(x => typeof x === 'string' && x.length <= 240).slice(0, 10) : []) : [],
      editableMessage: item.editableMessage === true,
      sourceTextSignature: /^[a-f0-9]{64}$/.test(item.sourceTextSignature) ? item.sourceTextSignature : '',
    };
  }
  return { version: 1, buttons, screens, catalog: { buttons: catalogButtons, screens: catalogScreens } };
}

export function recordInlineKeyboard(config, observation) {
  const next = normalizeInlineAppearance(config);
  if (!observation) return next;
  const catalogButtons = next.catalog.buttons;
  const catalogScreens = next.catalog.screens;
  let changed = false;
  for (const item of observation.buttons) {
    if (!item.key || item.key.startsWith('callback:inlinecfg:') || item.key.startsWith('callback:beauty:')) continue;
    const old = catalogButtons[item.key];
    const entry = { label: item.label || item.key, group: actionGroup(item.key) };
    if (!old) {
      catalogButtons[item.key] = entry;
      changed = true;
    }
  }
  const previousScreen = catalogScreens[observation.screenId] || {};
  const screenEntry = {
    group: observation.group,
    rows: observation.rows,
    editableMessage: observation.editableMessage,
    sourceTextSignature: previousScreen.sourceTextSignature || observation.sourceTextSignature || '',
  };
  if (JSON.stringify(previousScreen) !== JSON.stringify(screenEntry)) {
    catalogScreens[observation.screenId] = screenEntry;
    changed = true;
  }
  const screenEntries = Object.entries(catalogScreens);
  if (screenEntries.length > 300) {
    for (const [key] of screenEntries.slice(0, screenEntries.length - 300)) delete catalogScreens[key];
    changed = true;
  }
  const buttonEntries = Object.entries(catalogButtons);
  if (buttonEntries.length > 800) {
    for (const [key] of buttonEntries.slice(0, buttonEntries.length - 800)) delete catalogButtons[key];
    changed = true;
  }
  next.changed = changed;
  return next;
}

export function applyInlineAppearance(markup, config, sourceText = '') {
  const wrapped = markup && typeof markup === 'object' && !Array.isArray(markup) && Object.hasOwn(markup, 'reply_markup');
  const replyMarkup = wrapped ? markup.reply_markup : markup;
  const rows = replyMarkup?.inline_keyboard;
  if (!Array.isArray(rows)) return { markup, screenId: null, message: null };
  const screenId = inlineSurfaceId(rows);
  const appearance = normalizeInlineAppearance(config);
  const screen = appearance.screens[screenId] || {};
  const originalRows = rows.map(row => (Array.isArray(row) ? row : []).map(button => {
    const key = inlineButtonKey(button);
    const override = appearance.buttons[key] || {};
    if (!key || override.enabled === false) return override.enabled === false ? null : button;
    const out = { ...button };
    if (Object.hasOwn(override, 'label')) out.text = override.label;
    if (Object.hasOwn(override, 'style')) out.style = override.style;
    if (Object.hasOwn(override, 'icon_custom_emoji_id')) out.icon_custom_emoji_id = override.icon_custom_emoji_id;
    return out;
  }).filter(Boolean));
  const originalSizes = originalRows.map(row => row.length);
  let ordered = originalRows.flat();
  if (Array.isArray(screen.order) && screen.order.length) {
    const rank = new Map(screen.order.map((key, index) => [key, index]));
    ordered = [...ordered].sort((a, b) => (rank.get(inlineButtonKey(a)) ?? 10000) - (rank.get(inlineButtonKey(b)) ?? 10000));
  }
  let nextRows = originalRows;
  if (screen.layout && screen.layout !== 'original') {
    const columns = screen.layout === 'single' ? 1 : Number(screen.layout.slice('columns'.length));
    nextRows = [];
    for (let i = 0; i < ordered.length; i += columns) nextRows.push(ordered.slice(i, i + columns));
  } else if (Array.isArray(screen.order) && screen.order.length) {
    nextRows = [];
    let offset = 0;
    for (const size of originalSizes) {
      if (offset >= ordered.length) break;
      const row = ordered.slice(offset, offset + size);
      if (row.length) nextRows.push(row);
      offset += size;
    }
    if (offset < ordered.length) nextRows.push(ordered.slice(offset));
  }
  const nextReplyMarkup = { ...replyMarkup, inline_keyboard: nextRows };
  return {
    markup: wrapped ? { ...markup, reply_markup: nextReplyMarkup } : nextReplyMarkup,
    screenId,
    message: screen.message && appearance.catalog.screens[screenId]?.editableMessage && appearance.catalog.screens[screenId]?.sourceTextSignature === sourceTextSignature(sourceText) ? screen.message : null,
    messageEntities: screen.message && appearance.catalog.screens[screenId]?.editableMessage && appearance.catalog.screens[screenId]?.sourceTextSignature === sourceTextSignature(sourceText) ? (screen.messageEntities || []) : null,
  };
}

export function moveInlineButtonOrder(order, key, direction) {
  const next = Array.isArray(order) ? [...order] : [];
  const index = next.indexOf(key);
  if (index < 0) return next;
  const delta = direction === 'up' || direction === 'left' ? -1 : direction === 'down' || direction === 'right' ? 1 : 0;
  const target = index + delta;
  if (target >= 0 && target < next.length) [next[index], next[target]] = [next[target], next[index]];
  return next;
}
