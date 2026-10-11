import crypto from 'node:crypto';

export const DUEL_GAMES = {
  ludo: { title: 'منچ', emoji: '🎲', shortName: 'ludo', aliases: [] },
  chess: { title: 'شطرنج', emoji: '♟️', shortName: 'chest_game', aliases: ['chest_play', 'chess_play'] },
  cards: { title: 'پاسور', emoji: '🂡', shortName: 'card', aliases: ['cards'] },
  truth: { title: 'حقیقت یا جرئت', emoji: '🎭', shortName: 'Truth_or_dare', aliases: ['truth_or_dare'] },
};

const MAX_CHAT_LENGTH = 300;
const ROOM_TTL_MINUTES = 120;
const LUDO_FINISH = 30;
const TRUTH_PROMPTS = [
  'حقیقت: آخرین چیزی که واقعاً خوشحالت کرد چه بود؟',
  'حقیقت: یک ویژگی خوب خودت که کمتر دیده می‌شود چیست؟',
  'حقیقت: اگر همین امروز می‌توانستی سفر کنی، کجا می‌رفتی؟',
  'جرئت: یک جملهٔ خلاقانه برای طرف مقابلت بنویس.',
  'جرئت: سه کلمه بگو که حال امروزی‌ات را توصیف کند.',
  'جرئت: یک تعریف صادقانه و محترمانه از طرف مقابلت بنویس.',
];

function roomId() { return crypto.randomBytes(12).toString('hex'); }
function accessToken() { return crypto.randomBytes(32).toString('base64url'); }
function playerSide(session, playerId) {
  const id = Number(playerId);
  if (Number(session.player_one) === id) return 'one';
  if (Number(session.player_two) === id) return 'two';
  return null;
}
function initialState(type, playerOne, playerTwo) {
  const current = Number(playerOne);
  if (type === 'ludo') return { positions: { [playerOne]: 0, [playerTwo]: 0 }, current, lastRoll: null, winner: null };
  if (type === 'chess') return { board: chessBoard(), current, winner: null, moves: 0 };
  if (type === 'cards') return { scores: { [playerOne]: 0, [playerTwo]: 0 }, current, round: 0, winner: null, lastCard: null };
  return { current, prompt: null, promptType: null, rounds: 0, winner: null };
}
function chessBoard() {
  const board = Array.from({ length: 8 }, () => Array(8).fill(null));
  const back = ['r', 'n', 'b', 'q', 'k', 'b', 'n', 'r'];
  board[0] = back.map(piece => `b${piece}`); board[1] = Array(8).fill('bp');
  board[6] = Array(8).fill('wp'); board[7] = back.map(piece => `w${piece}`);
  return board;
}
function safeState(state) { return JSON.parse(JSON.stringify(state)); }
function publicState(session, playerId, messages = []) {
  const side = playerSide(session, playerId);
  if (!side) return null;
  const state = session.state || {};
  const now = Date.now();
  const status = session.status === 'active' && session.ends_at && new Date(session.ends_at).getTime() <= now ? 'finished' : session.status;
  return {
    room: session.room_id, token: session.access_token, game: session.game_type,
    title: DUEL_GAMES[session.game_type]?.title || session.game_type,
    emoji: DUEL_GAMES[session.game_type]?.emoji || '🎮',
    player: Number(playerId), opponent: Number(session.player_one) === Number(playerId) ? Number(session.player_two) : Number(session.player_one),
    status, ready: side === 'one' ? Boolean(session.ready_one) : Boolean(session.ready_two),
    opponentReady: side === 'one' ? Boolean(session.ready_two) : Boolean(session.ready_one),
    state: safeState(state), messages: messages.map(row => ({ id: row.id, sender: Number(row.sender_id), text: row.text, createdAt: row.created_at })),
  };
}

