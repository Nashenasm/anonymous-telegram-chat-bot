import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { countyLabels, IRAN_PROVINCES, PROFILE_FIELDS } from '../src/profile-service.js';

// The webhook owns its Pool. Both pool.query and checked-out clients must see the
// same in-memory database; no network or PostgreSQL connection is ever opened.
const { poolState } = vi.hoisted(() => ({ poolState: { db: null } }));
vi.mock('pg', () => ({
  Pool: class FakePool {
    async connect() { return poolState.db.connect(); }
    async query(...args) { return poolState.db.query(...args); }
  },
}));

import * as webhook from '../api/webhook.js';

const USER_ID = 601234567;
const PARTNER_ID = 809876543;
const FIELD_PROMPTS = {
  display_name: 'Choose a new name',
  age: 'Choose an age',
  country_code: 'Choose a country',
  province_code: 'Choose a province',
  county_code: 'Choose a county',
  gender: 'Choose a gender',
  profile_photo_file_id: 'Choose a photo',
};

function makeUser(overrides = {}) {
  return {
    telegram_id: USER_ID,
    username: 'own_username',
    coins: 23,
    display_name: 'نام قدیمی',
    age: 28,
    country_code: 'IR',
    province_code: 'tehran',
    county_code: 'تهران',
    gender: 'female',
    profile_gender_locked: true,
    profile_photo_file_id: null,
    action_state: null,
    status: 'idle',
    partner_id: null,
    start_completed: true,
    plus_expires_at: null,
    created_at: '2024-03-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeDb({ user = {}, partner = {}, fee = 4 } = {}) {
  const users = new Map([
    [String(USER_ID), makeUser(user)],
    [String(PARTNER_ID), makeUser({ telegram_id: PARTNER_ID, display_name: 'نام طرف مقابل', coins: 91, ...partner })],
  ]);
  const settings = new Map(Object.entries({
    profile_button: 'پروفایل من',
    back_button: 'بازگشت',
    profile_edit_cost: String(fee),
    regular_profile_mode: 'optional',
    profile_name_prompt: FIELD_PROMPTS.display_name,
    profile_age_prompt: FIELD_PROMPTS.age,
    profile_province_prompt: FIELD_PROMPTS.province_code,
    profile_county_prompt: FIELD_PROMPTS.county_code,
    profile_gender_prompt: FIELD_PROMPTS.gender,
    profile_photo_prompt: FIELD_PROMPTS.profile_photo_file_id,
    profile_country_label: 'ایران',
    privacy_protection_enabled: 'false',
  }));
  const ledger = [];
  const unknown = [];
  const queries = [];
  const result = rows => ({ rows: structuredClone(rows), rowCount: rows.length });

  function makeClient() {
    let transaction = null;
    return {
      release: vi.fn(),
      async query(statement, params = []) {
        const sql = String(typeof statement === 'string' ? statement : statement.text).replace(/\s+/g, ' ').trim();
        if (typeof statement !== 'string') params = statement.values || params;
        queries.push({ sql, params: structuredClone(params) });
        if (/^BEGIN\b/i.test(sql)) {
          transaction = { users: structuredClone([...users]), ledger: structuredClone(ledger) };
          return result([]);
        }
        if (/^COMMIT\b/i.test(sql)) { transaction = null; return result([]); }
        if (/^ROLLBACK\b/i.test(sql)) {
          if (transaction) {
            users.clear();
            for (const [key, value] of transaction.users) users.set(key, value);
            ledger.splice(0, ledger.length, ...transaction.ledger);
          }
          transaction = null;
          return result([]);
        }
        if (/^INSERT INTO users\s*\(/i.test(sql)) {
          // Fixtures already exist; mimic ON CONFLICT DO NOTHING RETURNING.
          if (users.has(String(params[0]))) return result([]);
          const row = makeUser({ telegram_id: Number(params[0]) });
          users.set(String(params[0]), row);
          return result([{ telegram_id: row.telegram_id }]);
        }
        if (/^SELECT\s+key\s*,\s*value\s+FROM\s+bot_settings\b/i.test(sql)) {
          return result([...settings].map(([key, value]) => ({ key, value })));
        }
        if (/^SELECT\s+value\s+FROM\s+bot_settings\s+WHERE\s+key\s*=\s*\$1/i.test(sql)) {
          return result(settings.has(params[0]) ? [{ value: settings.get(params[0]) }] : []);
        }
        if (/^INSERT INTO bot_settings\s*\(\s*key\s*,\s*value\s*\)/i.test(sql)) {
          settings.set(params[0], params[1]);
          return result([]);
        }
        if (/^SELECT\b.+\bFROM\s+finance_ledger\b/i.test(sql)) {
          return result(ledger.filter(entry => entry.idempotency_key === params[0]));
        }
        if (/^INSERT INTO\s+finance_ledger\b/i.test(sql)) {
          const [user_id, delta, balance_before, balance_after, kind, idempotency_key, metadata] = params;
          const entry = { id: ledger.length + 1, user_id, delta, balance_before, balance_after, kind, idempotency_key, metadata: JSON.parse(metadata || '{}') };
          ledger.push(entry);
          return result([entry]);
        }
        if (/^SELECT\b.+\bFROM\s+users\s+WHERE\s+telegram_id\s*=\s*\$1/i.test(sql)) {
          const row = users.get(String(params[0]));
          return result(row ? [row] : []);
        }
        if (/^UPDATE\s+users\s+SET\s+/i.test(sql) && /WHERE\s+telegram_id\s*=\s*\$1/i.test(sql)) {
          const row = users.get(String(params[0]));
          if (!row) return result([]);
          const assignments = sql.match(/^UPDATE\s+users\s+SET\s+(.+?)\s+WHERE\s+/i)[1].split(/,(?![^()]*\))/);
          for (const raw of assignments) {
            const assignment = raw.trim();
            const match = assignment.match(/^([a-z_]+)\s*=\s*(.+)$/i);
            if (!match) throw new Error(`Unrecognized assignment in fake DB: ${assignment}`);
            const [, column, expression] = match;
            if (['updated_at', 'profile_updated_at', 'profile_viewed_at'].includes(column)) continue;
            const placeholder = expression.match(/^\$(\d+)(?:::\w+)?$/);
            const arithmetic = expression.match(/^([a-z_]+)\s*([+-])\s*\$(\d+)$/i);
            if (placeholder) row[column] = params[Number(placeholder[1]) - 1];
            else if (arithmetic) row[column] = Number(row[arithmetic[1]]) + (arithmetic[2] === '+' ? 1 : -1) * Number(params[Number(arithmetic[3]) - 1]);
            else if (/^NULL$/i.test(expression)) row[column] = null;
            else if (/^TRUE$/i.test(expression)) row[column] = true;
            else if (/^FALSE$/i.test(expression)) row[column] = false;
            else if (/^'(?:[^']|'')*'$/.test(expression)) row[column] = expression.slice(1, -1).replace(/''/g, "'");
            else throw new Error(`Unrecognized expression in fake DB: ${assignment}`);
          }
          return /\bRETURNING\b/i.test(sql) ? result([row]) : { rows: [], rowCount: 1 };
        }
        unknown.push({ sql, params });
        throw new Error(`Unexpected SQL in profile-flow fake: ${sql}`);
      },
    };
  }
  return {
    users, settings, ledger, unknown, queries,
    connect: async () => makeClient(),
    query: (...args) => makeClient().query(...args),
    user: (id = USER_ID) => users.get(String(id)),
  };
}

