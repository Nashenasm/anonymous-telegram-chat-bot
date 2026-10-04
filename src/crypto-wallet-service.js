export const WALLET_ASSETS = Object.freeze({
  TRX: 'TRX',
  USDT_TRC20: 'USDT-TRC20',
});

export function walletAssetLabel(asset) {
  return asset === 'USDT_TRC20' ? 'USDT-TRC20' : String(asset || 'نامشخص');
}

export function normalizeWalletAsset(value) {
  const v = String(value || '').trim().toUpperCase().replace(/\s+/g, '-');
  if (!/^[A-Z0-9][A-Z0-9._/-]{0,39}$/.test(v)) return null;
  return v === 'USDT-TRC20' || v === 'USDT-TRC-20' ? 'USDT_TRC20' : v;
}

export function validateTronAddress(value) {
  return /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(String(value || '').trim());
}

export async function ensureCryptoWalletSchema(client) {
  await client.query(`CREATE TABLE IF NOT EXISTS crypto_wallets (
    id BIGSERIAL PRIMARY KEY,
    asset TEXT NOT NULL CHECK (asset IN ('TRX','USDT_TRC20')),
    name TEXT NOT NULL,
    address TEXT NOT NULL,
    network TEXT NOT NULL DEFAULT 'TRON',
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    monitor_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await client.query(`CREATE TABLE IF NOT EXISTS crypto_price_sources (
    id BIGSERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    provider_type TEXT NOT NULL DEFAULT 'coingecko',
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    priority INTEGER NOT NULL DEFAULT 100,
    config JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await client.query(`CREATE TABLE IF NOT EXISTS fiat_price_sources (
    id BIGSERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    provider_type TEXT NOT NULL DEFAULT 'custom',
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    priority INTEGER NOT NULL DEFAULT 100,
    config JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await client.query('ALTER TABLE crypto_wallets DROP CONSTRAINT IF EXISTS crypto_wallets_asset_check');
  await client.query('ALTER TABLE crypto_deposits DROP CONSTRAINT IF EXISTS crypto_deposits_asset_check');
  await client.query(`CREATE TABLE IF NOT EXISTS crypto_deposits (
    id BIGSERIAL PRIMARY KEY,
    order_id BIGINT,
    telegram_id BIGINT REFERENCES users(telegram_id) ON DELETE CASCADE,
    wallet_id BIGINT REFERENCES crypto_wallets(id) ON DELETE SET NULL,
    asset TEXT NOT NULL CHECK (asset IN ('TRX','USDT_TRC20')),
    txid TEXT NOT NULL UNIQUE,
    from_address TEXT,
    to_address TEXT NOT NULL,
    amount NUMERIC(30,12) NOT NULL CHECK (amount > 0),
    confirmations INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'detected' CHECK (status IN ('detected','confirmed','credited','rejected')),
    raw JSONB NOT NULL DEFAULT '{}'::jsonb,
    detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    credited_at TIMESTAMPTZ
  )`);
  await client.query('ALTER TABLE crypto_deposits ALTER COLUMN telegram_id DROP NOT NULL');
  await client.query('ALTER TABLE crypto_deposits DROP CONSTRAINT IF EXISTS crypto_deposits_order_id_fkey');
  await client.query("ALTER TABLE crypto_deposits ALTER COLUMN order_id TYPE TEXT USING order_id::text");
  await client.query("INSERT INTO bot_settings(key,value) VALUES ('crypto_auto_credit','false'),('crypto_monitor_enabled','false'),('crypto_confirmations','20'),('crypto_coin_price_toman',''),('crypto_report_channel_id',''),('crypto_usd_price_source','https://open.er-api.com/v6/latest/USD'),('crypto_asset_price_source','https://api.coingecko.com/api/v3') ON CONFLICT (key) DO NOTHING");
  await client.query("INSERT INTO crypto_price_sources(name,base_url,provider_type,priority) VALUES ('CoinGecko','https://api.coingecko.com/api/v3','coingecko',10) ON CONFLICT DO NOTHING");
}

export async function walletRows(client) {
  const result = await client.query(`SELECT w.id,w.asset,w.name,w.address,w.network,w.enabled,w.monitor_enabled,w.created_at,w.updated_at,
    COALESCE(SUM(d.amount) FILTER (WHERE d.status IN ('confirmed','credited') AND d.detected_at >= CURRENT_DATE),0) AS today_amount,
    COALESCE(SUM(d.amount) FILTER (WHERE d.status IN ('confirmed','credited') AND d.detected_at >= NOW()-INTERVAL '30 days'),0) AS month_amount,
    COUNT(d.id) FILTER (WHERE d.status IN ('confirmed','credited'))::int AS confirmed_count
    FROM crypto_wallets w LEFT JOIN crypto_deposits d ON d.wallet_id=w.id
    GROUP BY w.id ORDER BY w.id`);
  return result.rows;
}

export function walletPanelText(rows, settings = {}) {
  const auto = settings.crypto_auto_credit === 'true';
  const monitor = settings.crypto_monitor_enabled === 'true';
  const lines = rows.length ? rows.map((w, i) => `${i + 1}. ${w.enabled ? '🟢' : '🔴'} ${w.name} — ${walletAssetLabel(w.asset)}\n   ${w.address.slice(0, 8)}…${w.address.slice(-6)} | امروز: ${w.today_amount || 0}`).join('\n') : 'هنوز ولتی ثبت نشده است.';
  return `مدیریت ولت\n\nشبکه: TRON\nارزهای فاز اول: TRX و USDT-TRC20\nمانیتورینگ: ${monitor ? '🟢 فعال' : '🔴 خاموش'}\nاعتباردهی خودکار: ${auto ? '🟢 فعال' : '🔴 خاموش (ایمن)'}\nکانال گزارش: ${settings.crypto_report_channel_id || 'تنظیم نشده'}\n\nولت‌ها:\n${lines}\n\nمجموع خرید امروز و ۳۰ روزه پس از ثبت تراکنش‌های معتبر در همین پنل نمایش داده می‌شود.`;
}

export function walletPanelKeyboard(rows = []) {
  const buttons = rows.map(w => [{ text: `${w.enabled ? '🟢' : '🔴'} ${w.name}`, callback_data: `wallet:view:${w.id}` }]);
  return { reply_markup: { inline_keyboard: buttons } };
}

export function walletManagementReplyKeyboard() {
  return { reply_markup: { keyboard: [
    [{ text: '➕ افزودن ولت' }],
    [{ text: '📢 کانال گزارش' }, { text: '💵 منبع قیمت دلار' }],
    [{ text: '🪙 منبع قیمت ارزدیجیتال' }, { text: '⚙️ اعتباردهی خودکار' }],
    [{ text: '↩️ بازگشت' }],
  ], resize_keyboard: true, is_persistent: true } };
}

export function walletChannelReplyKeyboard() {
  return { reply_markup: { keyboard: [
    [{ text: 'تنظیم کانال' }, { text: 'حذف کانال' }],
    [{ text: '↩️ بازگشت' }],
  ], resize_keyboard: true, is_persistent: true } };
}

export function walletBackReplyKeyboard() {
  return { reply_markup: { keyboard: [[{ text: 'برگشت' }]], resize_keyboard: true, is_persistent: true } };
}

export function walletDetailsText(wallet) {
  return `مدیریت ولت\n\nنام: ${wallet.name}\nارز: ${walletAssetLabel(wallet.asset)}\nشبکه: ${wallet.network}\nآدرس: ${wallet.address}\nوضعیت: ${wallet.enabled ? '🟢 فعال' : '🔴 غیرفعال'}\nمانیتورینگ خودکار: ${wallet.monitor_enabled ? '🟢 فعال' : '🔴 خاموش'}\nخرید امروز: ${wallet.today_amount || 0} ${walletAssetLabel(wallet.asset)}\nخرید ۳۰ روز اخیر: ${wallet.month_amount || 0} ${walletAssetLabel(wallet.asset)}\nتراکنش‌های تأییدشده: ${wallet.confirmed_count || 0}`;
}

export function walletDetailsKeyboard(wallet) {
  return { reply_markup: { inline_keyboard: [
    [{ text: '✏️ تغییر آدرس', callback_data: `wallet:address:${wallet.id}` }, { text: '✏️ تغییر نام', callback_data: `wallet:name:${wallet.id}` }],
    [{ text: wallet.enabled ? '🔴 غیرفعال کردن' : '🟢 فعال کردن', callback_data: `wallet:toggle:${wallet.id}` }, { text: '🗑 حذف ولت', callback_data: `wallet:delete:${wallet.id}` }],
    [{ text: '↩️ بازگشت به مدیریت ولت', callback_data: 'wallet:panel' }],
  ] } };
}

export function walletAssetKeyboard() {
  return { reply_markup: { inline_keyboard: [[{ text: 'TRX', callback_data: 'wallet:asset:TRX' }, { text: 'USDT-TRC20', callback_data: 'wallet:asset:USDT_TRC20' }], [{ text: 'لغو', callback_data: 'wallet:panel' }]] } };
}
