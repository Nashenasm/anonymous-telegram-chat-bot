-- Permit profile edit fees while retaining every previously permitted ledger kind.
-- Run as the table owner; this transaction makes the constraint change atomic.
BEGIN;
ALTER TABLE finance_ledger DROP CONSTRAINT IF EXISTS finance_ledger_kind_check;
ALTER TABLE finance_ledger ADD CONSTRAINT finance_ledger_kind_check
  CHECK (kind IN ('opening_balance','grant','gift','daily','referral','chat_cost','purchase','admin','refund','profile_edit'));
COMMIT;
