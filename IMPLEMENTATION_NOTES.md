# Implementation notes

## Included in this version

- Public `پروفایل من` reply-keyboard button.
- Profile display for coins (currently zero), first membership date/time in the Iran timezone, Telegram numeric ID, and saved gender.
- `users.coins` migration with a non-negative default of zero.
- Seven-day shared block expiry in `anonymous_blocks`, enforced for random matching, active chats, and anonymous-link flows.
- Expanded `/manpin` reply-keyboard panel: advertising, bot control, user lookup, status, reports, and admins.
- Admin-editable welcome and connection messages.
- Text broadcast with success/target counts.
- Existing glass/inline buttons were preserved; no existing anonymous-link flow was removed.
- Mandatory-join tracking commands (`/mj_<code>`), one-tap details/actions, durable status history, sticky per-setup counts, pause/resume duration accounting, and soft cancellation that preserves old tracking codes.
- Optional mandatory-join report channel whose posts are edited in place, plus a bearer-protected `GET /api/mandatory-jobs` route for an external minute scheduler.
- Per-source mandatory-join audience filters for regular/Plus female/male profiles, inline toggles and final review, and admin-editable join text/button labels/layout/source tags.
- Portable Node server routes for the Telegram webhook, tracking redirects, and the scheduled lifecycle worker.
- Tests and build checks pass.

## Database upgrade

Back up the database first. For a database already on schema v5, run the additive migrations in order:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/schema-v6-mandatory-tracking.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/schema-v7-mandatory-audience.sql
```

Runtime startup also initializes these tables idempotently. Do not run `db/schema.sql` on a database that already contains production data.

## Current intentional scope limits

- Broadcast currently accepts text. Media broadcast should be added using Telegram `copyMessage` after validating the complete update/media flow.
- Mandatory channel/group join uses Telegram membership checks and bot-generated private invite links. Users see configurable generic inline join/verify buttons; confirmed counts are sticky and unique per source setup. Each source is filtered by profile gender and current Plus expiry; users with no gender are included when at least one gender in their tier is enabled.
- Minute-accurate scheduled starts and completion notifications require configuring an external scheduler to call `GET /api/mandatory-jobs` with `Authorization: Bearer <CRON_SECRET>` every minute. Set a random `CRON_SECRET` of at least 32 bytes in the host and scheduler. This project does not create the third-party scheduler account or job automatically.
- Mid-chat advertising has settings placeholders but needs a scheduler/trigger strategy compatible with the selected host.
- The admin HTTP health endpoint remains separate from the Telegram `/manpin` panel.

## Verification

```bash
npm ci
npm test
npm run build
npm run lint
```
