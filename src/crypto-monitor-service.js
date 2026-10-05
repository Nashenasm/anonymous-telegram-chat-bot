import { createHash } from 'node:crypto';
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
  return wallet.enabled && wallet.monitor_enabled === true && (wallet.network === 'TRON' || wallet.network === 'TRC20' || wallet.network === 'TRON/TRC20') && (wallet.asset === 'TRX' || wallet.asset === 'USDT_TRC20' || wallet.asset === 'USDT' || wallet.asset === 'USDT-TRC20');
}

function base58Encode(bytes) { const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'; let value = 0n; for (const byte of bytes) value = (value << 8n) + BigInt(byte); let out = ''; while (value > 0n) { out = alphabet[Number(value % 58n)] + out; value /= 58n; } for (const byte of bytes) { if (byte !== 0) break; out = `1${out}`; } return out; }
function tronAddressFromHex(value) { const hex = String(value || '').replace(/^0x/, '').toLowerCase(); if (!/^41[0-9a-f]{40}$/.test(hex)) return null; const payload = Buffer.from(hex, 'hex'); const checksum = createHash('sha256').update(createHash('sha256').update(payload).digest()).digest().subarray(0, 4); return base58Encode(Buffer.concat([payload, checksum])); }
function normalizeTrxTransfer(item) { const contract = item?.raw_data?.contract?.[0]; if (contract?.type !== 'TransferContract') return null; const value = contract.parameter?.value || {}; return { transaction_id: item.txID, block_timestamp: item.block_timestamp, from: tronAddressFromHex(value.owner_address), to: tronAddressFromHex(value.to_address), value: value.amount, decimals: 6, token_contract: null }; }
async function creditMatchedOrder(client, { transfer, wallet, amount, raw, confirmations }) {
  const isTrx = wallet.asset === 'TRX'; const currency = isTrx ? 'TRX' : 'USDT-TRC20'; const amountKey = isTrx ? 'amount_asset' : 'amount_usdt'; const depositAsset = isTrx ? 'TRX' : 'USDT_TRC20';
  await client.query('BEGIN');
  try {
    const orderResult = await client.query(`SELECT order_id,user_id,amount,metadata FROM payment_orders WHERE status='pending' AND currency=$1 AND provider='tron' AND (metadata->>'wallet_id')=$2 AND (metadata->>$3)::numeric=$4 AND (metadata->>'expires_at')::timestamptz > NOW() FOR UPDATE`, [currency, String(wallet.id), amountKey, amount]);
    const order = orderResult.rows[0]; if (!order) { await client.query('ROLLBACK'); return { matched: false }; }
    const entry = await applyCoinDelta(client, { userId: order.user_id, delta: Number(order.amount), kind: 'purchase', idempotencyKey: `crypto:${transfer.transaction_id}`, metadata: { orderId: order.order_id, txid: transfer.transaction_id, asset: depositAsset, amount } });
    await client.query(`INSERT INTO crypto_deposits(order_id,telegram_id,wallet_id,asset,txid,from_address,to_address,amount,confirmations,status,raw,credited_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'credited',$10::jsonb,NOW()) ON CONFLICT (txid) DO NOTHING`, [order.order_id, order.user_id, wallet.id, depositAsset, transfer.transaction_id, transfer.from || null, transfer.to, amount, confirmations, JSON.stringify({ ...raw, order_id: order.order_id, ledger: entry })]);
    await client.query("UPDATE payment_orders SET status='paid',provider_reference=$2,paid_at=NOW() WHERE order_id=$1 AND status='pending'", [order.order_id, transfer.transaction_id]); await client.query('COMMIT'); return { matched: true, order, entry };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
}

export async function scanTronUsdtDeposits({ pool, getSetting, report, onPurchaseCredited }) {
  const monitorEnabled = await getSetting('crypto_monitor_enabled', 'false'); if (monitorEnabled !== 'true') return { mode: 'detect-only', scanned: 0, inserted: 0, credited: 0, skipped: 'crypto_monitor_enabled=false' };
  const autoCredit = await getSetting('crypto_auto_credit', 'false') === 'true'; const apiKey = process.env.TRONGRID_API_KEY || process.env.TRON_API_KEY || ''; const monitorStartedAt = Number(await getSetting('crypto_monitor_started_at', '0')) || 0; const requiredConfirmations = Number(await getSetting('crypto_confirmations', '20')) || 20;
  const wallets = (await pool.query("SELECT id,asset,name,address,network,enabled,monitor_enabled FROM crypto_wallets WHERE enabled=TRUE AND monitor_enabled=TRUE AND asset IN ('TRX','USDT_TRC20','USDT','USDT-TRC20') AND network IN ('TRON','TRC20','TRON/TRC20') ORDER BY id")).rows;
  let scanned = 0; let inserted = 0; let credited = 0; const errors = [];
  for (const wallet of wallets.filter(isSupportedWallet)) {
    try {
      const url = new URL(`${TRONGRID_BASE}/v1/accounts/${encodeURIComponent(wallet.address)}/${wallet.asset === 'TRX' ? 'transactions' : 'transactions/trc20'}`); url.searchParams.set('limit', '200'); url.searchParams.set('only_confirmed', 'true'); if (wallet.asset !== 'TRX') url.searchParams.set('contract_address', USDT_TRC20_CONTRACT);
      const payload = await getJson(url, apiKey); const transfers = wallet.asset === 'TRX' ? (Array.isArray(payload.data) ? payload.data.map(normalizeTrxTransfer).filter(Boolean) : []) : (Array.isArray(payload.data) ? payload.data.map(x => ({ ...x, decimals: Number(x.token_info?.decimals ?? 6), token_contract: String(x.token_info?.address || '') })) : []); scanned += transfers.length;
      for (const transfer of transfers) {
        if (monitorStartedAt && Number(transfer.block_timestamp || 0) < monitorStartedAt) continue;
        const txid = String(transfer.transaction_id || transfer.txID || '').trim(); const toAddress = String(transfer.to || '').trim(); const contract = String(transfer.token_contract || transfer.token_info?.address || '').trim(); const amount = toTokenAmount(transfer.value, transfer.decimals);
        if (!txid || toAddress !== wallet.address || (wallet.asset !== 'TRX' && contract !== USDT_TRC20_CONTRACT) || !amount) continue;
        const raw = { source: 'trongrid', monitor_mode: autoCredit ? 'auto-credit' : 'detect-only', asset: wallet.asset, block_timestamp: transfer.block_timestamp || null, token_contract: contract || null };
        if (autoCredit) { const client = await pool.connect(); let result; try { result = await creditMatchedOrder(client, { transfer, wallet, amount, raw, confirmations: requiredConfirmations }); } finally { client.release(); } if (result.matched) { credited += 1; if (onPurchaseCredited) { try { await onPurchaseCredited({ userId: result.order.user_id, order: result.order, entry: result.entry, transfer, wallet, amount }); } catch (error) { errors.push(`referral:${String(error?.message || error)}`); } } if (report) await report({ type: 'credited', order: result.order, entry: result.entry, transfer, wallet, amount, confirmations: requiredConfirmations, raw }); continue; } }
        const asset = wallet.asset === 'TRX' ? 'TRX' : 'USDT_TRC20'; const result = await pool.query(`INSERT INTO crypto_deposits(wallet_id,asset,txid,from_address,to_address,amount,confirmations,status,raw) VALUES ($1,$2,$3,$4,$5,$6,$7,'detected',$8::jsonb) ON CONFLICT (txid) DO NOTHING RETURNING id`, [wallet.id, asset, txid, transfer.from || null, toAddress, amount, requiredConfirmations, JSON.stringify(raw)]); if (!result.rowCount) continue; inserted += 1; if (report) await report({ type: 'detected', transfer, wallet, amount, confirmations: requiredConfirmations, raw, autoCredit });
      }
    } catch (error) { errors.push({ wallet_id: wallet.id, message: String(error?.message || error).slice(0, 180) }); }
  }
  return { mode: autoCredit ? 'auto-credit' : 'detect-only', network: 'TRON', wallets: wallets.length, scanned, inserted, credited, errors };
}
