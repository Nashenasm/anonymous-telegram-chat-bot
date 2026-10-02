import { runCryptoDepositScan } from './webhook.js';
import { isMandatoryJobsAuthorized } from './mandatory-jobs.js';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  if (!isMandatoryJobsAuthorized(req, process.env.CRON_SECRET || '')) return res.status(401).json({ ok: false, error: 'unauthorized' });
  try {
    const result = await runCryptoDepositScan();
    return res.status(200).json({ ok: true, ...result });
  } catch (error) {
    console.error('crypto_jobs_error', String(error?.message || error).slice(0, 300));
    return res.status(500).json({ ok: false, error: 'job_failed' });
  }
}
