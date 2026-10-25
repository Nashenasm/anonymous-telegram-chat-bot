import { describe, expect, it } from 'vitest';
import { applyInlineAppearance, inlineButtonKey, inlineSurfaceId, moveInlineButtonOrder, normalizeInlineAppearance, observeInlineKeyboard, recordInlineKeyboard } from '../src/inline-appearance.js';

const markup = { reply_markup: { inline_keyboard: [
  [{ text: 'Buy one month', callback_data: 'plus:buy:1' }, { text: 'Buy three months', callback_data: 'plus:buy:3' }],
  [{ text: 'Back', callback_data: 'plus:back' }],
] } };

describe('inline keyboard appearance', () => {
  it('creates stable action identities while preserving distinct small arguments', () => {
    expect(inlineButtonKey({ callback_data: 'admins:view:123456789' })).toBe('callback:admins:view:{id}');
    expect(inlineButtonKey({ callback_data: 'plus:buy:1' })).not.toBe(inlineButtonKey({ callback_data: 'plus:buy:3' }));
  });

  it('captures the observed inline surface without storing message text or raw action payloads separately', () => {
    const observation = observeInlineKeyboard(markup);
    expect(observation.group).toBe('plus');
    expect(observation.buttons.map(item => item.label)).toEqual(['Buy one month', 'Buy three months', 'Back']);
    expect(observation.screenId).toHaveLength(20);
    expect(observation.editableMessage).toBe(false);
    expect(observation).not.toHaveProperty('message');
  });

  it('records catalog entries and caps stored layout/action data to valid shapes', () => {
    const next = recordInlineKeyboard(null, observeInlineKeyboard(markup));
    expect(next.changed).toBe(true);
    expect(Object.keys(next.catalog.buttons)).toHaveLength(3);
    expect(next.catalog.screens[inlineSurfaceId(markup.reply_markup.inline_keyboard)].rows).toHaveLength(2);
    expect(normalizeInlineAppearance({ buttons: { x: { style: 'invalid' } } }).buttons).toEqual({});
  });

  it('changes only presentation and layout while preserving callback action identifiers', () => {
    const screenId = inlineSurfaceId(markup.reply_markup.inline_keyboard);
    const config = normalizeInlineAppearance({
      buttons: {
        'callback:plus:buy:1': { label: 'Single month', style: 'success', icon_custom_emoji_id: '5368324170671202286' },
        'callback:plus:buy:3': { enabled: false },
      },
      screens: { [screenId]: { layout: 'single', order: ['callback:plus:back', 'callback:plus:buy:1'] } },
    });
    const result = applyInlineAppearance(markup, config);
    expect(result.markup.reply_markup.inline_keyboard).toEqual([
      [{ text: 'Back', callback_data: 'plus:back' }],
      [{ text: 'Single month', callback_data: 'plus:buy:1', style: 'success', icon_custom_emoji_id: '5368324170671202286' }],
    ]);
    expect(result.markup.reply_markup.inline_keyboard.flat().map(button => button.callback_data)).toEqual(['plus:back', 'plus:buy:1']);
  });

  it('allows screen message overrides only for observed non-protected pages', () => {
    const safeRows = [[{ text: 'Choose', callback_data: 'idea:option:1' }]];
    const safeId = inlineSurfaceId(safeRows);
    const safeMarkup = { reply_markup: { inline_keyboard: safeRows } };
    const sourceText = 'Choose an idea';
    const sourceSignature = observeInlineKeyboard(safeMarkup, sourceText).sourceTextSignature;
    const safeConfig = { screens: { [safeId]: { message: 'Edited page copy' } }, catalog: { screens: { [safeId]: { group: 'idea', editableMessage: true, sourceTextSignature: sourceSignature } } } };
    expect(applyInlineAppearance(safeMarkup, safeConfig, sourceText).message).toBe('Edited page copy');
    expect(applyInlineAppearance(safeMarkup, safeConfig, 'Your selection was saved').message).toBeNull();

    const protectedId = inlineSurfaceId(markup.reply_markup.inline_keyboard);
    const protectedSignature = observeInlineKeyboard(markup, 'Purchase details').sourceTextSignature;
    const protectedConfig = { screens: { [protectedId]: { message: 'Hide pricing' } }, catalog: { screens: { [protectedId]: { group: 'plus', editableMessage: false, sourceTextSignature: protectedSignature } } } };
    expect(applyInlineAppearance(markup, protectedConfig, 'Purchase details').message).toBeNull();
  });

  it('preserves valid premium emoji entities in safe page text and drops invalid entity ranges', () => {
    const rows = [[{ text: 'Choose', callback_data: 'idea:option:1' }]];
    const screenId = inlineSurfaceId(rows);
    const sourceText = 'Choose an idea';
    const signature = observeInlineKeyboard({ inline_keyboard: rows }, sourceText).sourceTextSignature;
    const config = normalizeInlineAppearance({
      screens: { [screenId]: { message: 'Hello 🔥', messageEntities: [
        { type: 'custom_emoji', offset: 6, length: 2, custom_emoji_id: '5368324170671202286' },
        { type: 'custom_emoji', offset: 99, length: 2, custom_emoji_id: '5368324170671202286' },
      ] } },
      catalog: { screens: { [screenId]: { group: 'idea', editableMessage: true, sourceTextSignature: signature } } },
    });
    const result = applyInlineAppearance({ inline_keyboard: rows }, config, sourceText);
    expect(result.message).toBe('Hello 🔥');
    expect(result.messageEntities).toEqual([{ type: 'custom_emoji', offset: 6, length: 2, custom_emoji_id: '5368324170671202286' }]);
    expect(result.messageEntities).toEqual(config.screens[screenId].messageEntities);
    expect(applyInlineAppearance({ inline_keyboard: rows }, config, 'Your selection was saved').messageEntities).toBeNull();
  });

  it('moves items without changing the underlying callback action', () => {
    expect(moveInlineButtonOrder(['a', 'b', 'c'], 'b', 'down')).toEqual(['a', 'c', 'b']);
    expect(moveInlineButtonOrder(['a', 'b', 'c'], 'a', 'up')).toEqual(['a', 'b', 'c']);
  });
});


describe('privacy-safe inline identities', () => {
  it('groups URL buttons by public path and never relies on query tokens', () => {
    const a = inlineButtonKey({ url: 'https://bot.example/game?room=one&token=secret-a' });
    const b = inlineButtonKey({ url: 'https://bot.example/game?room=two&token=secret-b' });
    expect(a).toBe(b);
    expect(a).not.toContain('secret');
  });
});
