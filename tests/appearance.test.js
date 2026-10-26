import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { APPEARANCE_TEMPLATES, appearanceItems, appearanceKeyboard, captureCustomEmojiEntities, feedbackMessagePayload, joinTextPayloads, normalizeAppearance, screenKeyboard, screenMessagePayload, setAppearanceMessageSource, setAppearancePath, templateAppearance, templateIdFromText } from '../src/appearance.js';

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
    expect(appearanceKeyboard(appearance)).toEqual([[{ text: 'Talk', icon_custom_emoji_id: '5368324170671202286', style: 'success' }], ['اتصال به مخاطب خاص']]);
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

  it('copies configured response posts from Telegram and clears stale sources on text edits', () => {
    const appearance = normalizeAppearance('public', {
      screens: { preference: { message: 'کپشن', message_source: { chat_id: 12345, message_id: 456 }, feedback: { connected: 'پاسخ', connected_source: { chat_id: 12345, message_id: 458 }, connected_entities: [] } } },
      feedback: { waiting: 'متن پاسخ', waiting_source: { chat_id: 12345, message_id: 457 } },
    });
    expect(screenMessagePayload(appearance, 'preference', 'fallback')).toEqual({ copy_message: { from_chat_id: 12345, message_id: 456 } });
    expect(feedbackMessagePayload(appearance, 'waiting', 'fallback')).toEqual({ copy_message: { from_chat_id: 12345, message_id: 457 } });
    expect(setAppearancePath(appearance, 'screens.preference.message', 'متن جدید').screens.preference.message_source).toBeUndefined();
    expect(setAppearancePath(appearance, 'feedback.waiting', 'پاسخ جدید').feedback.waiting_source).toBeUndefined();
    expect(appearanceItems('public', appearance).some(item => /_(entities|source)$/.test(item.path))).toBe(false);
  });

  it('preserves plus-screen copies and feedback copies passed through a screen fallback', () => {
    const appearance = normalizeAppearance('public', {
      screens: {
        plus: { message: '', message_source: { chat_id: 12345, message_id: 903 } },
        preference: { message: '' },
      },
      feedback: { connect_prompt: '', connect_prompt_source: { chat_id: 12345, message_id: 904 } },
    });
    expect(screenMessagePayload(appearance, 'plus', 'purchase fallback')).toEqual({ copy_message: { from_chat_id: 12345, message_id: 903 } });
    const feedback = feedbackMessagePayload(appearance, 'connect_prompt', 'connect fallback');
    expect(screenMessagePayload(appearance, 'preference', feedback)).toEqual({ copy_message: { from_chat_id: 12345, message_id: 904 } });
  });

  it('stores the source sent through the appearance editor, including media-only posts', () => {
    const base = normalizeAppearance('public', {
      screens: { preference: { message: '', feedback: { connected: '' } } },
      feedback: { waiting: '' },
    });
    const photoOnly = { chat: { id: 12345 }, message_id: 901, photo: [{ file_id: 'photo-file' }] };
    const edited = setAppearanceMessageSource(
      setAppearancePath(base, 'feedback.waiting', ''),
      'feedback.waiting',
      photoOnly,
    );
    expect(edited.feedback.waiting_source).toEqual({ chat_id: 12345, message_id: 901 });
    expect(feedbackMessagePayload(edited, 'waiting', 'fallback')).toEqual({ copy_message: { from_chat_id: 12345, message_id: 901 } });
    const screenEdited = setAppearanceMessageSource(
      setAppearancePath(base, 'screens.preference.message', 'کپشن'),
      'screens.preference.message',
      { chat: { id: 12345 }, message_id: 902, caption: 'کپشن', caption_entities: [{ type: 'bold', offset: 0, length: 5 }] },
    );
    expect(screenMessagePayload(screenEdited, 'preference', 'fallback')).toEqual({ copy_message: { from_chat_id: 12345, message_id: 902 } });
  });

  it('exposes custom-emoji, response-entity, and color controls in the admin editor', () => {
    expect(source).toContain("text: 'Icon✨'");
    expect(source).toContain("text: 'Style🎨'");
    expect(source).toContain('captureCustomEmojiEntities(incoming, responseText)');
    expect(source).toContain('target.parent[`${target.key}_source`] =');
    expect(source).toContain("telegram('copyMessage', copyBody)");
    expect(source).toContain('setAppearanceMessageSource(next, tail, incoming)');
    expect(source).toContain('handleAppearanceText(client, id, value, me.action_state, s, meta)');
    expect(source).toContain("screenMessagePayload(publicAppearance(s), 'plus'");
    expect(source).toContain("style === 'default'");
  });

  it('keeps technical tools owner-gated and visible as bot buttons', () => {
    expect(source).toContain("if (!isOwner(id)) return send(id, 'این بخش فقط برای مالک اصلی ربات فعال است.'");
    expect(source).toContain('فایل اوپن سورس');
    expect(source).toContain('بک آپ دیتابیس');
    expect(source).toContain('وضعیت سرور');
  });
});
