import { describe, expect, it } from 'vitest';
import { adminUserSummary, durationLabel, parseDuration, permissionKeyboard } from '../src/admin-control.js';

describe('admin controls', () => {
  it('parses portable durations', () => {
    expect(parseDuration('15S')).toBe(15); expect(parseDuration('2M')).toBe(120); expect(parseDuration('1H')).toBe(3600); expect(parseDuration('3D')).toBeNull();
  });
  it('formats durations', () => { expect(durationLabel(15)).toBe('15S'); expect(durationLabel(120)).toBe('2M'); expect(durationLabel(3600)).toBe('1H'); });
  it('builds permission labels', () => { expect(permissionKeyboard({ photo: true, profanity: false })[0].label).toContain('✅'); expect(permissionKeyboard({ photo: true, profanity: false }).find(x => x.key === 'profanity').label).toContain('❌'); });
  it('renders a user summary', () => { const text = adminUserSummary({ telegram_id: 12, gender: 'male', coins: 8, status: 'chatting' }, { total_chats: 2 }, { isPlus: false }); expect(text).toContain('آیدی عددی: 12'); expect(text).toContain('تعداد چت‌ها: 2'); });
});
