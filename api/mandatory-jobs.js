import crypto from 'node:crypto';
import { runMandatoryLifecycle, runReferralTimeRewards } from './webhook.js';

function authorized(req, secret) {
  const supplied = String(req.headers?.authorization || '');
  const expected = `Bearer ${secret}`;
  const suppliedBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expected);
  return suppliedBytes.length === expectedBytes.length && crypto.timingSafeEqual(suppliedBytes, expectedBytes);
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  const secret = process.env.CRON_SECRET || '';
  if (Buffer.byteLength(secret) < 32) return res.status(503).json({ ok: false, error: 'scheduler_not_configured' });
  if (!authorized(req, secret)) return res.status(401).json({ ok: false, error: 'unauthorized' });

  try {
    const result = await runMandatoryLifecycle();
    const referralTime = await runReferralTimeRewards();
    return res.status(200).json({ ok: true, ...result, referralTime });
  } catch (error) {
    console.error('mandatory_jobs_error', String(error?.message || error).slice(0, 300));
    return res.status(500).json({ ok: false, error: 'job_failed' });
  }
}

export { authorized as isMandatoryJobsAuthorized };
