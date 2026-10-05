import { describe, expect, it } from 'vitest';
import { arePreferencesCompatible, BLOCK_REASONS, DEFAULTS, STOP_MIN_SECONDS, isTelegramMember, mandatoryAdminSourceDetails, mandatoryJoinKeyboard, mandatoryJoinMarkup, mandatoryJoinMessage, mandatoryScheduleListKeyboard, mandatoryScheduleListText, mandatoryStatusKeyboard, mandatoryStatusText, normalizeFa, preferenceFromText, preferenceKeyboard } from '../api/webhook.js';
import { isMandatoryJobsAuthorized } from '../api/mandatory-jobs.js';
import { formatMandatorySourceDetails, mandatorySourceKeyboard, mandatoryTrackingListKeyboard, parseTrackingCommand, trackingCommand } from '../src/mandatory-service.js';
import { DEFAULT_MANDATORY_AUDIENCE, MANDATORY_AUDIENCE_OPTIONS, mandatoryAudienceIncludesUser, mandatoryAudienceLabels, mandatoryAudienceReviewKeyboard, mandatoryAudienceSelectionKeyboard, normalizeMandatoryAudience, toggleMandatoryAudience } from '../src/mandatory-audience.js';
import { decryptMandatoryTrackingUserId, encryptMandatoryTrackingUserId } from '../src/mandatory-tracking-token.js';
import fs from 'node:fs';

const schema = fs.readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');
const trackingMigration = fs.readFileSync(new URL('../db/schema-v6-mandatory-tracking.sql', import.meta.url), 'utf8');
const audienceMigration = fs.readFileSync(new URL('../db/schema-v7-mandatory-audience.sql', import.meta.url), 'utf8');
const source = fs.readFileSync(new URL('../api/webhook.js', import.meta.url), 'utf8');
const serviceSource = fs.readFileSync(new URL('../src/mandatory-service.js', import.meta.url), 'utf8');
const serverSource = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');

