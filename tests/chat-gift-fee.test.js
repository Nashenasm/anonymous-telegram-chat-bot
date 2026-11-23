import { describe, expect, it } from 'vitest';
import { chatGiftFee } from '../api/webhook.js';

describe('chat gift fee', () => {
  it('charges one coin through 50 and two coins from 51 through 100', () => {
    expect(chatGiftFee(1, 2)).toBe(1);
    expect(chatGiftFee(50, 2)).toBe(1);
    expect(chatGiftFee(51, 2)).toBe(2);
    expect(chatGiftFee(100, 2)).toBe(2);
  });

  it('uses the configured percentage above 100 and rounds upward', () => {
    expect(chatGiftFee(1000, 2)).toBe(20);
    expect(chatGiftFee(735, 2)).toBe(15);
    expect(chatGiftFee(1001, 0.5)).toBe(6);
  });

  it('supports zero percentage for large gifts', () => {
    expect(chatGiftFee(1000, 0)).toBe(0);
  });
});