export async function ensureDuelSchema(client) {
  await client.query(`CREATE TABLE IF NOT EXISTS duel_game_sessions (
    room_id TEXT PRIMARY KEY, access_token TEXT NOT NULL, game_type TEXT NOT NULL,
    player_one BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
    player_two BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
    ready_one BOOLEAN NOT NULL DEFAULT FALSE, ready_two BOOLEAN NOT NULL DEFAULT FALSE,
    status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','active','finished','cancelled')),
    state JSONB NOT NULL DEFAULT '{}'::jsonb, winner BIGINT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), ends_at TIMESTAMPTZ,
    CHECK (player_one <> player_two), CHECK (game_type IN ('ludo','chess','cards','truth'))
  )`);
  await client.query(`CREATE TABLE IF NOT EXISTS duel_game_messages (
    id BIGSERIAL PRIMARY KEY, room_id TEXT NOT NULL REFERENCES duel_game_sessions(room_id) ON DELETE CASCADE,
    sender_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE, text TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await client.query('CREATE INDEX IF NOT EXISTS duel_game_sessions_players_idx ON duel_game_sessions(player_one, player_two, status, created_at DESC)');
  await client.query('CREATE INDEX IF NOT EXISTS duel_game_messages_room_idx ON duel_game_messages(room_id, id DESC)');
}

export async function createDuelSession(pool, gameType, playerOne, playerTwo) {
  if (!DUEL_GAMES[gameType]) throw new Error('invalid_game');
  const client = await pool.connect();
  try {
    await client.query('BEGIN'); await ensureDuelSchema(client);
    await client.query("UPDATE duel_game_sessions SET status='cancelled', updated_at=NOW() WHERE status IN ('waiting','active') AND (player_one IN ($1,$2) OR player_two IN ($1,$2))", [playerOne, playerTwo]);
    const row = (await client.query(`INSERT INTO duel_game_sessions(room_id,access_token,game_type,player_one,player_two,state) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`, [roomId(), accessToken(), gameType, playerOne, playerTwo, JSON.stringify(initialState(gameType, playerOne, playerTwo))])).rows[0];
    await client.query('COMMIT'); return row;
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

async function loadSession(pool, room, token) { return (await pool.query('SELECT * FROM duel_game_sessions WHERE room_id=$1 AND access_token=$2 AND created_at > NOW() - (($3::text || \' minutes\')::interval)', [room, token, ROOM_TTL_MINUTES])).rows[0] || null; }
async function loadMessages(pool, room) { return (await pool.query('SELECT id,sender_id,text,created_at FROM duel_game_messages WHERE room_id=$1 ORDER BY id DESC LIMIT 60', [room])).rows.reverse(); }

export async function latestDuelSession(pool, playerId, gameType = null) {
  const params = [playerId]; const where = ["$1 IN (player_one,player_two)", "status IN ('waiting','active')", "created_at > NOW() - INTERVAL '120 minutes'"];
  if (gameType) { params.push(gameType); where.push(`game_type=$${params.length}`); }
  return (await pool.query(`SELECT * FROM duel_game_sessions WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT 1`, params)).rows[0] || null;
}

function assertActive(session, playerId) { if (!session || !playerSide(session, playerId)) throw new Error('session_not_found'); if (session.status !== 'active') throw new Error('game_not_active'); }
function otherPlayer(session, id) { return Number(session.player_one) === Number(id) ? Number(session.player_two) : Number(session.player_one); }
function setWinner(state, session, winner) { state.winner = Number(winner); session.winner = Number(winner); session.status = 'finished'; }
function ludoMove(state, session, playerId) {
  if (Number(state.current) !== Number(playerId)) throw new Error('not_your_turn');
  const roll = crypto.randomInt(1, 7); const current = Number(state.positions[playerId] || 0); const next = Math.min(LUDO_FINISH, current + roll);
  state.lastRoll = roll; state.positions[playerId] = next;
  if (next >= LUDO_FINISH) setWinner(state, session, playerId); else state.current = otherPlayer(session, playerId);
}
function chessMove(state, session, playerId, payload) {
  if (Number(state.current) !== Number(playerId)) throw new Error('not_your_turn');
  const from = payload?.from || {}; const to = payload?.to || {};
  const valid = [from.row, from.col, to.row, to.col].every(Number.isInteger) && [from.row, from.col, to.row, to.col].every(x => x >= 0 && x < 8);
  if (!valid) throw new Error('invalid_move');
  const piece = state.board[from.row][from.col]; if (!piece || (Number(playerId) === Number(session.player_one) ? !piece.startsWith('w') : !piece.startsWith('b'))) throw new Error('invalid_move');
  const target = state.board[to.row][to.col]; if (target && target[0] === piece[0]) throw new Error('invalid_move');
  const distance = Math.max(Math.abs(to.row - from.row), Math.abs(to.col - from.col)); if (!distance || distance > 2) throw new Error('invalid_move');
  state.board[to.row][to.col] = piece; state.board[from.row][from.col] = null; state.moves += 1; if (target?.[1] === 'k') setWinner(state, session, playerId); else state.current = otherPlayer(session, playerId);
}
function cardMove(state, session, playerId) {
  if (Number(state.current) !== Number(playerId)) throw new Error('not_your_turn');
  const card = crypto.randomInt(1, 14); state.lastCard = card; state.scores[playerId] = Number(state.scores[playerId] || 0) + card; state.round += 1;
  if (state.round >= 10) { const a = state.scores[session.player_one]; const b = state.scores[session.player_two]; setWinner(state, session, a === b ? null : (a > b ? session.player_one : session.player_two)); } else state.current = otherPlayer(session, playerId);
}
function truthMove(state, session, playerId, payload) {
  if (Number(state.current) !== Number(playerId)) throw new Error('not_your_turn');
  if (!state.prompt) { const index = crypto.randomInt(0, TRUTH_PROMPTS.length); state.prompt = TRUTH_PROMPTS[index]; state.promptType = index < 3 ? 'حقیقت' : 'جرئت'; }
  else { state.prompt = null; state.promptType = null; state.rounds += 1; if (state.rounds >= 6) setWinner(state, session, null); else state.current = otherPlayer(session, playerId); }
  if (payload?.prompt && !state.prompt) state.prompt = String(payload.prompt).slice(0, 220);
}

export async function duelState(pool, room, token, playerId) { const session = await loadSession(pool, room, token); if (!session) return null; return publicState(session, playerId, await loadMessages(pool, room)); }
export async function duelAction(pool, room, token, playerId, action, payload = {}) {
  if (action === 'chat') {
    const session = await loadSession(pool, room, token); if (!session || !playerSide(session, playerId)) return null;
    const text = String(payload.text || '').trim().slice(0, MAX_CHAT_LENGTH); if (!text) throw new Error('empty_message');
    await pool.query('INSERT INTO duel_game_messages(room_id,sender_id,text) VALUES($1,$2,$3)', [room, playerId, text]);
    return duelState(pool, room, token, playerId);
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN'); const session = (await client.query('SELECT * FROM duel_game_sessions WHERE room_id=$1 AND access_token=$2 FOR UPDATE', [room, token])).rows[0];
    if (!session || !playerSide(session, playerId)) { await client.query('ROLLBACK'); return null; }
    if (action === 'ready') { const column = Number(playerId) === Number(session.player_one) ? 'ready_one' : 'ready_two'; const otherReady = Number(playerId) === Number(session.player_one) ? session.ready_two : session.ready_one; const active = Boolean(otherReady); await client.query(`UPDATE duel_game_sessions SET ${column}=TRUE,status=CASE WHEN $2 THEN 'active' ELSE status END,ends_at=CASE WHEN $2 THEN NOW()+INTERVAL '2 hours' ELSE ends_at END,updated_at=NOW() WHERE room_id=$1`, [room, active]); }
    else if (action === 'leave') await client.query("UPDATE duel_game_sessions SET status='cancelled',updated_at=NOW() WHERE room_id=$1", [room]);
    else { assertActive(session, playerId); const state = session.state || {}; if (session.game_type === 'ludo' && action === 'move') ludoMove(state, session, playerId); else if (session.game_type === 'chess' && action === 'move') chessMove(state, session, playerId, payload); else if (session.game_type === 'cards' && action === 'draw') cardMove(state, session, playerId); else if (session.game_type === 'truth' && action === 'truth') truthMove(state, session, playerId, payload); else throw new Error('invalid_action'); await client.query('UPDATE duel_game_sessions SET state=$2::jsonb,status=$3,winner=$4,updated_at=NOW() WHERE room_id=$1', [room, JSON.stringify(state), session.status, session.winner]); }
    await client.query('COMMIT'); return duelState(pool, room, token, playerId);
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
