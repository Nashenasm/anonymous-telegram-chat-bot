import { describe, expect, it } from 'vitest';
import { adminUserSummary, durationLabel, parseDuration, permissionKeyboard } from '../src/admin-control.js';

describe('admin controls', () => {
  it('parses portable durations', () => {
    expect(parseDuration('15S')).toBe(15); expect(parseDuration('2M')).toBe(120); expect(parseDuration('1H')).toBe(3600); expect(parseDuration('3D')).toBe(259200); expect(parseDuration('1d2h3m40s')).toBe(93820);
  });
  it('formats durations', () => { expect(durationLabel(15)).toBe('15s'); expect(durationLabel(120)).toBe('2m'); expect(durationLabel(3600)).toBe('1h'); expect(durationLabel(93784)).toBe('1d 2h 3m 4s'); });
  it('builds permission labels', () => { expect(permissionKeyboard({ photo: true, profanity: false })[0].label).toContain('🟢'); expect(permissionKeyboard({ photo: true, profanity: false }).find(x => x.key === 'profanity').label).toContain('🔴'); });
  it('renders a user summary', () => { const text = adminUserSummary({ telegram_id: 12, gender: 'male', coins: 8, status: 'chatting' }, { total_chats: 2 }, { isPlus: false }); expect(text).toContain('آیدی عددی: 12'); expect(text).toContain('tg://user?id=12'); expect(text).toContain('تعداد چت‌ها: 2'); });
});
