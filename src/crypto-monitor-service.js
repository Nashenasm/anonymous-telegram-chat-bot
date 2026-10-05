import { applyCoinDelta } from './finance-ledger.js';

const USDT_TRC20_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const TRONGRID_BASE = process.env.TRONGRID_BASE_URL || 'https://api.trongrid.io';

function toTokenAmount(value, decimals = 6) {
  const raw = String(value ?? '0').replace(/^0+(?=\d)/, '');
  if (!/^\d+$/.test(raw)) return null;
  if (decimals === 0) return raw;
  const padded = raw.padStart(decimals + 1, '0');
  const split = padded.length - decimals;
  return `${padded.slice(0, split)}.${padded.slice(split)}`.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}

async function getJson(url, apiKey) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { accept: 'application/json', ...(apiKey ? { 'TRON-PRO-API-KEY': apiKey } : {}) }, signal: AbortSignal.timeout(15_000) });
      if (response.status === 429 || response.status === 403) { await new Promise(r => setTimeout(r, 500 * (2 ** attempt))); lastError = new Error(`TronGrid rate limited: ${response.status}`); continue; }
      if (!response.ok) throw new Error(`TronGrid HTTP ${response.status}`);
      return await response.json();
    } catch (error) { lastError = error; if (attempt < 2) await new Promise(r => setTimeout(r, 500 * (2 ** attempt))); }
  }
  throw lastError || new Error('TronGrid request failed');
}

function isSupportedWallet(wallet) {
  return wallet.enabled && wallet.monitor_enabled === true && (wallet.network === 'TRON' || wallet.network === 'TRC20' || wallet.network === 'TRON/TRC20') && (wallet.asset === 'USDT_TRC20' || wallet.asset === 'USDT' || wallet.asset === 'USDT-TRC20');
}

