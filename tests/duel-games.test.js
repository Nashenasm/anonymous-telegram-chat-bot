import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { createDuelSession, DUEL_GAMES, LUDO_COLOR_OFFSETS } from '../src/duel-game-service.js';

describe('mid-chat duel games', () => {
  it('defines four BotFather game identities', () => {
    expect(Object.keys(DUEL_GAMES)).toEqual(['ludo', 'chess', 'cards', 'truth']);
    expect(new Set(Object.values(DUEL_GAMES).map(game => game.shortName)).size).toBe(4);
  });


  it('keeps Ludo board homes fixed and matches a player to their own color', () => {
    const page = fs.readFileSync(new URL('../game/duel.html', import.meta.url), 'utf8');
    expect(page).toContain("if(r<5&&col<5)cls+='home-red '");
    expect(page).toContain("if(r<5&&col>9)cls+='home-yellow '");
    expect(page).toContain("if(r>9&&col<5)cls+='home-green '");
    expect(page).toContain("if(r>9&&col>9)cls+='home-blue '");
    expect(page).toContain('home-slot-${pl.colorKey}');
    expect(page).toContain('color:ludoColor(myColorKey).color');
    expect(page).toContain('--turn-color:${activeColor}');
    expect(LUDO_COLOR_OFFSETS).toEqual({ red: 0, yellow: 13, blue: 26, green: 39 });
    expect(page).toContain('const from=Number(st.positions[s.player]?.[Number(x.dataset.piece)]??-1),to=from<0?0:from+roll');
  });
  it('assigns two distinct fixed palette colors to Ludo players', async () => {
    let savedState;
    const client = {
      async query(sql, params) {
        if (sql.includes('INSERT INTO duel_game_sessions')) {
          savedState = JSON.parse(params[5]);
          return { rows: [{ room_id: 'room', state: savedState }] };
        }
        return { rows: [] };
      },
      release() {},
    };
    await createDuelSession({ connect: async () => client }, 'ludo', 101, 202);
    const colors = Object.values(savedState.playerColors);
    expect(colors).toHaveLength(2);
    expect(new Set(colors).size).toBe(2);
    expect(colors.every(color => Object.hasOwn(LUDO_COLOR_OFFSETS, color))).toBe(true);
    expect(savedState.positions['101']).toEqual([-1, -1, -1, -1]);
    expect(savedState.positions['202']).toEqual([-1, -1, -1, -1]);
  });
  it('keeps the shared game room and chat endpoints wired', () => {
    const server = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
    const webhook = fs.readFileSync(new URL('../api/webhook.js', import.meta.url), 'utf8');
    const page = fs.readFileSync(new URL('../game/duel.html', import.meta.url), 'utf8');
    expect(server).toContain('/api/game/');
    expect(webhook).toContain('createDuelSession');
    expect(webhook).toContain('game_short_name: gameShortName');
    expect(page).toContain('/api/game/action');
    expect(page).toContain('گفت‌وگوی داخل بازی');
  });
});
