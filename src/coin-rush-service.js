import crypto from 'node:crypto';

const ROOM_TTL_MINUTES = 20;
const GAME_SECONDS = 30;

export async function ensureCoinRushSchema(client) {
  await client.query(`CREATE TABLE IF NOT EXISTS coin_rush_sessions (
    room_id TEXT PRIMARY KEY,
    access_token TEXT NOT NULL,
    player_one BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
    player_two BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
    ready_one BOOLEAN NOT NULL DEFAULT FALSE,
    ready_two BOOLEAN NOT NULL DEFAULT FALSE,
    status TEXT NOT NULL DEFAULT 'waiting' CHECK(status IN ('waiting','active','finished','cancelled')),
    start_at TIMESTAMPTZ,
    ends_at TIMESTAMPTZ,
    score_one INTEGER NOT NULL DEFAULT 0,
    score_two INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK(player_one <> player_two)
  )`);
  await client.query('CREATE INDEX IF NOT EXISTS coin_rush_player_idx ON coin_rush_sessions(player_one, player_two, status, created_at DESC)');
}

function newRoomId() { return crypto.randomBytes(10).toString('hex'); }
function newToken() { return crypto.randomBytes(24).toString('base64url'); }

export async function createCoinRushSession(pool, playerOne, playerTwo) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureCoinRushSchema(client);
    await client.query("UPDATE coin_rush_sessions SET status='cancelled', updated_at=NOW() WHERE status IN ('waiting','active') AND (player_one IN ($1,$2) OR player_two IN ($1,$2))", [playerOne, playerTwo]);
    const row = (await client.query(
      `INSERT INTO coin_rush_sessions(room_id,access_token,player_one,player_two)
       VALUES($1,$2,$3,$4) RETURNING room_id,access_token,player_one,player_two,status`,
      [newRoomId(), newToken(), playerOne, playerTwo],
    )).rows[0];
    await client.query('COMMIT');
    return row;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

export async function latestCoinRushSession(pool, playerId) {
  const result = await pool.query(
    `SELECT * FROM coin_rush_sessions
     WHERE $1 IN (player_one, player_two) AND status IN ('waiting','active')
       AND created_at > NOW() - (($2::text || ' minutes')::interval)
     ORDER BY created_at DESC LIMIT 1`, [playerId, ROOM_TTL_MINUTES],
  );
  return result.rows[0] || null;
}

function playerColumn(session, playerId) {
  if (Number(session.player_one) === Number(playerId)) return { ready: 'ready_one', score: 'score_one' };
  if (Number(session.player_two) === Number(playerId)) return { ready: 'ready_two', score: 'score_two' };
  return null;
}

function stateFor(session, playerId) {
  const side = playerColumn(session, playerId);
  if (!side) return null;
  const now = Date.now();
  const start = session.start_at ? new Date(session.start_at).getTime() : null;
  const end = session.ends_at ? new Date(session.ends_at).getTime() : null;
  let status = session.status;
  if (status === 'active' && end && now >= end) status = 'finished';
  return {
    room: session.room_id,
    player: Number(playerId) === Number(session.player_one) ? 'one' : 'two',
    opponentPresent: true,
    ready: Boolean(session[side.ready]),
    opponentReady: Boolean(session[Number(playerId) === Number(session.player_one) ? 'ready_two' : 'ready_one']),
    status,
    startAt: start,
    endsAt: end,
    countdownMs: start ? Math.max(0, start - now) : null,
    remainingMs: end ? Math.max(0, end - now) : null,
    score: Number(session[side.score] || 0),
    opponentScore: Number(session[Number(playerId) === Number(session.player_one) ? 'score_two' : 'score_one'] || 0),
    gameSeconds: GAME_SECONDS,
  };
}

export async function coinRushState(pool, room, token, playerId) {
  const result = await pool.query('SELECT * FROM coin_rush_sessions WHERE room_id=$1 AND access_token=$2', [room, token]);
  const session = result.rows[0];
  if (!session) return null;
  return stateFor(session, playerId);
}

export async function coinRushAction(pool, room, token, playerId, action) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query('SELECT * FROM coin_rush_sessions WHERE room_id=$1 AND access_token=$2 FOR UPDATE', [room, token]);
    const session = result.rows[0];
    if (!session) { await client.query('ROLLBACK'); return null; }
    const side = playerColumn(session, playerId);
    if (!side) { await client.query('ROLLBACK'); return null; }
    if (action === 'ready') {
      const otherReady = Number(playerId) === Number(session.player_one) ? session.ready_two : session.ready_one;
      const bothReady = Boolean(otherReady);
      if (bothReady && session.status === 'waiting') {
        await client.query(`UPDATE coin_rush_sessions SET ${side.ready}=TRUE,status='active',start_at=NOW()+INTERVAL '3 seconds',ends_at=NOW()+INTERVAL '33 seconds',updated_at=NOW() WHERE room_id=$1`, [room]);
      } else {
        await client.query(`UPDATE coin_rush_sessions SET ${side.ready}=TRUE,updated_at=NOW() WHERE room_id=$1`, [room]);
      }
    } else if (action === 'hit') {
      if (session.status !== 'active' || !session.start_at || new Date(session.start_at).getTime() > Date.now() || (session.ends_at && new Date(session.ends_at).getTime() <= Date.now())) {
        await client.query('ROLLBACK');
        return stateFor(session, playerId);
      }
      await client.query(`UPDATE coin_rush_sessions SET ${side.score}=${side.score}+1,updated_at=NOW() WHERE room_id=$1`, [room]);
    } else if (action === 'leave') {
      await client.query("UPDATE coin_rush_sessions SET status='cancelled',updated_at=NOW() WHERE room_id=$1", [room]);
    }
    const updated = (await client.query('SELECT * FROM coin_rush_sessions WHERE room_id=$1', [room])).rows[0];
    await client.query('COMMIT');
    return stateFor(updated, playerId);
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

export function coinRushResult(state) {
  if (!state || state.status !== 'finished') return null;
  if (state.score === state.opponentScore) return 'draw';
  return state.score > state.opponentScore ? 'win' : 'lose';
}
