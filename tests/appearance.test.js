import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { APPEARANCE_TEMPLATES, appearanceItems, appearanceKeyboard, normalizeAppearance, setAppearancePath, templateAppearance, templateIdFromText } from '../src/appearance.js';

const source = fs.readFileSync(new URL('../api/webhook.js', import.meta.url), 'utf8');

describe('appearance configuration', () => {
  it('provides the current default plus three independent templates', () => {
    expect(Object.keys(APPEARANCE_TEMPLATES)).toEqual(['default', 'luxury', 'halloween', 'friendly']);
    expect(templateAppearance('default', 'public').buttons[0][0].label).toBe('وصل کن به ناشناس');
    expect(templateAppearance('luxury', 'private').title).toContain('لوکس');
  });

  it('supports template selection, nested edits, and keyboard layouts', () => {
    const base = normalizeAppearance('public', null);
    expect(templateIdFromText('2')).toBe('luxury');
    expect(templateIdFromText('فرندلی')).toBe('friendly');
    const edited = setAppearancePath(base, 'feedback.connected', 'وصل شدی رفیق!');
    expect(edited.feedback.connected).toBe('وصل شدی رفیق!');
    expect(appearanceKeyboard({ ...base, layout: 'single' })[0]).toHaveLength(1);
    expect(appearanceKeyboard({ ...base, layout: 'columns2' })[0]).toHaveLength(2);
    expect(appearanceItems('public', base).some(item => item.path === 'feedback.connected')).toBe(true);
  });

  it('keeps technical tools owner-gated and visible as bot buttons', () => {
    expect(source).toContain("if (!isOwner(id)) return send(id, 'این بخش فقط برای مالک اصلی ربات فعال است.'");
    expect(source).toContain('فایل اوپن سورس');
    expect(source).toContain('بک آپ دیتابیس');
    expect(source).toContain('وضعیت سرور');
  });
});
