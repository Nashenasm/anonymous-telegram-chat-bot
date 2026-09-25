ALTER TABLE users ADD COLUMN IF NOT EXISTS opt_out BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS pending_recipient_id BIGINT NULL;

CREATE TABLE IF NOT EXISTS anon_links (
    token_hash BYTEA PRIMARY KEY,
    telegram_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_anon_links_one_active
    ON anon_links(telegram_id)
    WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_anon_links_expiry ON anon_links(expires_at);

CREATE TABLE IF NOT EXISTS reports (
    id BIGSERIAL PRIMARY KEY,
    reporter_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
    target_id BIGINT NULL REFERENCES users(telegram_id) ON DELETE SET NULL,
    reason VARCHAR(200) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'open',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT reports_status_check CHECK (status IN ('open', 'reviewing', 'resolved', 'dismissed'))
);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status, created_at);
CREATE INDEX IF NOT EXISTS idx_reports_target ON reports(target_id);
