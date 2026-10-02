# Finance security boundary

## Jev-guided decision

The Jev `jev-1.13.0` evaluation of this codebase selected **ledger-first** with probability 1.0 and identified direct `users.coins` mutation as the highest-risk issue with probability 1.0. It scored readiness for real external payments at **0.15/3** and returned `noul=0.04` for allowing Jev to authorize or credit payments.

Therefore:

- Jev is used only for bounded payment-risk triage.
- Jev never approves a payment, changes a balance, or decides an amount.
- Deterministic provider verification, SQL transactions, idempotency, and human review remain authoritative.
- External providers and cryptocurrency scanning stay disabled until separately implemented and explicitly enabled.

## Migration

Apply `db/schema-v10-finance-ledger.sql` after the existing migrations. It creates:

- `finance_ledger`: append-only coin entries with before/after balances and a unique idempotency key.
- `payment_orders`: provider-neutral orders with explicit status and unique provider references.
- `finance_review_queue`: a human-review boundary that can store Jev's triage result without granting it authority.

`users.coins` remains a read-optimized balance projection. New balance mutations should call `applyCoinDelta()` inside the same PostgreSQL transaction as the business operation.

## Activation policy

`finance_enabled` remains `false`. Do not set it to `true` until a real provider adapter has signature validation, replay protection, amount/product matching, reconciliation, and tests against its sandbox.
