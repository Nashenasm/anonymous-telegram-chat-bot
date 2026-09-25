import { describe, expect, it } from 'vitest';
import { arePreferencesCompatible, BLOCK_REASONS, DEFAULTS, STOP_MIN_SECONDS, normalizeFa, preferenceFromText } from '../api/webhook.js';
import fs from 'node:fs';

const schema = fs.readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');
const source = fs.readFileSync(new URL('../api/webhook.js', import.meta.url), 'utf8');

describe('anonymous chat public contract', () => {
  it('keeps the requested default Persian button labels', () => {
    expect(DEFAULTS).toEqual({
      connect_button: 'وصل کن به ناشناس',
      cancel_button: 'انصراف',
      disconnect_button: 'قطع مکالمه',
    });
    expect(Object.values(BLOCK_REASONS)).toHaveLength(4);
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
  });

  it('enforces two-way preference matching and reply keyboards', () => {
    expect(source).toContain("($2='any' OR candidate.gender=$2)");
    expect(source).toContain("candidate.match_preference='any' OR candidate.match_preference=$3");
    expect(source).toContain("candidate.gender IN ('male','female')");
    expect(source).toContain('function replyKeyboard');
    expect(source).not.toContain('function keyboard(rows) { return { inline_keyboard: rows }; }');
    expect(source).toContain("me.action_state === 'choose_preference'");
  });

  it('matches users only when both sides accept the other', () => {
    expect(arePreferencesCompatible('male', 'any', 'female', 'any')).toBe(true);
    expect(arePreferencesCompatible('male', 'female', 'female', 'male')).toBe(true);
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
    expect(normalizeFa('ك')).not.toContain('\u000c');
    expect(source).toContain("preferenceText && me.status === 'idle'");
  });
});
