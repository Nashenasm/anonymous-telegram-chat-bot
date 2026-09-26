BEGIN;

ALTER TABLE public.anon_links ALTER COLUMN expires_at DROP NOT NULL;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS coins INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public.anonymous_blocks ADD COLUMN IF NOT EXISTS expires_at timestamptz;
UPDATE public.anonymous_blocks SET expires_at = created_at + INTERVAL '7 days' WHERE expires_at IS NULL;
ALTER TABLE public.anonymous_blocks ALTER COLUMN expires_at SET DEFAULT (now() + INTERVAL '7 days');
ALTER TABLE public.anonymous_blocks ALTER COLUMN expires_at SET NOT NULL;

INSERT INTO public.bot_settings(key, value) VALUES
    ('profile_button', 'پروفایل من'),
    ('back_button', 'بازگشت'),
    ('welcome_message', 'به چت ناشناس خوش آمدی.'),
    ('connected_message', 'وصل شدی؛ سلام کن و گفت‌وگو را شروع کن.'),
    ('mid_chat_ad_enabled', 'false'),
    ('mid_chat_ad_minutes', '15')
ON CONFLICT (key) DO NOTHING;

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
