export async function blockUser(pool, blockerId, blockedId) {
  if (blockerId == null || blockedId == null || String(blockerId) === String(blockedId)) return false;
  const result = await pool.query(
    'UPDATE users SET blocked_ids = blocked_ids || ARRAY[$2]::BIGINT[] WHERE telegram_id = $1 AND NOT ($2 = ANY(blocked_ids))',
    [blockerId, blockedId]
  );
  return result.rowCount > 0;
}

export async function isBlocked(pool, blockerId, blockedId) {
  if (blockerId == null || blockedId == null) return false;
  const result = await pool.query(
    'SELECT 1 FROM users WHERE telegram_id = $1 AND $2 = ANY(blocked_ids)',
    [blockerId, blockedId]
  );
  return result.rowCount > 0;
}

export async function createReport(pool, reporterId, targetId, reason = '') {
  const cleanReason = String(reason || '').trim().slice(0, 200) || 'unspecified';
  const result = await pool.query(
    "INSERT INTO reports (reporter_id, target_id, reason, status) VALUES ($1, $2, $3, 'open') RETURNING id",
    [reporterId, targetId ?? null, cleanReason]
  );
  return result.rows[0]?.id ?? null;
}

export async function deleteUser(pool, userId) {
  if (userId == null) return false;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM reports WHERE reporter_id = $1 OR target_id = $1', [userId]);
    await client.query('DELETE FROM anon_links WHERE telegram_id = $1', [userId]);
    await client.query('DELETE FROM users WHERE telegram_id = $1', [userId]);
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
