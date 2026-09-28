export const MANDATORY_AUDIENCE_OPTIONS = Object.freeze([
  { key: 'regular_female', tier: 'regular', gender: 'female', label: 'کاربر معمولی (دختر)' },
  { key: 'regular_male', tier: 'regular', gender: 'male', label: 'کاربر معمولی (پسر)' },
  { key: 'plus_female', tier: 'plus', gender: 'female', label: 'کاربر پلاس (دختر)' },
  { key: 'plus_male', tier: 'plus', gender: 'male', label: 'کاربر پلاس (پسر)' },
]);

export const DEFAULT_MANDATORY_AUDIENCE = Object.freeze(
  Object.fromEntries(MANDATORY_AUDIENCE_OPTIONS.map(option => [option.key, true]))
);

export function normalizeMandatoryAudience(value) {
  let parsed = value;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { parsed = null; }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) parsed = {};
  return Object.fromEntries(MANDATORY_AUDIENCE_OPTIONS.map(({ key }) => [
    key,
    Object.hasOwn(parsed, key) ? parsed[key] === true : true,
  ]));
}

export function toggleMandatoryAudience(value, key) {
  if (!MANDATORY_AUDIENCE_OPTIONS.some(option => option.key === key)) return normalizeMandatoryAudience(value);
  const audience = normalizeMandatoryAudience(value);
  audience[key] = !audience[key];
  return audience;
}

export function mandatoryAudienceLabels(value) {
  const audience = normalizeMandatoryAudience(value);
  const selected = MANDATORY_AUDIENCE_OPTIONS.filter(option => audience[option.key]).map(option => option.label);
  return selected.length ? selected.join('، ') : 'هیچ گروهی انتخاب نشده';
}

export function mandatoryAudienceIncludesUser(value, user, now = Date.now()) {
  const audience = normalizeMandatoryAudience(value);
  const expiresAt = user?.plus_expires_at ? new Date(user.plus_expires_at).getTime() : 0;
  const tier = Number.isFinite(expiresAt) && expiresAt > now ? 'plus' : 'regular';
  const gender = user?.gender;
  if (gender === 'female' || gender === 'male') return audience[`${tier}_${gender}`] === true;
  // A missing gender must not silently bypass a mandatory source selected for the user's tier.
  return audience[`${tier}_female`] === true || audience[`${tier}_male`] === true;
}

export function mandatoryAudienceSelectionKeyboard(value) {
  const audience = normalizeMandatoryAudience(value);
  const rows = MANDATORY_AUDIENCE_OPTIONS.map(({ key, label }) => [{
    text: `${audience[key] ? '✅' : '❌'} ${label}`,
    callback_data: `mandatory:audience:toggle:${key}`,
  }]);
  rows.push([{ text: 'ادامه و بازبینی', callback_data: 'mandatory:audience:review' }]);
  rows.push([{ text: 'لغو تنظیم منبع', callback_data: 'mandatory:audience:cancel' }]);
  return { reply_markup: { inline_keyboard: rows } };
}

export function mandatoryAudienceReviewKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '✅ تأیید نهایی و ثبت منبع', callback_data: 'mandatory:audience:confirm' }],
        [{ text: 'ویرایش گروه‌ها', callback_data: 'mandatory:audience:edit' }],
        [{ text: 'لغو تنظیم منبع', callback_data: 'mandatory:audience:cancel' }],
      ],
    },
  };
}
