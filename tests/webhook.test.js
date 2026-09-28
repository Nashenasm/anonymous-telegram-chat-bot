import { describe, expect, it } from 'vitest';
import { arePreferencesCompatible, BLOCK_REASONS, DEFAULTS, STOP_MIN_SECONDS, isTelegramMember, mandatoryAdminSourceDetails, mandatoryJoinMarkup, mandatoryJoinMessage, normalizeFa, preferenceFromText, preferenceKeyboard } from '../api/webhook.js';
import fs from 'node:fs';

const schema = fs.readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');
const source = fs.readFileSync(new URL('../api/webhook.js', import.meta.url), 'utf8');

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
    expect(source).toContain("telegram('getChatMember'");
    expect(source).toContain("data === 'mandatory:verify'");
    expect(source).toContain('mandatoryJoinMarkup(missing)');
    expect(source).toContain("value === 'جویین اجباری'");
    expect(source).toContain("value === 'کنسل کردن'");
    expect(source).toContain("privateMatch = raw.match");
    expect(source).toContain("telegram('getChat'");
    expect(source).toContain("value === 'ارسال به صف'");
    expect(source).toContain("1405/6/10-17:10");
    expect(source).toContain("status='completed'");
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
    const addSource = source.slice(source.indexOf("if (isAdmin(id) && me.action_state?.startsWith('mandatory:activate:'))"), source.indexOf("if (isAdmin(id) && me.action_state?.startsWith('mandatory:schedule:'))"));
    expect(requirement).toContain('recordJoins = false');
    expect(requirement).toContain('else if (recordJoins)');
    expect(requirement).toContain('ON CONFLICT DO NOTHING');
    expect(verify).toContain('{ recordJoins: true }');
    expect(start).toContain('mandatoryRequirements(id, client)');
    expect(start).not.toContain('recordJoins: true');
    expect(connect).toContain('mandatoryRequirements(id, client)');
    expect(connect).not.toContain('recordJoins: true');
    expect(addSource).toContain('INSERT INTO mandatory_sources');
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
