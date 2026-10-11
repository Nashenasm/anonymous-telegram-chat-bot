import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { DUEL_GAMES } from '../src/duel-game-service.js';

describe('mid-chat duel games', () => {
  it('defines four BotFather game identities', () => {
    expect(Object.keys(DUEL_GAMES)).toEqual(['ludo', 'chess', 'cards', 'truth']);
    expect(new Set(Object.values(DUEL_GAMES).map(game => game.shortName)).size).toBe(4);
  });

  it('keeps the shared game room and chat endpoints wired', () => {
    const server = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
    const webhook = fs.readFileSync(new URL('../api/webhook.js', import.meta.url), 'utf8');
    const page = fs.readFileSync(new URL('../game/duel.html', import.meta.url), 'utf8');
    expect(server).toContain('/api/game/');
    expect(webhook).toContain('createDuelSession');
    expect(webhook).toContain('game_short_name: game.shortName');
    expect(page).toContain('/api/game/action');
    expect(page).toContain('گفت‌وگوی داخل بازی');
  });
});
