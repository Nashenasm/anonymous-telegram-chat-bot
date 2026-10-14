import crypto from 'node:crypto';

export const DUEL_GAMES = {
  ludo: { title: 'منچ', emoji: '🎲', shortName: 'ludo', aliases: [] },
  chess: { title: 'شطرنج', emoji: '♟️', shortName: 'chest_game', aliases: ['chest_play', 'chess_play'] },
  cards: { title: 'پاسور', emoji: '🂡', shortName: 'card', aliases: ['cards'] },
  truth: { title: 'حقیقت یا جرئت', emoji: '🎭', shortName: 'Truth_or_dare', aliases: ['truth_or_dare'] },
};

const MAX_CHAT_LENGTH = 300;
const ROOM_TTL_MINUTES = 120;
const LUDO_FINISH = 57;
const LUDO_SAFE_TRACK = [0, 8, 13, 21, 26, 34, 39, 47];
const TRUTH_BANKS = {
  truth: {
    pg: ['امروز بابت چه چیزی واقعاً خوشحالی؟', 'چه مهارتی را دوست داری یاد بگیری؟', 'بهترین خاطره‌ات از یک دوست چیست؟', 'اگر یک روز آزاد کامل داشتی چه می‌کردی؟', 'کدام ویژگی خودت را بیشتر دوست داری؟', 'آخرین چیزی که باعث خنده‌ات شد چه بود؟', 'دوست داری مردم تو را با چه ویژگی‌ای به یاد بیاورند؟', 'چه غذایی را هیچ‌وقت خسته نمی‌شوی بخوری؟', 'اگر می‌توانستی به گذشته یک توصیه بدهی چه می‌گفتی؟', 'یک هدف کوچک این ماهت چیست؟'],
    pg13: ['آخرین باری که از گفتن حقیقت خجالت کشیدی کی بود؟', 'عجیب‌ترین عادتت چیست؟', 'تا حالا برای رسیدن به چیزی نظرت را کاملاً عوض کرده‌ای؟', 'کدام تصمیم کوچک زندگی‌ات نتیجه بزرگی داشت؟', 'اگر قرار بود یک نفر را برای سفر انتخاب کنی چه کسی بود؟', 'بامزه‌ترین سوتی‌ای که داده‌ای چه بوده؟', 'چه چیزی سریع حالت را بهتر می‌کند؟', 'کدام فیلم یا سریال را مخفیانه چند بار دیده‌ای؟', 'اگر یک هفته جای شخص دیگری بودی چه کسی را انتخاب می‌کردی؟', 'بزرگ‌ترین ریسکی که تا امروز کرده‌ای چه بوده؟'],
    adult: ['با رضایت همه، صمیمی‌ترین ویژگی شخصیتی جذابت چیست؟', 'چه چیزی باعث می‌شود در یک رابطه احساس امنیت و اعتماد کنی؟', 'یک قرار ایده‌آل و صمیمی برای تو چه شکلی است؟', 'کدام تعریف محترمانه بیشتر از همه روی تو اثر می‌گذارد؟', 'یک مرز مهم که دوست داری دیگران همیشه رعایت کنند چیست؟', 'چه نوع توجهی بیشتر از همه تو را تحت‌تأثیر قرار می‌دهد؟', 'چه چیزی باعث می‌شود یک گفت‌وگوی صمیمی برایت لذت‌بخش باشد؟', 'یک ویژگی غیرظاهری که برایت جذاب است چیست؟', 'تا حالا به کسی علاقه داشته‌ای اما آن را پنهان کرده‌ای؟ چرا؟', 'چه چیزی برایت نشانهٔ یک شیمی واقعی بین دو نفر است؟', 'کدام رفتار رمانتیک می‌تواند خیلی سریع تو را هیجان‌زده و خوشحال کند؟', 'اگر بخواهی یک راز کوچک دربارهٔ سلیقهٔ عاطفی‌ات بگویی، چیست؟', 'چه نوع پیامی از یک فرد مورد علاقه‌ات می‌تواند لبخند روی لبت بیاورد؟', 'بزرگ‌ترین چراغ قرمزی که در یک رابطه نادیده گرفته‌ای چه بوده؟', 'چه چیزی باعث می‌شود به یک نفر بیشتر اعتماد کنی؟', 'اگر قرار باشد یک قرار شبانهٔ ایده‌آل طراحی کنی، چه سه چیز در آن می‌گذاری؟', 'کدام ویژگی در صدای یک نفر برایت جذاب است؟', 'چه نوع تعریف صمیمی اما محترمانه‌ای دوست داری بشنوی؟', 'تا حالا برای جلب توجه کسی کاری کرده‌ای که بعداً خنده‌ات بگیرد؟', 'چه چیزی برایت جذاب‌تر است: شوخ‌طبعی، اعتمادبه‌نفس یا مهربانی؟ چرا؟', 'اگر می‌توانستی یک سوال صمیمی از طرف مقابل بپرسی، چه می‌پرسیدی؟', 'کدام خاطرهٔ رمانتیک هنوز تو را خوشحال می‌کند؟', 'چه چیزی می‌تواند یک لحظهٔ معمولی را برایت به یک لحظهٔ خاص تبدیل کند؟', 'در یک رابطه، ترجیح می‌دهی احساسات را مستقیم بگویی یا با رفتار نشان بدهی؟', 'کدام نوع نگاه یا زبان بدن برایت جذاب‌تر است؟', 'اگر طرف مقابلت بخواهد تو را غافلگیر کند، چه سورپرایزی را دوست داری؟', 'چه چیزی باعث می‌شود یک نفر از نظر عاطفی برایت دست‌نیافتنی یا جذاب‌تر به نظر برسد؟', 'تا حالا شده از ترس جواب منفی، احساس واقعی‌ات را نگویی؟', 'کدام ویژگی باعث می‌شود یک آشنایی ساده به علاقه تبدیل شود؟', 'در صمیمیت، چه چیزی برایت مهم‌تر است: هیجان، آرامش یا اعتماد؟', 'اگر بخواهی یک قانون طلایی برای رابطه سالم تعریف کنی، چیست؟', 'چه نوع دعوتی برای یک قرار، تو را بیشتر جذب می‌کند؟', 'کدام خاطره یا آهنگ برایت حس رمانتیک خاصی دارد؟', 'آیا تا حالا به کسی فرصت دوباره داده‌ای و نتیجه‌اش چه شد؟', 'جسورانه‌ترین کاری که برای ابراز علاقه انجام داده‌ای چه بوده؟', 'چه چیزی باعث می‌شود کنار یک نفر خود واقعی‌ات باشی؟']
  },
  dare: {
    pg: ['با سه کلمه یک شعار خنده‌دار برای خودت بساز.', 'یک جمله را مثل گوینده اخبار اجرا کن.', 'برای طرف مقابل یک تعریف واقعی و محترمانه بنویس.', '۲۰ ثانیه بدون خندیدن به یک نقطه نگاه کن.', 'یک اسم مستعار خلاقانه برای خودت انتخاب کن.', 'یک داستان کوتاه سه‌جمله‌ای بساز.', 'با سه ایموجی حال امروزت را توضیح بده.', 'یک آهنگ را فقط با هوم‌هوم اجرا کن.', 'برای دور بعد یک قانون بامزه پیشنهاد بده.', 'یک پیام انگیزشی کوتاه برای طرف مقابل بفرست.'],
    pg13: ['یک خاطره خنده‌دار را با لحن نمایشی تعریف کن.', '۳۰ ثانیه با یک لحن غیرعادی صحبت کن.', 'یک تبلیغ خلاقانه برای اولین وسیله نزدیکت بساز.', 'بدون استفاده از کلمه «من» سه جمله درباره خودت بگو.', 'یک حرکت رقص کوتاه و بی‌خطر اجرا کن.', 'یک لقب دوستانه برای طرف مقابل بساز و دلیلش را بگو.', 'یک جمله سخت را سه بار سریع و درست بگو.', 'داستانی را که طرف مقابل انتخاب می‌کند در ۲۰ ثانیه تعریف کن.', 'یک دیالوگ فیلم را با لحن کاملاً متفاوت اجرا کن.', 'برای نوبت بعد یک چالش محترمانه و قابل انجام طراحی کن.'],
    adult: ['با رضایت طرف مقابل یک تعریف رمانتیک و محترمانه از او بگو.', 'یک پیام کوتاه و صمیمی اما محترمانه برای طرف مقابل بنویس.', 'با رضایت همه، یک ژست رمانتیک کوتاه و بامزه اجرا کن.', 'یک قرار صمیمی و کم‌هزینه برای طرف مقابل طراحی کن.', 'سه کلمه بگو که برایت حال‌وهوای رمانتیک دارند.', 'با رضایت طرف مقابل، یک جملهٔ عاشقانه را نمایشی اجرا کن.', 'یک مرز مهم در صمیمیت را با احترام توضیح بده.', 'یک چالش رمانتیک غیرجنسی و قابل‌ردکردن برای دور بعد پیشنهاد کن.']
  }
};
function truthPrompt(mode = 'tod', rating = 'pg13', history = []) {
  const types = mode === 'truth' ? ['truth'] : mode === 'dare' ? ['dare'] : ['truth', 'dare'];
  const candidates = types.flatMap(type => (TRUTH_BANKS[type][rating] || TRUTH_BANKS[type].pg13).map(text => ({ type, text })));
  const fresh = candidates.filter(item => !history.includes(item.text)); const pool = fresh.length ? fresh : candidates;
  return pool[crypto.randomInt(0, pool.length)];
}

