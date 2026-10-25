import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { APPEARANCE_TEMPLATES, appearanceItems, appearanceKeyboard, captureCustomEmojiEntities, feedbackMessagePayload, joinTextPayloads, normalizeAppearance, screenKeyboard, screenMessagePayload, setAppearancePath, templateAppearance, templateIdFromText } from '../src/appearance.js';

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

  it('renders Telegram custom emoji icons and the supported button styles', () => {
    const appearance = normalizeAppearance('public', {
      buttons: [[{ id: 'connect', label: 'Talk', icon_custom_emoji_id: '5368324170671202286', style: 'success' }]],
      screens: { preference: { buttons: [{ id: 'male', label: 'Man', style: 'primary' }] } },
    });
    expect(appearanceKeyboard(appearance)).toEqual([[{ text: 'Talk', icon_custom_emoji_id: '5368324170671202286', style: 'success' }]]);
    expect(screenKeyboard(appearance, 'preference')).toEqual([[{ text: 'Man', style: 'primary' }]]);
    expect(appearanceKeyboard(normalizeAppearance('public', null))[0][0]).toBe('وصل کن به ناشناس');
  });

  it('captures custom emoji entities after trimming and shifts offsets when combining response text', () => {
    const message = { text: '  😀 سلام', entities: [{ type: 'custom_emoji', offset: 2, length: 2, custom_emoji_id: '12345' }] };
    const entities = captureCustomEmojiEntities(message, message.text.trim());
    expect(entities).toEqual([{ type: 'custom_emoji', offset: 0, length: 2, custom_emoji_id: '12345' }]);
    const combined = joinTextPayloads([{ text: '😀 اول', entities }, { text: '😀 دوم', entities: [{ ...entities[0], offset: 0 }] }], '\n');
    expect(combined.text).toBe('😀 اول\n😀 دوم');
    expect(combined.entities.map(entity => entity.offset)).toEqual([0, 7]);
  });

  it('returns saved custom emoji entities alongside screen and feedback text', () => {
    const appearance = normalizeAppearance('public', {
      screens: { preference: { message: '😀 انتخاب کن', message_entities: [{ type: 'custom_emoji', offset: 0, length: 2, custom_emoji_id: '456' }] } },
      feedback: { waiting: '😀 منتظر بمان', waiting_entities: [{ type: 'custom_emoji', offset: 0, length: 2, custom_emoji_id: '789' }] },
    });
    expect(screenMessagePayload(appearance, 'preference', 'fallback')).toEqual({ text: '😀 انتخاب کن', entities: [{ type: 'custom_emoji', offset: 0, length: 2, custom_emoji_id: '456' }] });
    expect(feedbackMessagePayload(appearance, 'waiting', 'fallback').entities[0].custom_emoji_id).toBe('789');
  });

  it('uses the editable public plus response instead of bypassing it with hard-coded text', () => {
    const sendPlus = source.match(/async function sendPlus\(id, settings\) \{[\s\S]*?\n\}/)?.[0] || '';
    expect(sendPlus).toContain("feedbackMessagePayload(publicAppearance(settings), 'plus', fallback)");
    expect(sendPlus).toContain('plusPurchaseKeyboard()');
    expect(sendPlus).not.toContain('send(id, text, plusPurchaseKeyboard())');
  });

  it('exposes custom-emoji, response-entity, and color controls in the admin editor', () => {
    expect(source).toContain("text: 'Icon✨'");
    expect(source).toContain("text: 'Style🎨'");
    expect(source).toContain('captureCustomEmojiEntities(meta.message, responseText)');
    expect(source).toContain("style === 'default'");
  });

  it('keeps technical tools owner-gated and visible as bot buttons', () => {
    expect(source).toContain("if (!isOwner(id)) return send(id, 'این بخش فقط برای مالک اصلی ربات فعال است.'");
    expect(source).toContain('فایل اوپن سورس');
    expect(source).toContain('بک آپ دیتابیس');
    expect(source).toContain('وضعیت سرور');
  });
});
