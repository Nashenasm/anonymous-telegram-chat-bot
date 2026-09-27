BEGIN;

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS plus_expires_at timestamptz;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS plus_emoji text NOT NULL DEFAULT '✨';
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'user';
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS referral_code text;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS referred_by bigint REFERENCES public.users(telegram_id) ON DELETE SET NULL;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS start_completed boolean NOT NULL DEFAULT true;

UPDATE public.users SET plus_emoji = '✨' WHERE plus_emoji IS NULL OR plus_emoji = '';
UPDATE public.users SET role = 'user' WHERE role IS NULL OR role = '';
UPDATE public.users SET start_completed = true WHERE start_completed IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS users_referral_code_unique ON public.users(referral_code) WHERE referral_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS users_plus_expiry_idx ON public.users(plus_expires_at);

CREATE TABLE IF NOT EXISTS public.plus_purchases (
  id bigserial PRIMARY KEY,
  telegram_id bigint NOT NULL REFERENCES public.users(telegram_id) ON DELETE CASCADE,
  months integer NOT NULL CHECK (months IN (1,3,6,12)),
  price integer NOT NULL CHECK (price IN (100,250,450,800)),
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;