function roomId() { return crypto.randomBytes(12).toString('hex'); }
function accessToken() { return crypto.randomBytes(32).toString('base64url'); }
function playerSide(session, playerId) {
  const id = Number(playerId);
  if (Number(session.player_one) === id) return 'one';
  if (Number(session.player_two) === id) return 'two';
  return null;
}
function initialState(type, playerOne, playerTwo) {
  const current = type === 'ludo' ? (crypto.randomInt(0, 2) === 0 ? Number(playerOne) : Number(playerTwo)) : Number(playerOne);
  if (type === 'ludo') { const palette = ['red', 'blue', 'yellow', 'green']; const first = palette[crypto.randomInt(0, palette.length)]; const remaining = palette.filter(color => color !== first); const second = remaining[crypto.randomInt(0, remaining.length)]; const colors = { [playerOne]: first, [playerTwo]: second }; return { positions: { [playerOne]: [-1, -1, -1, -1], [playerTwo]: [-1, -1, -1, -1] }, playerColors: colors, current, lastRoll: null, pendingRoll: null, moves: 0, winner: null }; }
  if (type === 'chess') return { board: chessBoard(), current, winner: null, moves: 0 };
  if (type === 'truth') return { current, prompt: null, promptType: null, rounds: 0, winner: null, mode: 'tod', rating: 'pg13', history: [], lastAction: null };
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
function chessMoveAllowed(board, from, to) {
  const piece = board[from.row]?.[from.col]; const target = board[to.row]?.[to.col];
  if (!piece || (target && target[0] === piece[0])) return false;
  const dr = to.row - from.row; const dc = to.col - from.col; const adr = Math.abs(dr); const adc = Math.abs(dc); const kind = piece[1]; const forward = piece[0] === 'w' ? -1 : 1;
  if (!adr && !adc) return false;
  if (kind === 'p') return (dc === 0 && !target && (dr === forward || (dr === 2 * forward && from.row === (piece[0] === 'w' ? 6 : 1) && !board[from.row + forward][from.col]))) || (adc === 1 && dr === forward && Boolean(target));
  if (kind === 'n') return (adr === 2 && adc === 1) || (adr === 1 && adc === 2);
  if (kind === 'k') return adr <= 1 && adc <= 1;
  const straight = dr === 0 || dc === 0; const diagonal = adr === adc; let legal = kind === 'r' ? straight : kind === 'b' ? diagonal : straight || diagonal;
  if (!legal) return false;
  const sr = Math.sign(dr); const sc = Math.sign(dc);
  for (let r = from.row + sr, c = from.col + sc; r !== to.row || c !== to.col; r += sr, c += sc) if (board[r][c]) legal = false;
  return legal;
}
function availableChessMoves(session, state, playerId) {
  if (Number(state.current) !== Number(playerId)) return {};
  const color = Number(session.player_one) === Number(playerId) ? 'w' : 'b'; const moves = {};
  for (let row = 0; row < 8; row++) for (let col = 0; col < 8; col++) if (state.board[row][col]?.[0] === color) {
    const key = `${row},${col}`; moves[key] = [];
    for (let toRow = 0; toRow < 8; toRow++) for (let toCol = 0; toCol < 8; toCol++) if (chessMoveAllowed(state.board, { row, col }, { row: toRow, col: toCol })) moves[key].push([toRow, toCol]);
  }
  return moves;
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
    player: Number(playerId), side, opponent: Number(session.player_one) === Number(playerId) ? Number(session.player_two) : Number(session.player_one),
    status, ready: side === 'one' ? Boolean(session.ready_one) : Boolean(session.ready_two),
    opponentReady: side === 'one' ? Boolean(session.ready_two) : Boolean(session.ready_one),
    state: safeState(state), legalMoves: session.game_type === 'chess' ? availableChessMoves(session, state, playerId) : {}, messages: messages.map(row => ({ id: row.id, sender: Number(row.sender_id), text: row.text, createdAt: row.created_at })),
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
function setWinner(state, session, winner) { state.winner = winner == null ? null : Number(winner); session.winner = state.winner; session.status = 'finished'; }
function normalizeLudoPieces(state, playerId) {
  const raw = state.positions?.[playerId];
  const pieces = Array.isArray(raw) ? raw : [Number(raw || -1), -1, -1, -1];
  state.positions ||= {};
  state.positions[playerId] = Array.from({ length: 4 }, (_, index) => {
    const value = Number(pieces[index]); return Number.isFinite(value) ? Math.max(-1, Math.min(LUDO_FINISH, value)) : -1;
  });
  return state.positions[playerId];
}
const LUDO_COLOR_OFFSETS = { red: 0, yellow: 13, blue: 26, green: 39 };
function ludoPlayerOffset(state, session, playerId) { const color = state?.playerColors?.[String(playerId)]; return LUDO_COLOR_OFFSETS[color] ?? (Number(session.player_one) === Number(playerId) ? 0 : 26); }
function ludoTrackIndex(state, session, playerId, position) { return (position + ludoPlayerOffset(state, session, playerId)) % 52; }
function ludoCanMove(piece, roll) { return piece >= 0 ? piece + roll <= LUDO_FINISH : roll === 6; }
function ludoRoll(state, session, playerId) {
  if (Number(state.current) !== Number(playerId)) throw new Error('not_your_turn');
  if (state.pendingRoll?.player === Number(playerId)) return;
  const pieces = normalizeLudoPieces(state, playerId); const roll = crypto.randomInt(1, 7);
  const canMove = pieces.some(position => ludoCanMove(position, roll));
  state.lastRoll = roll; state.lastRollBy = Number(playerId); state.rolls = Number(state.rolls || 0) + 1;
  if (!canMove) { state.pendingRoll = null; state.lastMove = { type: 'dead_roll', player: Number(playerId), roll }; if (roll !== 6) state.current = otherPlayer(session, playerId); return; }
  state.pendingRoll = { player: Number(playerId), roll };
  state.lastMove = { type: 'roll', player: Number(playerId), roll };
}
function ludoMove(state, session, playerId, payload = {}) {
  if (Number(state.current) !== Number(playerId)) throw new Error('not_your_turn');
  const pending = state.pendingRoll; if (!pending || Number(pending.player) !== Number(playerId)) throw new Error('roll_required');
  const pieceIndex = Number(payload.piece); if (!Number.isInteger(pieceIndex) || pieceIndex < 0 || pieceIndex > 3) throw new Error('invalid_move');
  const pieces = normalizeLudoPieces(state, playerId); const position = pieces[pieceIndex]; const roll = Number(pending.roll);
  if (!ludoCanMove(position, roll)) throw new Error('invalid_move');
  const from = position; if (position < 0) pieces[pieceIndex] = 0; else pieces[pieceIndex] = position + roll;
  const movedPosition = pieces[pieceIndex]; let captured = false; let reachedHome = movedPosition === LUDO_FINISH;
  if (movedPosition >= 0 && movedPosition < 52) {
    const landing = ludoTrackIndex(state, session, playerId, movedPosition); const safe = LUDO_SAFE_TRACK.includes(landing);
    if (!safe) for (const opponentId of [session.player_one, session.player_two].filter(id => Number(id) !== Number(playerId))) {
      const opponents = normalizeLudoPieces(state, opponentId);
      opponents.forEach((opponentPosition, index) => { if (opponentPosition >= 0 && opponentPosition < 52 && ludoTrackIndex(state, session, opponentId, opponentPosition) === landing) { opponents[index] = -1; captured = true; } });
    }
  }
  state.pendingRoll = null; state.lastPiece = pieceIndex; state.moves = Number(state.moves || 0) + 1;
  state.lastMove = { type: 'move', player: Number(playerId), piece: pieceIndex, from, to: movedPosition, roll, captured, reachedHome, safe: movedPosition >= 0 && movedPosition < 52 && LUDO_SAFE_TRACK.includes(ludoTrackIndex(state, session, playerId, movedPosition)) };
  if (pieces.every(piece => piece >= LUDO_FINISH)) setWinner(state, session, playerId);
  else if (roll !== 6 && !captured && !reachedHome) state.current = otherPlayer(session, playerId);
}
function chessMove(state, session, playerId, payload) {
  if (Number(state.current) !== Number(playerId)) throw new Error('not_your_turn');
  const rawFrom = payload?.from || {}; const rawTo = payload?.to || {};
  // Accept both the public row/col contract and the legacy browser r/c shape.
  const from = { row: rawFrom.row ?? rawFrom.r, col: rawFrom.col ?? rawFrom.c };
  const to = { row: rawTo.row ?? rawTo.r, col: rawTo.col ?? rawTo.c };
  const valid = [from.row, from.col, to.row, to.col].every(Number.isInteger) && [from.row, from.col, to.row, to.col].every(x => x >= 0 && x < 8);
  if (!valid) throw new Error('invalid_move');
  const piece = state.board[from.row][from.col]; if (!piece || (Number(playerId) === Number(session.player_one) ? !piece.startsWith('w') : !piece.startsWith('b'))) throw new Error('invalid_move');
  const target = state.board[to.row][to.col]; if (target && target[0] === piece[0]) throw new Error('invalid_move');
  const dr = to.row - from.row; const dc = to.col - from.col; const adr = Math.abs(dr); const adc = Math.abs(dc); const kind = piece[1];
  if (!adr && !adc) throw new Error('invalid_move');
  const forward = piece[0] === 'w' ? -1 : 1;
  let legal = false;
  if (kind === 'p') legal = (dc === 0 && !target && (dr === forward || (dr === 2 * forward && (from.row === (piece[0] === 'w' ? 6 : 1)) && !state.board[from.row + forward][from.col]))) || (adc === 1 && dr === forward && Boolean(target));
  else if (kind === 'n') legal = (adr === 2 && adc === 1) || (adr === 1 && adc === 2);
  else if (kind === 'k') legal = adr <= 1 && adc <= 1;
  else if (kind === 'r' || kind === 'b' || kind === 'q') {
    const straight = dr === 0 || dc === 0; const diagonal = adr === adc;
    legal = kind === 'r' ? straight : kind === 'b' ? diagonal : straight || diagonal;
    if (legal) { const sr = Math.sign(dr); const sc = Math.sign(dc); for (let r = from.row + sr, c = from.col + sc; r !== to.row || c !== to.col; r += sr, c += sc) if (state.board[r][c]) legal = false; }
  }
  if (!legal) throw new Error('invalid_move');
  state.board[to.row][to.col] = piece; state.board[from.row][from.col] = null; state.moves += 1; if (target?.[1] === 'k') setWinner(state, session, playerId); else state.current = otherPlayer(session, playerId);
}
function cardMove(state, session, playerId) {
  if (Number(state.current) !== Number(playerId)) throw new Error('not_your_turn');
  const card = crypto.randomInt(1, 14); state.lastCard = card; state.scores[playerId] = Number(state.scores[playerId] || 0) + card; state.round += 1;
  if (state.round >= 10) { const a = state.scores[session.player_one]; const b = state.scores[session.player_two]; setWinner(state, session, a === b ? null : (a > b ? session.player_one : session.player_two)); } else state.current = otherPlayer(session, playerId);
}
function truthMove(state, session, playerId, payload = {}) {
  if (Number(state.current) !== Number(playerId)) throw new Error('not_your_turn');
  const command = String(payload.command || 'start'); const mode = ['truth', 'dare', 'tod'].includes(payload.mode) ? payload.mode : (state.mode || 'tod'); const rating = ['pg', 'pg13', 'adult'].includes(payload.rating) ? payload.rating : (state.rating || 'pg13');
  state.mode = mode; state.rating = rating; state.history = Array.isArray(state.history) ? state.history : [];
  if (command === 'complete') {
    if (!state.prompt) throw new Error('no_prompt'); state.history.push(state.prompt); state.history = state.history.slice(-20); state.prompt = null; state.promptType = null; state.rounds = Number(state.rounds || 0) + 1;
    if (state.rounds >= 10) setWinner(state, session, null); else state.current = otherPlayer(session, playerId); return;
  }
  if (command === 'reroll' && !state.prompt) throw new Error('no_prompt');
  const picked = truthPrompt(mode, rating, state.history); state.prompt = picked.text; state.promptType = picked.type === 'truth' ? 'حقیقت' : 'جرئت'; state.lastAction = command; state.updatedAt = Date.now();
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
    else { assertActive(session, playerId); const state = session.state || {}; if (session.game_type === 'ludo' && action === 'roll') ludoRoll(state, session, playerId); else if (session.game_type === 'ludo' && action === 'move') ludoMove(state, session, playerId, payload); else if (session.game_type === 'chess' && action === 'move') chessMove(state, session, playerId, payload); else if (session.game_type === 'cards' && action === 'draw') cardMove(state, session, playerId); else if (session.game_type === 'truth' && action === 'truth') truthMove(state, session, playerId, payload); else throw new Error('invalid_action'); await client.query('UPDATE duel_game_sessions SET state=$2::jsonb,status=$3,winner=$4,updated_at=NOW() WHERE room_id=$1', [room, JSON.stringify(state), session.status, session.winner]); }
    await client.query('COMMIT'); return duelState(pool, room, token, playerId);
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
