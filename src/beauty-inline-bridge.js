import { inlineEditorOrder } from './inline-appearance-editor.js';

const PUBLIC_PATHS = new Set([
  'connect', 'preference', 'gender', 'waiting', 'chat', 'confirm_stop',
  'after_stop', 'block_reason', 'profile', 'emoji', 'coins', 'plus', 'anonymous_link',
]);
const PUBLIC_ONLY_GROUPS = new Set([
  'connect', 'preference', 'gender', 'waiting', 'chat', 'confirm_stop',
  'after_stop', 'block_reason', 'profile', 'emoji', 'coins', 'plus', 'anonymous_link',
]);
const PRIVATE_GROUPS = new Set([
  'admin', 'admins', 'broadcast', 'finance', 'financecard', 'wallet', 'reports',
  'report', 'technical', 'user', 'users', 'ads', 'control', 'advertising', 'status',
]);
const ALIASES = {
  admins: ['admin'],
  reports: ['report'],
  users: ['user'],
  user_search: ['user', 'users'],
  technical: ['admin', 'technical'],
  preference: ['connect', 'match'],
  anonymous_link: ['link'],
  control: ['admin', 'admins'],
  ads: ['advertising', 'broadcast'],
  finance: ['financecard', 'wallet'],
  status: ['admin'],
};

export function beautyInlineGroupsForPath(section, path) {
  if (!['public', 'private'].includes(section) || path === 'root') return [];
  if (section === 'public' && !PUBLIC_PATHS.has(path)) return [];
  const groups = new Set([path, ...(ALIASES[path] || [])]);
  if (section === 'public') {
    for (const group of groups) if (!PUBLIC_ONLY_GROUPS.has(group)) groups.delete(group);
  } else {
    for (const group of groups) if (!PRIVATE_GROUPS.has(group) && group === 'match') groups.delete(group);
  }
  return [...groups];
}

export function beautyInlineEntries(section, appearance, path, config) {
  if (!appearance || !config?.catalog?.screens) return [];
  const groups = new Set(beautyInlineGroupsForPath(section, path));
  if (!groups.size) return [];
  const entries = [];
  for (const [screenId, screen] of Object.entries(config.catalog.screens)) {
    if (!groups.has(screen.group)) continue;
    const order = inlineEditorOrder(config, screenId);
    for (let index = 0; index < order.length; index += 1) {
      const key = order[index];
      const item = config.catalog.buttons[key] || {};
      const override = config.buttons[key] || {};
      if (override.enabled === false) continue;
      entries.push({ screenId, index, label: `◈ ${override.label || item.label || key}`.slice(0, 64) });
    }
  }
  return entries;
}
