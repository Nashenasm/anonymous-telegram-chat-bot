import { Pool } from 'pg';
import type { Repository, UserState } from './types.js';

export class PostgresRepository implements Repository {
  constructor(private readonly pool: Pool) {}

  async getUser(id: number): Promise<UserState | null> {
    const r = await this.pool.query('SELECT telegram_id, status, partner_id, blocked_ids, last_action_at FROM users WHERE telegram_id=$1', [id]);
    if (!r.rows[0]) return null;
    return { telegramId: Number(r.rows[0].telegram_id), status: r.rows[0].status, partnerId: r.rows[0].partner_id ? Number(r.rows[0].partner_id) : null, blockedIds: (r.rows[0].blocked_ids ?? []).map(Number), lastActionAt: r.rows[0].last_action_at };
  }

  async upsertUser(id: number): Promise<UserState> {
    await this.pool.query('INSERT INTO users (telegram_id) VALUES ($1) ON CONFLICT (telegram_id) DO UPDATE SET updated_at=NOW()', [id]);
    return (await this.getUser(id))!;
  }

  async enqueue(id: number): Promise<number | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO users (telegram_id) VALUES ($1) ON CONFLICT DO NOTHING', [id]);
      const me = await client.query('SELECT blocked_ids FROM users WHERE telegram_id=$1 FOR UPDATE', [id]);
      const blocked: number[] = (me.rows[0]?.blocked_ids ?? []).map(Number);
      const candidate = await client.query(`SELECT telegram_id FROM users WHERE status='waiting' AND telegram_id<>$1 AND NOT (telegram_id = ANY($2::bigint[])) AND NOT ($1 = ANY(blocked_ids)) ORDER BY updated_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED`, [id, blocked]);
      if (!candidate.rows[0]) {
        await client.query("UPDATE users SET status='waiting', partner_id=NULL, updated_at=NOW() WHERE telegram_id=$1", [id]);
        await client.query('COMMIT');
        return null;
      }
      const other = Number(candidate.rows[0].telegram_id);
      await client.query("UPDATE users SET status='chatting', partner_id=$2, updated_at=NOW() WHERE telegram_id=$1", [id, other]);
      await client.query("UPDATE users SET status='chatting', partner_id=$2, updated_at=NOW() WHERE telegram_id=$1", [other, id]);
      await client.query('COMMIT');
      return other;
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  }

  async removeFromQueue(id: number): Promise<void> { await this.pool.query("UPDATE users SET status='idle', partner_id=NULL, updated_at=NOW() WHERE telegram_id=$1", [id]); }
  async pairUsers(a: number, b: number): Promise<void> { await this.pool.query("UPDATE users SET status='chatting', partner_id=CASE telegram_id WHEN $1 THEN $2 ELSE $1 END, updated_at=NOW() WHERE telegram_id IN ($1,$2)", [a,b]); }
  async getPartner(id: number): Promise<number | null> { const u=await this.getUser(id); return u?.partnerId ?? null; }
  async clearPair(id: number): Promise<number | null> { const p=await this.getPartner(id); await this.pool.query("UPDATE users SET status='idle', partner_id=NULL, updated_at=NOW() WHERE telegram_id=$1 OR partner_id=$1", [id]); return p; }
  async blockUser(id: number, blockedId: number): Promise<void> { await this.pool.query('UPDATE users SET blocked_ids=ARRAY(SELECT DISTINCT unnest(blocked_ids || $2::bigint[])), updated_at=NOW() WHERE telegram_id=$1', [id, [blockedId]]); }
  async isBlocked(id: number, otherId: number): Promise<boolean> { const r=await this.pool.query('SELECT $2 = ANY(blocked_ids) AS blocked FROM users WHERE telegram_id=$1', [id, otherId]); return Boolean(r.rows[0]?.blocked); }
  async markAction(id: number): Promise<void> { await this.pool.query('UPDATE users SET last_action_at=NOW(), updated_at=NOW() WHERE telegram_id=$1', [id]); }
}
