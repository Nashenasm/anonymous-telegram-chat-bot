import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { observeInlineKeyboard, recordInlineKeyboard } from '../src/inline-appearance.js';
import { inlineEditorButtonKey, inlineEditorButtonKeyboard, inlineEditorButtonText, inlineEditorGroupKeyboard, inlineEditorGroups, inlineEditorNestedKeyboard, inlineEditorOrder, inlineEditorRootKeyboard, inlineEditorScreenKeyboard, inlineEditorStyleKeyboard } from '../src/inline-appearance-editor.js';

function catalog(...keyboards) {
  return keyboards.reduce((config, keyboard) => recordInlineKeyboard(config, observeInlineKeyboard(keyboard)), null);
}

describe('inline appearance editor', () => {
  it('groups discovered pages and lets admins drill down into page button selections', () => {
    const markup = { inline_keyboard: [[{ text: 'Option A', callback_data: 'idea:option:1' }, { text: 'Option B', callback_data: 'idea:option:2' }], [{ text: 'Back', callback_data: 'idea:back' }]] };
    const config = catalog(markup);
    expect(inlineEditorGroups(config)).toEqual([{ name: 'idea', count: 1 }]);
    expect(inlineEditorRootKeyboard(config).reply_markup.inline_keyboard[0][0].callback_data).toBe('inlinecfg:group:0');
    const screenId = Object.keys(config.catalog.screens)[0];
    expect(inlineEditorGroupKeyboard(config, 'idea').reply_markup.inline_keyboard[0][0].callback_data).toBe(`inlinecfg:screen:${screenId}`);
    expect(inlineEditorScreenKeyboard(config, screenId).reply_markup.inline_keyboard[0][0].callback_data).toBe(`inlinecfg:pick:${screenId}:0`);
  });

  it('exposes the requested name, icon, style, toggle, move, and nested controls', () => {
    const first = { inline_keyboard: [[{ text: 'Buy', callback_data: 'plus:buy:1' }, { text: 'Back', callback_data: 'plus:back' }]] };
    const second = { inline_keyboard: [[{ text: 'Confirm', callback_data: 'plus:confirm' }]] };
    const config = catalog(first, second);
    const screenId = Object.keys(config.catalog.screens).find(id => config.catalog.screens[id].rows.flat().includes('callback:plus:buy:1'));
    const controls = inlineEditorButtonKeyboard(config, screenId, 0).reply_markup.inline_keyboard.flat().map(button => button.text);
    expect(controls.join(' ')).toContain('Name');
    expect(controls.join(' ')).toContain('Icon');
    expect(controls.join(' ')).toContain('Style');
    expect(controls.join(' ')).toContain('خاموش');
    expect(controls.join(' ')).toContain('صفحه‌های هم‌گروه');
    expect(inlineEditorNestedKeyboard(config, screenId, 0).reply_markup.inline_keyboard).toHaveLength(2);
    expect(inlineEditorStyleKeyboard(screenId, 0).reply_markup.inline_keyboard.flat().some(button => button.style === 'success')).toBe(true);
  });

  it('shows editable page-copy controls only for non-transactional pages', () => {
    const safe = recordInlineKeyboard(null, observeInlineKeyboard({ inline_keyboard: [[{ text: 'Choose', callback_data: 'idea:option:1' }]] }, 'Choose an idea'));
    const safeId = Object.keys(safe.catalog.screens)[0];
    expect(inlineEditorScreenKeyboard(safe, safeId).reply_markup.inline_keyboard.flat().some(button => button.text === 'متن همین صفحه')).toBe(true);

    const protectedConfig = recordInlineKeyboard(null, observeInlineKeyboard({ inline_keyboard: [[{ text: 'Buy', callback_data: 'coins:buy' }]] }, 'Purchase details'));
    const protectedId = Object.keys(protectedConfig.catalog.screens)[0];
    expect(inlineEditorScreenKeyboard(protectedConfig, protectedId).reply_markup.inline_keyboard.flat().some(button => button.text === 'متن همین صفحه')).toBe(false);
  });

  it('keeps selection aligned with the saved order', () => {
    const config = catalog({ inline_keyboard: [[{ text: 'A', callback_data: 'idea:a' }, { text: 'B', callback_data: 'idea:b' }]] });
    const screenId = Object.keys(config.catalog.screens)[0];
    config.screens[screenId] = { order: ['callback:idea:b', 'callback:idea:a'] };
    expect(inlineEditorOrder(config, screenId)).toEqual(['callback:idea:b', 'callback:idea:a']);
    expect(inlineEditorButtonKey(config, screenId, 0)).toBe('callback:idea:b');
    expect(inlineEditorButtonText(config, screenId, 0)).toContain('B');
  });
});


describe('inline editor webhook integration', () => {
  const webhook = readFileSync(new URL('../api/webhook.js', import.meta.url), 'utf8');
  const runtime = readFileSync(new URL('../src/inline-appearance.js', import.meta.url), 'utf8');
  const editor = readFileSync(new URL('../src/inline-appearance-editor.js', import.meta.url), 'utf8');

  it('is embedded in the existing beauty editor, not a separate admin control entry', () => {
    expect(webhook).not.toContain("['ویرایش دکمه‌های شیشه‌ای']");
    expect(webhook).not.toContain("if (value === 'ویرایش دکمه‌های شیشه‌ای')");
    expect(webhook).toContain("keyboardRows.push([{ text: 'دکمه‌های شیشه‌ای', callback_data: `beauty:${section}:inline:${path}` }]);");
    expect(webhook).toContain("if (action === 'inline')");
    expect(webhook).toContain("if (String(data || '').startsWith('inlinecfg:')) return handleInlineAppearanceCallback");
    expect(webhook).toContain("if (!isAdmin(id) || (!isOwner(id) && !hasAdminPermission(id, 'appearance')))");
    expect(webhook).toContain('inlineBeautyReturnOrigin(actionState)');
    expect(editor).toContain("callback('بازگشت', 'inlinecfg:back')");
    expect(runtime).toContain("const out = { ...button }");
    expect(runtime).toContain("return out;");
  });

  it('applies overrides at the Telegram send/edit boundary and preserves original text on other callback states', () => {
    expect(webhook).toContain('body = await prepareInlineTelegramBody(method, body)');
    expect(webhook).toContain('observeInlineKeyboard(body.reply_markup, body.text)');
    expect(webhook).toContain('applyInlineAppearance(body.reply_markup, config, body.text)');
    expect(webhook).toContain('prepared.entities = result.messageEntities');
    expect(webhook).toContain('captureCustomEmojiEntities(meta?.message, pageText)');
    expect(runtime).toContain('sourceTextSignature === sourceTextSignature(sourceText)');
  });
});
