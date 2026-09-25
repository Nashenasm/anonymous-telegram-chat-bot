BEGIN;

ALTER TABLE public.anon_links ALTER COLUMN expires_at DROP NOT NULL;

CREATE TABLE IF NOT EXISTS public.anonymous_pair_permissions (
    sender_id    bigint      NOT NULL REFERENCES public.users (telegram_id) ON DELETE CASCADE,
    recipient_id bigint      NOT NULL REFERENCES public.users (telegram_id) ON DELETE CASCADE,
    created_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (sender_id, recipient_id),
    CHECK (sender_id <> recipient_id)
);

CREATE TABLE IF NOT EXISTS public.anonymous_pending_messages (
    id           bigserial   PRIMARY KEY,
    sender_id    bigint      NOT NULL REFERENCES public.users (telegram_id) ON DELETE CASCADE,
    recipient_id bigint      NOT NULL REFERENCES public.users (telegram_id) ON DELETE CASCADE,
    message_body text        NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (recipient_id),
    CHECK (sender_id <> recipient_id)
);

CREATE TABLE IF NOT EXISTS public.anonymous_blocks (
    user_low  bigint      NOT NULL REFERENCES public.users (telegram_id) ON DELETE CASCADE,
    user_high bigint      NOT NULL REFERENCES public.users (telegram_id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_low, user_high),
    CHECK (user_low < user_high)
);

CREATE INDEX IF NOT EXISTS idx_anonymous_pending_messages_sender
    ON public.anonymous_pending_messages (sender_id);

COMMIT;