let db;
let calls;
let fetchMock;

function visibleCalls() {
  return calls.filter(({ method }) => ['sendMessage', 'sendPhoto', 'editMessageText', 'editMessageCaption'].includes(method));
}
function visibleText(call) { return String(call?.body?.text ?? call?.body?.caption ?? ''); }
function buttons(call) { return call?.body?.reply_markup?.inline_keyboard?.flat() || []; }
function callbacks(call) { return buttons(call).map(button => button.callback_data).filter(Boolean); }
function lastVisible() { return visibleCalls().at(-1); }
function clearCalls() { calls.length = 0; }
function profileSnapshot(user = db.user()) { return Object.fromEntries(PROFILE_FIELDS.map(field => [field, user[field]])); }
function normalizedDigits(text) {
  return String(text).replace(/[۰-۹٠-٩]/g, ch => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(ch) >= 0 ? '۰۱۲۳۴۵۶۷۸۹'.indexOf(ch) : '٠١٢٣٤٥٦٧٨٩'.indexOf(ch)));
}
function expectFee(text, fee) {
  expect(normalizedDigits(text), 'the field-selection prompt should disclose the actual edit fee').toMatch(new RegExp(`(?:^|\\D)${fee}(?:\\D|$)`));
}
function expectProfileOrEditMenu(call) {
  const data = callbacks(call);
  expect(data.some(item => item === 'profile:edit' || item.startsWith('profile:edit:')), 'return to the profile or its field-edit menu').toBe(true);
}
function expectNoOtherPrompts(callsToCheck, allowedField) {
  const text = callsToCheck.map(visibleText).join('\n');
  for (const [field, prompt] of Object.entries(FIELD_PROMPTS)) {
    if (field !== allowedField) expect(text).not.toContain(prompt);
  }
  const data = callsToCheck.flatMap(callbacks);
  expect(data.some(item => /^profile:(country|county|gender):/.test(item)), 'an edit must not advance to an unrelated field').toBe(false);
}
async function type(text) { await webhook.handleText(USER_ID, text, { message: { message_id: 77, chat: { id: USER_ID }, from: { id: USER_ID }, text } }); }
async function click(data, { requireVisible = true } = {}) {
  if (requireVisible) expect(callbacks(lastVisible()), `the previous screen must offer ${data}`).toContain(data);
  await webhook.handleCallback(USER_ID, data, { id: `callback-${data}`, from: { id: USER_ID }, data, message: { message_id: 123, chat: { id: USER_ID } } });
}
async function openEdit(field) {
  await type('پروفایل من');
  await click('profile:edit');
  if (field) await click(`profile:edit:${field}`);
}
async function submitChange(change) {
  // Click the offered value, including any per-prompt anti-replay nonce.
  const selected = change.callback && callbacks(lastVisible()).find(data => data === change.callback || data.startsWith(`${change.callback}:`));
  if (change.callback) expect(selected, `the requested value must be offered: ${change.callback}`).toBeTruthy();
  clearCalls();
  if (selected) await click(selected, { requireVisible: false });
  else await type(change.text);
}