async function creditMatchedOrder(client, { transfer, wallet, amount, raw, confirmations }) {
  await client.query('BEGIN');
  try {
    const orderResult = await client.query(`SELECT order_id,user_id,amount,metadata FROM payment_orders
      WHERE status='pending' AND currency='USDT-TRC20' AND provider='tron'
        AND (metadata->>'wallet_id')=$1 AND (metadata->>'amount_usdt')::numeric=$2
        AND (metadata->>'expires_at')::timestamptz > NOW() FOR UPDATE`, [String(wallet.id), amount]);
    const order = orderResult.rows[0];
    if (!order) { await client.query('ROLLBACK'); return { matched: false }; }
    const entry = await applyCoinDelta(client, { userId: order.user_id, delta: Number(order.amount), kind: 'purchase', idempotencyKey: `crypto:${transfer.transaction_id}`, metadata: { orderId: order.order_id, txid: transfer.transaction_id, asset: 'USDT-TRC20', amount_usdt: amount } });
    await client.query(`INSERT INTO crypto_deposits(order_id,telegram_id,wallet_id,asset,txid,from_address,to_address,amount,confirmations,status,raw,credited_at)
      VALUES ($1,$2,$3,'USDT_TRC20',$4,$5,$6,$7,$8,'credited',$9::jsonb,NOW()) ON CONFLICT (txid) DO NOTHING`, [order.order_id, order.user_id, wallet.id, transfer.transaction_id, transfer.from || null, transfer.to, amount, confirmations, JSON.stringify({ ...raw, order_id: order.order_id, ledger: entry })]);
    await client.query("UPDATE payment_orders SET status='paid',provider_reference=$2,paid_at=NOW() WHERE order_id=$1 AND status='pending'", [order.order_id, transfer.transaction_id]);
    await client.query('COMMIT');
    return { matched: true, order, entry };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
}

export async function scanTronUsdtDeposits({ pool, getSetting, report, onPurchaseCredited }) {
  const monitorEnabled = await getSetting('crypto_monitor_enabled', 'false');
  if (monitorEnabled !== 'true') return { mode: 'detect-only', scanned: 0, inserted: 0, credited: 0, skipped: 'crypto_monitor_enabled=false' };
  const autoCredit = await getSetting('crypto_auto_credit', 'false') === 'true';
  const apiKey = process.env.TRONGRID_API_KEY || process.env.TRON_API_KEY || '';
  const monitorStartedAt = Number(await getSetting('crypto_monitor_started_at', '0')) || 0;
  const requiredConfirmations = Number(await getSetting('crypto_confirmations', '20')) || 20;
  const wallets = (await pool.query("SELECT id,asset,name,address,network,enabled,monitor_enabled FROM crypto_wallets WHERE enabled=TRUE AND asset IN ('USDT_TRC20','USDT','USDT-TRC20') AND network IN ('TRON','TRC20','TRON/TRC20') ORDER BY id")).rows;
  let scanned = 0; let inserted = 0; let credited = 0; const errors = [];
  for (const wallet of wallets.filter(isSupportedWallet)) {
    try {
      const url = new URL(`${TRONGRID_BASE}/v1/accounts/${encodeURIComponent(wallet.address)}/transactions/trc20`);
      url.searchParams.set('limit', '200'); url.searchParams.set('only_confirmed', 'true'); url.searchParams.set('contract_address', USDT_TRC20_CONTRACT);
      const payload = await getJson(url, apiKey); const transfers = Array.isArray(payload.data) ? payload.data : []; scanned += transfers.length;
      for (const transfer of transfers) {
        if (monitorStartedAt && Number(transfer.block_timestamp || 0) < monitorStartedAt) continue;
        const txid = String(transfer.transaction_id || transfer.txID || '').trim(); const toAddress = String(transfer.to || '').trim(); const contract = String(transfer.token_info?.address || '').trim(); const amount = toTokenAmount(transfer.value, Number(transfer.token_info?.decimals ?? 6));
        if (!txid || toAddress !== wallet.address || contract !== USDT_TRC20_CONTRACT || !amount) continue;
        const raw = { source: 'trongrid', monitor_mode: autoCredit ? 'auto-credit' : 'detect-only', token_contract: contract, block_timestamp: transfer.block_timestamp || null, token_info: transfer.token_info || null };
        if (autoCredit) {
          const client = await pool.connect();
          let result;
          try { result = await creditMatchedOrder(client, { transfer, wallet, amount, raw, confirmations: requiredConfirmations }); } finally { client.release(); }
          if (result.matched) { credited += 1; if (onPurchaseCredited) { try { await onPurchaseCredited({ userId: result.order.user_id, order: result.order, entry: result.entry, transfer, wallet, amount }); } catch (error) { errors.push(`referral:${String(error?.message || error)}`); } } if (report) await report({ type: 'credited', order: result.order, entry: result.entry, transfer, wallet, amount, confirmations: requiredConfirmations, raw }); continue; }
        }
        const result = await pool.query(`INSERT INTO crypto_deposits(wallet_id,asset,txid,from_address,to_address,amount,confirmations,status,raw)
          VALUES ($1,'USDT_TRC20',$2,$3,$4,$5,$6,'detected',$7::jsonb) ON CONFLICT (txid) DO NOTHING RETURNING id`, [wallet.id, txid, transfer.from || null, toAddress, amount, requiredConfirmations, JSON.stringify(raw)]);
        if (!result.rowCount) continue; inserted += 1;
        if (report) await report({ type: 'detected', transfer, wallet, amount, confirmations: requiredConfirmations, raw, autoCredit });
      }
    } catch (error) { errors.push({ wallet_id: wallet.id, message: String(error?.message || error).slice(0, 180) }); }
  }
  return { mode: autoCredit ? 'auto-credit' : 'detect-only', network: 'TRON', asset: 'USDT-TRC20', wallets: wallets.length, scanned, inserted, credited, errors };
}
