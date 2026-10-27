import crypto from 'node:crypto';

const rooms = new Map();
const ROOM_TTL_MS = 10 * 60 * 1000;

function token() { return crypto.randomBytes(24).toString('base64url'); }
function roomId() { return crypto.randomBytes(12).toString('base64url'); }
function cleanup() {
  const now = Date.now();
  for (const [id, room] of rooms) if (room.expiresAt <= now) rooms.delete(id);
}
function getParticipant(room, suppliedToken) {
  if (!room || room.expiresAt <= Date.now()) return null;
  return room.participants.find(p => p.token === suppliedToken) || null;
}
export function createVoiceRoom(userA, userB) {
  cleanup();
  const room = { id: roomId(), expiresAt: Date.now() + ROOM_TTL_MS, participants: [
    { userId: Number(userA), token: token() },
    { userId: Number(userB), token: token() },
  ], signals: [] };
  rooms.set(room.id, room);
  return room;
}
export function voiceRoomUrl(room, participant) {
  const caller = Number(participant.userId) === Math.min(...room.participants.map(p => Number(p.userId))) ? '1' : '0';
  return `https://bot.manochat.xyz/voice-call.html?room=${encodeURIComponent(room.id)}&token=${encodeURIComponent(participant.token)}&caller=${caller}`;
}
export function voiceSignal({ method, query = {}, body = {} }, res) {
  cleanup();
  const id = String(query.room || body.room || '');
  const suppliedToken = String(query.token || body.token || '');
  const room = rooms.get(id);
  const participant = getParticipant(room, suppliedToken);
  if (!participant) return json(res, 401, { ok: false, error: 'voice_room_invalid' });
  if (method === 'GET') {
    const after = Number(query.after || 0);
    const messages = room.signals.filter(x => x.seq > after && x.from !== participant.userId).slice(-40);
    return json(res, 200, { ok: true, seq: room.signals.at(-1)?.seq || after, messages });
  }
  if (method !== 'POST') return json(res, 405, { ok: false, error: 'method_not_allowed' });
  const type = String(body.type || '');
  if (type === 'leave') { room.expiresAt = Date.now(); rooms.delete(id); return json(res, 200, { ok: true }); }
  if (!['offer', 'answer', 'ice', 'ready'].includes(type)) return json(res, 400, { ok: false, error: 'invalid_signal' });
  const data = body.data == null ? null : body.data;
  if (JSON.stringify(data).length > 120000) return json(res, 413, { ok: false, error: 'signal_too_large' });
  room.signals.push({ seq: (room.signals.at(-1)?.seq || 0) + 1, from: participant.userId, type, data });
  if (room.signals.length > 200) room.signals.splice(0, room.signals.length - 200);
  return json(res, 200, { ok: true, seq: room.signals.at(-1).seq });
}
function json(res, status, value) { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); return res.end(JSON.stringify(value)); }