describe('anonymous chat public contract', () => {
  it('keeps the requested default Persian button labels', () => {
    expect(DEFAULTS).toEqual({
      connect_button: 'وصل کن به ناشناس',
      cancel_button: 'انصراف',
      disconnect_button: 'قطع مکالمه',
      profile_button: 'پروفایل من',
      back_button: 'بازگشت',
      welcome_message: 'به چت ناشناس خوش آمدی.',
      connected_message: 'وصل شدی؛ سلام کن و گفت‌وگو را شروع کن.',
      increase_coins_button: 'افزایش مانو کوین',
      free_coins_button: 'افزایش مانو کوین رایگان',
      plus_button: 'اکانت پلاس',
      mandatory_join_message: 'برای استفاده از ربات، ابتدا در منابع اجباری عضو شو. با دکمه‌های عضویت وارد شو و سپس «بررسی عضویت» را بزن.',
      mandatory_join_button_label: 'عضویت در منبع',
      mandatory_verify_button_label: 'بررسی عضویت',
      mandatory_join_button_layout: 'single',
      mandatory_join_show_source_tags: 'true',
    });
    expect(Object.values(BLOCK_REASONS)).toHaveLength(4);
  });

  it('includes plus, referral, and role persistence in the schema', () => {
    expect(schema).toContain('plus_expires_at');
    expect(schema).toContain('plus_emoji');
    expect(schema).toContain('referral_code');
    expect(schema).toContain('plus_purchases');
    expect(source).toContain('ظاهر ایموجی پلاس');
    expect(source).toContain('plus:confirm');
  });

  it('renders plus badges in parentheses and uses a 24-hour profile clock', () => {
    expect(source).toContain("return role ? `${premiumMarker(role)} ${badgeFor(me, id)}\\n${text}` : text;");
    expect(source).toContain("hourCycle: 'h23'");
    expect(source).toContain("hour12: false");
  });

  it('uses role-specific verification markers and does not treat slash text as a command', () => {
    expect(source).toContain("premiumMarker(role) { return role === 'owner' ? '/owner' : role === 'admin' ? '/admin' : '/plus'; }");
    expect(source).toContain("data.match(/^premium:verify:(plus|admin|owner):(\\d+)$/)");
    expect(source).toContain('requiredCount = isOwner(id) ? 3 : isAdmin(id) ? 2 : 1');
    expect(source).toContain("if (command === '/start')");
    expect(source).toContain("if (['/plus', '/admin', '/owner'].includes(command)) return handlePremiumRoleCommand(id, command);");
    expect(source).toContain("viewer?.status === 'chatting' && viewer.partner_id");
    expect(source).toContain('formatPremiumMessage(sender, senderId, text), replyMarkup');
    expect(source).not.toContain('premiumMessageMarkup');
    expect(source).not.toContain('inline_keyboard: [[verify]]');
  });

  it('unifies slash user lookup, manpin lookup, and live control on one panel state', () => {
    expect(source).toContain("['/user', '/کاربر', '/کنترل', '/کنترل_کاربر', '/controluser'].includes(command)");
    expect(source).toContain("admin:user_control_lookup");
    expect(source).toContain('openAdminUserPanel(id, payload)');
    expect(source).toContain("(value === '🎛 کنترل کاربر' || value === 'کنترل کاربران' || value === 'کنترل این کاربر') && isAdmin(id) && me.status === 'chatting'");
    expect(source).toContain('adminUserPanel(client, id, Number(me.partner_id))');
    expect(source).toContain("if (publicActionId === 'connect' || value === s.connect_button)");
  });

  it('keeps entertainment buttons visible despite custom chat appearance and separates global controls', () => {
    expect(source).toContain("settings.mid_chat_games_enabled !== 'false'");
    expect(source).toContain("extras.push('هدیه دادن')");
    expect(source).toContain("me.action_state === 'admin:conversation_control'");
    expect(source).toContain("admin:user_control_hub");
    expect(source).toContain("function giftManagementKeyboard()");
    expect(source).toContain("gift:type:coins");
    expect(source).toContain("gift:type:plus");
    expect(source).toContain("1d2h3m40s");
    expect(source).toContain("/^\\/\\d{3,20}$/");
    expect(source).toContain('permissionInlineKeyboard');
    expect(source).toContain('plusDirectionInlineKeyboard');
    expect(source).toContain('admin:user:message');
    expect(source).toContain('max_uses');
    expect(source).toContain('redeemGift');
    expect(source).toContain('daily_coin_command');
    expect(source).not.toContain("['کنترل مکالمات'], ['کنترل یک کاربر']");
    expect(source).toContain('هزینه هر چت');
    expect(source).toContain('chatCostInlineKeyboard');
    expect(source).toContain('chargeSuccessfulConnection');
    expect(source).toContain('حساب مانو کوین شما توسط مدیریت تغییر کرد');
    expect(source).toContain("gift:type:discount");
    expect(source).toContain('command_name');
    expect(source).toContain('discount_percent');
    expect(source).toContain('gift_code_redemptions');
    expect(source).toContain('هر کاربر فقط یک بار');
    expect(source).toContain('finalPrice');
    expect(source).toContain('chat_cost_any');
    expect(source).toContain('chat_cost_male');
    expect(source).toContain('chat_cost_female');
    expect(source).toContain("editAudienceCallback(callbackQuery, id, 'مجوزهای چت'");
    expect(source).toContain('bannedListKeyboard');
    expect(source).toContain('admin:banned_list');
    expect(source).toContain('کاربر معمولی دختر');
    expect(source).toContain('کاربران درآمدزا در ۳۰ روز اخیر');
    expect(source).toContain("state === 'admin:daily_coin:command'");
  });

  it('supports private contact usernames and in-place reply/block actions', () => {
    expect(source).toContain("value.match(/^@([A-Za-z0-9_]{3,32})$/)");
    expect(source).toContain('lower(username)=lower($2)');
    expect(source).toContain('contact:block_reason:');
    expect(source).toContain('editAudienceCallback(callbackQuery, id, row.body, contactMessageKeyboard(messageId))');
    expect(source).toContain("{ reply_markup: { inline_keyboard: [] } }");
    expect(source).toContain('await block(id, row.sender_id, reason');
  });
  it('maps forwarded Telegram message IDs so replies point to the original message', () => {
    expect(source).toContain('CREATE TABLE IF NOT EXISTS chat_reply_message_map');
    expect(source).toContain('async function resolveReplyMessageId');
    expect(source).toContain('await rememberReplyMessage(client, senderId, sourceMessageId, targetId, delivered?.message_id);');
    expect(source).toContain('replyTargetId = permissions.reply !== false');
  });

  it('exposes finance controls and fixed report/template navigation', () => {
    expect(source).toContain("['کنترل مالی']");
    expect(source).toContain('function financeKeyboard()');
    expect(source).toContain('async function financialReport(client)');
    expect(source).toContain("function reportsKeyboard() { return replyKeyboard");
    expect(source).toContain("if (value === 'بازگشت') { await updateAction(client, id, null); return send(id, 'کنترل ربات'");
  });

  it('provides global and per-wallet monitoring controls', () => {
    expect(source).toContain("wallet:monitor:global:");
    expect(source).toContain("wallet:monitor:auto:");
    expect(source).toContain("wallet:monitor:wallet:");
    expect(source).toContain("wallet:monitor:confirmations");
    expect(source).toContain("wallet:monitor:reset");
  });
  it('restores the wallet management label and complete auto-credit controls', () => {
    expect(source).toContain("['درگاه ها', 'مدیریت ولت']");
    expect(source).toContain("data === 'wallet:auto:on' || data === 'wallet:auto:off'");
    expect(source).toContain("callback_data: `wallet:monitor:auto:${autoOn ? 'off' : 'on'}`");
    expect(source).toContain("wallet:monitor:auto:");
  });
  it('protects gift-code administration from public users', () => {
    expect(source).toContain("data.startsWith('gift:') && !isAdmin(id)");
    expect(source).toContain("me.action_state?.startsWith('admin:gift') && !isAdmin(id)");
    expect(source).toContain('این بخش فقط برای مدیریت ربات است.');
  });
  it('notifies users about enabled bonuses without exposing referral identities', () => {
    expect(source).toContain('notifyBonus');
    expect(source).toContain('مقدار: +${result.amount} مانوکوین');
    expect(source).toContain('دلیل: ${definition.title}');
    expect(source).toContain('یک کاربر جدید با لینک دعوتت وارد ربات شد.');
    expect(source).not.toContain('شناسه کاربر: ${newcomerId}');
    expect(source).not.toContain('شناسه زیرمجموعه: ${newcomerId}');
  });
  it('supports timed referral rewards, public explanation, safe gift back navigation, and removes duplicate daily coin control', () => {
    expect(source).toContain('referral_started_at');
    expect(source).toContain('runReferralTimeRewards');
    expect(source).toContain('referral:time:toggle');
    expect(source).toContain('conditions.time=true');
    expect(source).toContain('شرط زمانی');
    expect(source).toContain("me.action_state?.startsWith('admin:gift:') && value === 'بازگشت'");
    expect(source).toContain("function userFinanceKeyboard() { return replyKeyboard([['گزارش مالی'], ['هزینه اتصال'], ['بازگشت کنترل کاربران']], true); }");
    expect(source).not.toContain("if (value === 'تنظیم دیلی کوین') { await updateAction(client, id, 'admin:daily_coin');");
  });
  it('places gift-code administration under bot finance ManoCoin controls', () => {
    expect(source).toContain("function manoCoinKeyboard() { return replyKeyboard([['قیمت مانوکوین'], ['کد هدیه', 'بونوس🎁'], ['زیرمجموعه✋🏻'], ['بازگشت امور مالی']], true); }");
    expect(source).toContain("function manoCoinAdminKeyboard() { return replyKeyboard([['قیمت مانوکوین'], ['کد هدیه', 'بونوس🎁'], ['زیرمجموعه✋🏻'], ['بازگشت امور مالی']], true); }");
    expect(source).toContain("function referralAdminKeyboard() { return replyKeyboard([['کوین پله ای'], ['کوین زیرمجموعه'], ['شرایط زیرمجموعه'], ['دکمه پاور'], ['بازگشت مانوکوین']], true); }");
    expect(source).toContain("referral:staged_condition");
    expect(source).toContain("referral_stage_amounts");
    expect(source).toContain("if (value === 'مانوکوین') { await updateAction(client, id, 'admin:manocoin'); return send(id, 'مانوکوین', manoCoinAdminKeyboard()); }");
    expect(source).toContain("if (value === 'کد هدیه') { await updateAction(client, id, 'admin:gifts'); return sendGiftManagement(client, id); }");
    expect(source).not.toContain("['دریافت وضعیت کاربران'], ['کد هدیه']");
    expect(source).toContain("'بازگشت مانوکوین'");
  });
  it('keeps card operations on the bot keyboard and glass buttons display only the admin label', () => {
    expect(source).toContain("function cardAdminReplyKeyboard() { return replyKeyboard([['افزودن', 'متن کارت'], ['بازگشت امور مالی']], true); }");
    expect(source).toContain('safeCardAdminLabel(c.admin_label)');
    expect(source).toContain("return send(id, 'عملیات امور کارت:', cardAdminReplyKeyboard());");
  });
  it('offers card-to-card as a payment method before showing payment contacts', () => {
    expect(source).toContain("function paymentMethodKeyboard() { return { reply_markup: { inline_keyboard: [[{ text: 'کارت به کارت', callback_data: 'coins:method:card' }");
    expect(source).toContain("if (data === 'coins:buy') return coinAmountPanel(sClient, id, callbackQuery);");
    expect(source).toContain("if (data === 'coins:method:card') return cardPaymentForUser(sClient, id);");
  });

  it('enforces the 15-second minimum conversation duration', () => {
    expect(STOP_MIN_SECONDS).toBe(15);
  });

  it('includes durable idempotency and settings storage', () => {
    expect(schema).toContain('CREATE TABLE IF NOT EXISTS processed_updates');
    expect(schema).toContain('CREATE TABLE IF NOT EXISTS bot_settings');
    expect(schema).toContain('CREATE TABLE IF NOT EXISTS anon_links');
    expect(schema).toContain('CREATE TABLE IF NOT EXISTS anonymous_pair_permissions');
    expect(schema).toContain('CREATE TABLE IF NOT EXISTS anonymous_pending_messages');
    expect(schema).toContain('CREATE TABLE IF NOT EXISTS anonymous_blocks');
    expect(schema).toContain('gender TEXT');
    expect(schema).toContain('conversation_started_at');
    expect(schema).toContain('coins INTEGER NOT NULL DEFAULT 0');
    expect(schema).toContain("expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days')");
  });

  it('includes mandatory-join sources, unique events, queues, and membership confirmation', () => {
    expect(schema).toContain('CREATE TABLE IF NOT EXISTS mandatory_sources');
    expect(schema).toContain('CREATE TABLE IF NOT EXISTS mandatory_source_events');
    expect(schema).toContain('CREATE TABLE IF NOT EXISTS mandatory_source_queue');
    expect(schema).toContain('audience JSONB NOT NULL');
    expect(audienceMigration).toContain('ADD COLUMN IF NOT EXISTS audience JSONB');
    expect(source).toContain("telegram('getChatMember'");
    expect(source).toContain("data === 'mandatory:verify'");
    expect(source).toContain('mandatoryJoinMarkup(missing, s, id)');
    expect(source).toContain("value === 'جویین اجباری'");
    expect(source).toContain("me.action_state === 'mandatory:schedule_list' && ['کنسل کردن','الان ست کن','تغییر تایم'].includes(value)");
    expect(source).toContain("privateMatch = raw.match");
    expect(source).toContain("telegram('getChat'");
    expect(source).toContain("['شروع از الان','ارسال به صف'].includes(value)");
    expect(source).toContain("1405/6/10-17:10");
    expect(serviceSource).toContain("status='completed'");
  });

  it('shows schedule actions only from the schedule-list keyboard', () => {
    const statusButtons = mandatoryStatusKeyboard().keyboard.flat();
    const scheduleButtons = mandatoryScheduleListKeyboard().keyboard.flat();
    expect(statusButtons).toContain('لیست زمان بندی');
    expect(mandatoryJoinKeyboard().keyboard.flat()).not.toContain('حذف');
    expect(mandatoryJoinKeyboard().keyboard.flat()).not.toContain('خاموش/روشن');
    expect(statusButtons).not.toContain('امور پیگیری');
    expect(statusButtons).not.toContain('الان ست کن');
    expect(statusButtons).not.toContain('تغییر تایم');
    expect(statusButtons).not.toContain('کنسل کردن');
    expect(scheduleButtons).toEqual(['الان ست کن', 'تغییر تایم', 'کنسل کردن', 'بازگشت']);
    expect(source).toContain("updateAction(client, id, 'mandatory:schedule_list')");
  });

  it('lists only dated scheduled sources and returns a friendly empty state', async () => {
    let sql = '';
    const client = { query: async (statement) => { sql = statement; return { rows: [{ tracking_code: 'MJ-SCHED-1', title: 'Campaign A', starts_at: new Date('2026-10-01T12:00:00Z') }] }; } };
    const text = await mandatoryScheduleListText(client);
    expect(sql).toContain("status='scheduled'");
    expect(sql).toContain('starts_at IS NOT NULL');
    expect(sql).toContain('ORDER BY starts_at,id');
    expect(text).toContain('MJ-SCHED-1');
    expect(text).toContain('Campaign A');
    const emptyText = await mandatoryScheduleListText({ query: async () => ({ rows: [] }) });
    expect(emptyText).toContain('مورد زمان‌بندی‌شده‌ای وجود ندارد');
  });

  it('gates cancel/activate/reschedule actions to the schedule-list state and returns there after edits', () => {
    const actions = source.slice(source.indexOf("me.action_state === 'mandatory:schedule_list' &&"), source.indexOf("if (isAdmin(id) && me.action_state === 'mandatory:cancel')"));
    const back = source.slice(source.indexOf('async function handleMandatoryBack'), source.indexOf('async function handleText'));
    expect(actions).toContain("['کنسل کردن','الان ست کن','تغییر تایم'].includes(value)");
    expect(actions).toContain('mandatoryScheduleListKeyboard()');
    expect(back).toContain("kind === 'schedule_list'");
    expect(back).toContain("kind === 'cancel' || kind === 'activate' || kind === 'reschedule' || kind === 'reschedule_at'");
    expect(source).toContain("status='scheduled' AND starts_at IS NOT NULL");
  });

  it('keeps mandatory-join URLs out of user text and offers only generic inline join/verify buttons', () => {
    const secretJoinUrl = 'https://t.me/+privateInviteCode';
    const missing = [
      { source_type: 'channel', title: 'Hidden Channel Title', target: '-1001234567890', join_url: secretJoinUrl },
      { source_type: 'group', title: 'Hidden Group Title', target: '-1009876543210', join_url: 'https://t.me/+anotherPrivateCode' },
    ];
    const message = mandatoryJoinMessage(missing);
    expect(message).toContain('بررسی عضویت');
    expect(message).not.toContain(secretJoinUrl);
    expect(message).not.toContain('Hidden Channel Title');
    expect(message).not.toContain('-1001234567890');
    expect(message).not.toContain('/start');
    expect(mandatoryJoinMarkup(missing).reply_markup.inline_keyboard).toEqual([
      [{ text: 'عضویت در منبع 1', url: secretJoinUrl }],
      [{ text: 'عضویت در منبع 2', url: 'https://t.me/+anotherPrivateCode' }],
      [{ text: 'بررسی عضویت', callback_data: 'mandatory:verify' }],
    ]);
  });

  it('shows chat IDs and private invite links only in admin source details', () => {
    const details = mandatoryAdminSourceDetails({
      tracking_code: 'MJ-AB12CD34', source_type: 'channel', title: 'Private Channel',
      target: '-1001234567890', join_url: 'https://t.me/+adminOnlyLink', mode: 'count',
      status: 'active', joined_count: '7',
    });
    expect(details).toContain('آیدی عددی: -1001234567890');
    expect(details).toContain('لینک دعوت خصوصی: https://t.me/+adminOnlyLink');
    expect(details).toContain('اعضای تأییدشده: 7');
    expect(mandatoryJoinMessage()).not.toContain('https://t.me/');
  });

  it('counts only explicit membership verification and keeps one sticky event per setup/user', () => {
    const requirement = source.slice(source.indexOf('async function mandatoryRequirements'), source.indexOf('async function recordMandatoryStart'));
    const verify = source.slice(source.indexOf("if (data === 'mandatory:verify')"), source.indexOf("if (data.startsWith('anon:'))"));
    const start = source.slice(source.indexOf('async function handleStart'), source.indexOf('async function handleConnect'));
    const connect = source.slice(source.indexOf('async function handleConnect'), source.indexOf('async function handleCallback'));
    const addSource = source.slice(source.indexOf('async function persistMandatorySourceDraft'), source.indexOf('async function handleMandatoryAudienceCallback'));
    expect(requirement).toContain('recordJoins = false');
    expect(requirement).toContain('else if (recordJoins)');
    expect(requirement).toContain('ON CONFLICT DO NOTHING');
    expect(verify).toContain('{ recordJoins: true, profile }');
    expect(start).toContain('mandatoryRequirements(id, client, { profile: me })');
    expect(start).not.toContain('recordJoins: true');
    expect(connect).toContain('mandatoryRequirements(id, client, { profile: me })');
    expect(connect).not.toContain('recordJoins: true');
    expect(addSource).toContain('INSERT INTO mandatory_sources');
    expect(addSource).toContain('audience');
    expect(addSource).not.toContain('ON CONFLICT');
    expect(schema).toMatch(/CREATE TABLE IF NOT EXISTS mandatory_source_events[\s\S]*PRIMARY KEY \(source_id, telegram_id\)/);
    expect(schema).toMatch(/mandatory_source_events[\s\S]*REFERENCES mandatory_sources\(id\) ON DELETE CASCADE/);
    expect(source).not.toContain('DELETE FROM mandatory_source_events');
  });

  it('accepts restricted members only when Telegram confirms they are still members', () => {
    expect(isTelegramMember({ status: 'creator' })).toBe(true);
    expect(isTelegramMember({ status: 'administrator' })).toBe(true);
    expect(isTelegramMember({ status: 'member' })).toBe(true);
    expect(isTelegramMember({ status: 'restricted', is_member: true })).toBe(true);
    expect(isTelegramMember({ status: 'restricted', is_member: false })).toBe(false);
    expect(isTelegramMember({ status: 'left' })).toBe(false);
    expect(isTelegramMember({ status: 'kicked' })).toBe(false);
  });

  it('enforces two-way preference matching and reply keyboards', () => {
    expect(source).toContain("($2='any' OR candidate.gender=$2)");
    expect(source).toContain("COALESCE(candidate.match_preference, 'any')='any' OR candidate.match_preference=$3");
    expect(source).toContain("candidate.gender IN ('male','female')");
    expect(source).toContain('function replyKeyboard');
    expect(source).not.toContain('function keyboard(rows) { return { inline_keyboard: rows }; }');
    expect(source).toContain("me.action_state === 'choose_preference'");
  });

  it('shows all three partner-gender choices together as ordinary bot buttons', () => {
    expect(preferenceKeyboard()).toEqual({
      keyboard: [['پسر', 'دختر', 'مهم نیست']],
      resize_keyboard: true,
      one_time_keyboard: true,
      selective: true,
    });
    expect(source).toContain('OWN_GENDER_PROMPT');
    const connectHandler = source.slice(source.indexOf('async function handleConnect'), source.indexOf('async function handleCallback'));
    expect(connectHandler).toContain("await updateAction(client, id, 'choose_preference')");
    expect(connectHandler).not.toContain('!me.gender');
    expect(source).toContain('choose_gender_for:${preference}');
  });

  it('matches users only when both sides accept the other', () => {
    expect(arePreferencesCompatible('male', 'any', 'female', 'any')).toBe(true);
    expect(arePreferencesCompatible('male', 'female', 'female', 'male')).toBe(true);
    expect(arePreferencesCompatible('female', 'male', 'male', 'female')).toBe(true);
    expect(arePreferencesCompatible('male', 'male', 'male', 'any')).toBe(true);
    expect(arePreferencesCompatible('female', 'female', 'female', 'any')).toBe(true);
    expect(arePreferencesCompatible('male', 'male', 'female', 'any')).toBe(false);
    expect(arePreferencesCompatible('female', 'female', 'male', 'any')).toBe(false);
    expect(arePreferencesCompatible('female', 'any', 'male', 'female')).toBe(true);
    expect(arePreferencesCompatible('female', 'any', 'male', 'male')).toBe(false);
    expect(arePreferencesCompatible('male', 'female', 'female', 'female')).toBe(false);
    expect(arePreferencesCompatible('female', 'male', 'female', 'any')).toBe(false);
    expect(arePreferencesCompatible('unknown', 'any', 'female', 'any')).toBe(false);
    expect(arePreferencesCompatible('male', 'any', 'female', null)).toBe(false);
  });

  it('keeps private anonymous link URLs shareable without unprotecting normal chat', () => {
    expect(source).toContain("const ANONYMOUS_LINK_BUTTON = 'لینک ناشناس من'");
    expect(source).toContain('protect_content: false');
    expect(source).toContain('protect_content: true');
    expect(source).toContain('handleStartPayload(id, payload)');
    expect(source).toContain("me.action_state?.startsWith('anon_')");
  });

  it('accepts Persian keyboard variants even when action state is stale', () => {
    expect(preferenceFromText(' پسر ')).toBe('male');
    expect(preferenceFromText('دختر')).toBe('female');
    expect(preferenceFromText('مهم\u200cنیست')).toBe('any');
    expect(preferenceFromText('مهم نیست')).toBe('any');
    expect(normalizeFa('ك\f')).not.toContain('\u000c');
    expect(source).toContain("preferenceText && me.status === 'idle'");
  });

  it('exposes stable, clickable slash commands for every tracking code', () => {
    expect(trackingCommand('MJ-AB12CD34')).toBe('/mj_ab12cd34');
    expect(parseTrackingCommand('/mj_ab12cd34')).toBe('mjab12cd34');
    expect(parseTrackingCommand('/mj_ab12cd34@mybot')).toBe('mjab12cd34');
    expect(parseTrackingCommand('/start')).toBeNull();
    expect(source).toContain('parseTrackingCommand(rawCommand)');
    expect(source).toContain('lookupKey: trackingKey');
  });

  it('offers status-specific inline controls without deleting completed history', () => {
    const active = mandatorySourceKeyboard({ tracking_code: 'MJ-A1B2C3D4', status: 'active' }).reply_markup.inline_keyboard;
    const scheduled = mandatorySourceKeyboard({ tracking_code: 'MJ-A1B2C3D4', status: 'scheduled', queue_position: 2 }).reply_markup.inline_keyboard;
    const completed = mandatorySourceKeyboard({ tracking_code: 'MJ-A1B2C3D4', status: 'completed' }).reply_markup.inline_keyboard;
    expect(active.flat().map(x => x.text)).toEqual(['/mj_a1b2c3d4', 'توقف موقت', 'کنسل کردن']);
    expect(scheduled.flat().map(x => x.text)).toEqual(['/mj_a1b2c3d4', 'الان ست کن', 'زمان‌بندی کردن', 'کنسل کردن']);
    expect(completed.flat().map(x => x.text)).toEqual(['/mj_a1b2c3d4']);
    expect(mandatoryTrackingListKeyboard([{ tracking_code: 'MJ-A1B2C3D4' }]).reply_markup.inline_keyboard[0][0]).toMatchObject({
      text: '/mj_a1b2c3d4', callback_data: expect.stringMatching(/^mandatory:details:/),
    });
    expect(source).toContain("status='cancelled',updated_at=NOW()");
    expect(source).not.toContain('DELETE FROM mandatory_sources');
  });

  it('supports four audience toggles, profile matching, conservative missing-gender behavior, and review confirmation', () => {
    expect(MANDATORY_AUDIENCE_OPTIONS.map(x => x.label)).toEqual(['کاربر معمولی (دختر)','کاربر معمولی (پسر)','کاربر پلاس (دختر)','کاربر پلاس (پسر)']);
    expect(Object.values(DEFAULT_MANDATORY_AUDIENCE).every(Boolean)).toBe(true);
    const keyboard = mandatoryAudienceSelectionKeyboard(DEFAULT_MANDATORY_AUDIENCE).reply_markup.inline_keyboard;
    expect(keyboard.slice(0,4).flat().map(x => x.text)).toEqual(MANDATORY_AUDIENCE_OPTIONS.map(x => `✅ ${x.label}`));
    expect(keyboard[4][0].callback_data).toBe('mandatory:audience:review');
    expect(mandatoryAudienceReviewKeyboard().reply_markup.inline_keyboard[0][0].callback_data).toBe('mandatory:audience:confirm');
    const onlyRegularFemale = normalizeMandatoryAudience({regular_female:true,regular_male:false,plus_female:false,plus_male:false});
    expect(mandatoryAudienceIncludesUser(onlyRegularFemale,{gender:'female',plus_expires_at:null})).toBe(true);
    expect(mandatoryAudienceIncludesUser(onlyRegularFemale,{gender:'male',plus_expires_at:null})).toBe(false);
    expect(mandatoryAudienceIncludesUser(onlyRegularFemale,{gender:'female',plus_expires_at:new Date(Date.now()+86400000)})).toBe(false);
    expect(mandatoryAudienceIncludesUser(onlyRegularFemale,{gender:null,plus_expires_at:null})).toBe(true);
    expect(mandatoryAudienceLabels(onlyRegularFemale)).toContain('کاربر معمولی (دختر)');
    expect(toggleMandatoryAudience(onlyRegularFemale,'regular_female').regular_female).toBe(false);
    expect(Object.values(toggleMandatoryAudience({regular_female:false,regular_male:false,plus_female:false,plus_male:false},'bad')).some(Boolean)).toBe(false);
    const persistence = source.slice(source.indexOf('async function persistMandatorySourceDraft'), source.indexOf('async function handleMandatoryAudienceCallback'));
    expect((persistence.match(/sourceTrackingCode\(\)/g) || [])).toHaveLength(1);
    expect(persistence).toContain('createMandatoryInviteLink(draft.type, storedTarget, tracking)');
    expect(persistence).toContain("await client.query('BEGIN')");
    expect(persistence).toContain("await client.query('COMMIT')");
    expect(source).toContain('await handleCallback(Number(callback.from.id), callbackData, callback)');
  });

  it('customizes join text and inline-button appearance while keeping tracked URL buttons', () => {
    const missing = [{join_url:'https://t.me/+private-code'}];
    expect(mandatoryJoinMessage(missing,{mandatory_join_message:'Join {count} sources'})).toBe('Join 1 sources');
    const markup = mandatoryJoinMarkup(missing,{mandatory_join_button_label:'ورود',mandatory_join_show_source_tags:'false',mandatory_join_button_layout:'compact',mandatory_verify_button_label:'تأیید'}).reply_markup.inline_keyboard;
    expect(markup).toEqual([[{text:'ورود',url:'https://t.me/+private-code'}],[{text:'تأیید',callback_data:'mandatory:verify'}]]);
    const previousSecret = process.env.MANDATORY_TRACKING_SECRET;
    process.env.MANDATORY_TRACKING_SECRET = 's'.repeat(32);
    try {
      const tracked = mandatoryJoinMarkup([{join_url:'https://example.com/api/mandatory-track?code=MJ-A1B2C3D4'}], {}, '123456789').reply_markup.inline_keyboard[0][0].url;
      const token = new URL(tracked).searchParams.get('uid');
      expect(token).not.toBe('123456789');
      expect(decryptMandatoryTrackingUserId(token, 's'.repeat(32))).toBe('123456789');
      expect(decryptMandatoryTrackingUserId(token, 'x'.repeat(32))).toBeNull();
      const changedToken = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
      expect(decryptMandatoryTrackingUserId(changedToken, 's'.repeat(32))).toBeNull();
    } finally {
      if (previousSecret === undefined) delete process.env.MANDATORY_TRACKING_SECRET;
      else process.env.MANDATORY_TRACKING_SECRET = previousSecret;
    }
  });

  it('uses one operational status list without completed records or a second inline tracking list', async () => {
    let sql='';
    const text=await mandatoryStatusText({query:async q=>{sql=q;return {rows:[]};}});
    expect(sql).toContain("status IN ('scheduled','active','paused')");
    expect(text).toContain('هیچ منبع فعالی');
    const statusHandler=source.slice(source.indexOf("if (isAdmin(id) && value === 'وضعیت')"),source.indexOf("if (isAdmin(id) && value === 'لیست زمان بندی')"));
    expect(statusHandler).toContain('return send(id, await mandatoryStatusText(client), mandatoryStatusKeyboard())');
    expect(statusHandler).not.toContain('sendMandatoryTrackingList');
    const joinKeyboard=source.slice(source.indexOf('export function mandatoryJoinKeyboard'),source.indexOf('function mandatoryTypeKeyboard'));
    expect(joinKeyboard).not.toContain('حذف');
    expect(joinKeyboard).not.toContain('امور پیگیری');
    expect(joinKeyboard).not.toContain('خاموش/روشن');
    expect(source).toContain("status IN ('scheduled','active','paused') ORDER BY ms.id DESC LIMIT 50");
  });

  it('keeps private invite links out of public reports but allows them in private reports', () => {
    const record = {
      tracking_code: 'MJ-AB12CD34', title: 'Example', source_type: 'channel', status: 'active', mode: 'count',
      target: '-1001234567890', join_url: 'https://t.me/+privateInvite', quota: 10,
      created_at: new Date('2026-09-01T10:00:00Z'), updated_at: new Date('2026-09-01T10:00:00Z'),
    };
    expect(formatMandatorySourceDetails(record)).not.toContain(record.join_url);
    expect(formatMandatorySourceDetails(record, [], { includePrivateDetails: true })).toContain(record.join_url);
    expect(serviceSource).toContain("key='mandatory_report_channel_private'");
  });

  it('protects the every-minute lifecycle route with a timing-safe bearer secret', () => {
    const secret = 's'.repeat(32);
    expect(isMandatoryJobsAuthorized({ headers: { authorization: `Bearer ${secret}` } }, secret)).toBe(true);
    expect(isMandatoryJobsAuthorized({ headers: { authorization: `Bearer ${'x'.repeat(32)}` } }, secret)).toBe(false);
    expect(isMandatoryJobsAuthorized({ headers: {} }, secret)).toBe(false);
    expect(trackingMigration).toContain('CREATE TABLE IF NOT EXISTS mandatory_source_history');
    expect(trackingMigration).toContain('CREATE TABLE IF NOT EXISTS mandatory_source_reports');
    expect(trackingMigration).toContain('ADD COLUMN IF NOT EXISTS paused_at');
    expect(serverSource).toContain("req.url === '/api/mandatory-jobs'");
  });

  it('processes gender selection before a same-word search preference', () => {
    const chooseGender = source.indexOf("if (me.action_state === 'choose_gender' || me.action_state?.startsWith('choose_gender_for:'))");
    const fallbackPreference = source.indexOf('const preferenceText = preferenceFromText(value)');
    expect(chooseGender).toBeGreaterThan(-1);
    expect(fallbackPreference).toBeGreaterThan(chooseGender);
    expect(source).toContain("if (me.action_state === 'choose_preference')");
    expect(source).toContain("if (!['male', 'female'].includes(me.gender))");
  });

  it('keeps anonymous message callbacks separate from random chat and serializes searches', () => {
    expect(source).toContain("if (data.startsWith('anon:'))");
    expect(source).toContain('return flowFor(s).handleCallback(id, data)');
    expect(source).toContain('pg_advisory_xact_lock');
    expect(source).toContain("AND ($2='any' OR candidate.gender=$2)");
    expect(source).toContain("AND (COALESCE(candidate.match_preference, 'any')='any' OR candidate.match_preference=$3)");
    expect(source).toContain("CASE WHEN $2='any' AND COALESCE(candidate.match_preference, 'any')=$3 THEN 0 ELSE 1 END ASC");
    expect(source).toContain("CASE WHEN $2='any' THEN random() ELSE 0 END");
  });
});