beforeEach(() => {
  db = makeDb();
  poolState.db = db;
  calls = [];
  vi.stubEnv('TELEGRAM_BOT_TOKEN', 'fake-token');
  vi.stubEnv('OWNER_TELEGRAM_ID', '');
  vi.stubEnv('ADMIN_TELEGRAM_IDS', '');
  fetchMock = vi.fn(async (url, options) => {
    const parsed = new URL(String(url));
    if (parsed.origin !== 'https://api.telegram.org' || !parsed.pathname.startsWith('/botfake-token/')) throw new Error(`Unexpected network request: ${url}`);
    const method = parsed.pathname.split('/').at(-1);
    const body = JSON.parse(options.body);
    calls.push({ method, body });
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 123, chat: { id: body.chat_id } } }) };
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  expect(db.unknown, 'extend the fake for any newly required profile SQL instead of silently hiding it').toEqual([]);
});

describe('webhook own-profile workflow', () => {
  it('exports the handlers used by real text and callback updates', () => {
    expect(webhook.handleText, 'export handleText from api/webhook.js').toBeTypeOf('function');
    expect(webhook.handleCallback, 'export handleCallback from api/webhook.js').toBeTypeOf('function');
  });

  it.each([false, true])('shows the caller’s own existing data and edit button during a chat (photo=%s)', async hasPhoto => {
    db.user().status = 'chatting';
    db.user().partner_id = PARTNER_ID;
    if (hasPhoto) db.user().profile_photo_file_id = 'stored-photo';
    await type('پروفایل من');
    const messages = visibleCalls();
    expect(messages).toHaveLength(1);
    const shown = messages[0];
    expect(shown.body.chat_id).toBe(USER_ID);
    const body = visibleText(shown);
    for (const value of ['نام قدیمی', '28', 'تهران', '23']) expect(normalizedDigits(body)).toContain(value);
    // ID may be in the profile text or on a visible copy-ID button.
    expect(`${body} ${buttons(shown).map(button => button.text).join(' ')}`).toContain(String(USER_ID));
    expect(body).not.toContain('نام طرف مقابل');
    expect(callbacks(shown)).toContain('profile:edit');
    if (hasPhoto) expect(shown.body.photo).toBe('stored-photo');
    expect(calls.some(call => call.body.chat_id === PARTNER_ID)).toBe(false);
  });

  it('opens a field menu with the configured fee and without an editable gender', async () => {
    await type('پروفایل من');
    await click('profile:edit');
    const menu = lastVisible();
    for (const field of ['display_name', 'age', 'province_code']) expect(callbacks(menu)).toContain(`profile:edit:${field}`);
    expect(callbacks(menu)).not.toContain('profile:edit:gender');
    expect(callbacks(menu)).toContain('profile:back_view');
    expectFee(visibleText(menu), 4);
  });

  const changes = [
    { field: 'province_code', callback: 'profile:province:fars', value: 'fars' },
    { field: 'age', callback: 'profile:age:31', value: 31 },
    { field: 'display_name', text: 'نام جدید', value: 'نام جدید' },
  ];
  for (const change of changes) {
    for (const fee of [0, 4]) {
      it(`edits only ${change.field} with fee ${fee}, then returns to a profile menu`, async () => {
        db.settings.set('profile_edit_cost', String(fee));
        const original = profileSnapshot();
        const partnerBefore = structuredClone(db.user(PARTNER_ID));
        const originalBalance = db.user().coins;
        await openEdit(change.field);
        expectFee(visibleText(lastVisible()), fee);
        expect(db.user().coins).toBe(originalBalance); // opening a prompt never charges
        await submitChange(change);
        expect(profileSnapshot()).toEqual({ ...original, [change.field]: change.value });
        expect(db.user().coins).toBe(originalBalance - fee);
        expect(db.user(PARTNER_ID)).toEqual(partnerBefore);
        expect(db.ledger).toHaveLength(fee ? 1 : 0);
        if (fee) expect(db.ledger[0]).toMatchObject({ user_id: USER_ID, delta: -fee, balance_before: originalBalance, balance_after: originalBalance - fee, kind: 'profile_edit', metadata: { field: change.field } });
        const response = visibleCalls();
        expect(response.length).toBeGreaterThan(0);
        if (change.field === 'display_name') expect(response, 'a name edit must not produce duplicate responses').toHaveLength(1);
        expectNoOtherPrompts(response, change.field);
        expectProfileOrEditMenu(response.at(-1));
      });
    }
  }

  it.each(changes)('first registration of $field is free and never starts a different setup step', async change => {
    db.user()[change.field] = null;
    // Leave another required field missing: an edit is not an onboarding wizard.
    db.user().county_code = null;
    const original = profileSnapshot();
    await openEdit(change.field);
    expectFee(visibleText(lastVisible()), 0);
    await submitChange(change);
    expect(profileSnapshot()).toEqual({ ...original, [change.field]: change.value });
    expect(db.user().coins).toBe(23);
    expect(db.ledger).toHaveLength(0);
    const response = visibleCalls();
    if (change.field === 'display_name') expect(response).toHaveLength(1);
    expectNoOtherPrompts(response, change.field);
    expectProfileOrEditMenu(response.at(-1));
  });

  it.each(changes)('does not save or debit an unaffordable $field edit', async change => {
    db.user().coins = 2;
    const before = profileSnapshot();
    await openEdit(change.field);
    expectFee(visibleText(lastVisible()), 4);
    await submitChange(change);
    expect(profileSnapshot()).toEqual(before);
    expect(db.user().coins).toBe(2);
    expect(db.ledger).toHaveLength(0);
    const response = visibleCalls();
    expect(response.length).toBeGreaterThan(0);
    expect(response.map(visibleText).join(' ')).toMatch(/کافی|موجودی|insufficient|balance/i);
    expectNoOtherPrompts(response, change.field);
  });

  it.each([
    { field: 'age', prefix: 'profile:age:', choices: Array.from({ length: 66 }, (_, i) => String(i + 15)) },
    { field: 'province_code', prefix: 'profile:province:', choices: IRAN_PROVINCES.map(([code]) => code) },
    { field: 'county_code', prefix: 'profile:county:tehran:', choices: countyLabels('tehran').map((_, i) => String(i)) },
  ])('offers every $field choice in four-column rows with a back button', async ({ field, prefix, choices }) => {
    await openEdit(field);
    const rows = lastVisible().body.reply_markup.inline_keyboard;
    const choiceRows = rows.map(row => row.filter(button => button.callback_data?.startsWith(prefix))).filter(row => row.length);
    expect(choiceRows.length).toBeGreaterThan(1);
    for (const row of choiceRows.slice(0, -1)) expect(row).toHaveLength(4);
    expect(choiceRows.at(-1).length).toBeGreaterThanOrEqual(1);
    expect(choiceRows.at(-1).length).toBeLessThanOrEqual(4);
    const offered = choiceRows.flat().map(button => button.callback_data.slice(prefix.length).split(':')[0]);
    expect(offered).toHaveLength(choices.length);
    expect(new Set(offered)).toEqual(new Set(choices));
    expect(callbacks(lastVisible()).some(data => ['profile:edit', 'profile:province_menu'].includes(data))).toBe(true);
  });

  it('navigates back from a choice to the field menu, then to the profile without saving or charging', async () => {
    const original = profileSnapshot();
    await openEdit('province_code');
    await click('profile:edit');
    expect(callbacks(lastVisible())).toContain('profile:edit:province_code');
    await click('profile:back_view');
    expect(callbacks(lastVisible())).toContain('profile:edit');
    expect(visibleText(lastVisible())).toContain('نام قدیمی');
    expect(profileSnapshot()).toEqual(original);
    expect(db.user().coins).toBe(23);
    expect(db.ledger).toHaveLength(0);
    // A stale field state must not turn the next public-profile click into an edit value.
    clearCalls();
    await type('پروفایل من');
    expect(callbacks(lastVisible())).toContain('profile:edit');
    expect(profileSnapshot()).toEqual(original);
  });

  it('cancels name input using the visible back reply button without treating it as a name', async () => {
    const original = profileSnapshot();
    await openEdit('display_name');
    const rows = lastVisible().body.reply_markup?.keyboard || [];
    const labels = rows.flat().map(button => typeof button === 'string' ? button : button.text);
    expect(labels).toContain('بازگشت');
    clearCalls();
    await type('بازگشت');
    expectProfileOrEditMenu(lastVisible());
    expect(profileSnapshot()).toEqual(original);
    expect(db.user().coins).toBe(23);
    expect(db.ledger).toHaveLength(0);
  });
  it('shows a changed fee and requires a new choice before charging it', async () => {
    await openEdit('province_code');
    const oldChoice = callbacks(lastVisible()).find(data => data.startsWith('profile:province:fars:'));
    expectFee(visibleText(lastVisible()), 4);
    db.settings.set('profile_edit_cost', '7');
    clearCalls();
    await click(oldChoice, { requireVisible: false });
    expect(db.user().province_code).toBe('tehran');
    expect(db.user().coins).toBe(23);
    expect(db.ledger).toHaveLength(0);
    expectFee(visibleText(lastVisible()), 7);
    const newChoice = callbacks(lastVisible()).find(data => data.startsWith('profile:province:fars:'));
    expect(newChoice).not.toBe(oldChoice);
    await click(newChoice);
    expect(db.user().province_code).toBe('fars');
    expect(db.user().coins).toBe(16);
    expect(db.ledger).toHaveLength(1);
    expect(db.ledger[0].delta).toBe(-7);
  });
  it('rejects old buttons after backing out or opening a new edit session', async () => {
    await openEdit('age');
    const stale = callbacks(lastVisible()).find(data => data.startsWith('profile:age:31:'));
    await click('profile:edit');
    await click('profile:edit:age');
    const fresh = callbacks(lastVisible()).find(data => data.startsWith('profile:age:31:'));
    expect(fresh).not.toBe(stale);
    await click(stale, { requireVisible: false });
    expect(db.user().age).toBe(28);
    expect(db.ledger).toHaveLength(0);
    await click(fresh, { requireVisible: false });
    expect(db.user().age).toBe(31);
    expect(db.ledger).toHaveLength(1);
    await click(fresh, { requireVisible: false });
    expect(db.ledger).toHaveLength(1);
    expect(db.user().coins).toBe(19);
  });
  it('does not debit when an existing value is chosen unchanged', async () => {
    await openEdit('age');
    const choice = callbacks(lastVisible()).find(data => data.startsWith('profile:age:28:'));
    await click(choice);
    expect(db.user().age).toBe(28);
    expect(db.user().coins).toBe(23);
    expect(db.ledger).toHaveLength(0);
  });
  it('always opens the personal profile instead of saving the profile button as a name', async () => {
    await openEdit('display_name');
    clearCalls();
    await type('پروفایل من');
    expect(db.user().display_name).toBe('نام قدیمی');
    expect(db.user().action_state).toBeNull();
    expect(db.ledger).toHaveLength(0);
    expect(visibleCalls()).toHaveLength(1);
    expect(callbacks(lastVisible())).toContain('profile:edit');
  });
});
