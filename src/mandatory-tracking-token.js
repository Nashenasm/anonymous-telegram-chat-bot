import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

function keyFromSecret(secret) {
  if (typeof secret !== 'string' || secret.length < 16) return null;
  return createHash('sha256').update(secret, 'utf8').digest();
}

export function encryptMandatoryTrackingUserId(telegramId, secret) {
  const id = String(telegramId ?? '');
  const key = keyFromSecret(secret);
  if (!key || !/^\d{1,20}$/.test(id)) return null;
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const encrypted = Buffer.concat([cipher.update(id, 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString('base64url');
}

export function decryptMandatoryTrackingUserId(token, secret) {
  const key = keyFromSecret(secret);
  if (!key || typeof token !== 'string' || !/^[A-Za-z0-9_-]{39,100}$/.test(token)) return null;
  try {
    const payload = Buffer.from(token, 'base64url');
    if (payload.length < 29) return null;
    const decipher = createDecipheriv('aes-256-gcm', key, payload.subarray(0, 12));
    decipher.setAuthTag(payload.subarray(12, 28));
    const id = Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]).toString('utf8');
    return /^\d{1,20}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}
