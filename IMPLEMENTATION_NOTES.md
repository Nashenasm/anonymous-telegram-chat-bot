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

## Admin controls and live chat tools

- Additive migration `db/schema-v9-admin-controls.sql` adds chat metrics, audit logs, gift-code storage, games, configurable permissions, ban fields, and chat timing settings.
- `/manpin` now exposes a reply-keyboard `کنترل کاربر` flow with numeric lookup, coin/Plus adjustments, ban list, status, gift-code creation, audit history, conversation settings, minimum chat duration, and spam limits.
- An authorized admin who is actively chatting receives a private `🎛 کنترل کاربر` reply-keyboard button. It is not sent to the chat partner. Public active chats also expose `بازی` and `ایده صحبت`; game approval remains inline only where a two-sided accept/reject interaction is required.
- Runtime does not call Manus or Atria. Atria may be used as a development assistant, but the deployed bot remains portable Node.js + PostgreSQL and can be moved by copying source, environment variables, migration files, and a PostgreSQL backup.

## Verification

```bash
npm ci
npm test
npm run build
npm run lint
```


## Appearance editor and owner tools

- `src/appearance.js` contains the portable public/private appearance schema, templates, nested item editing, feedback text, and layout normalization.
- Appearance values are stored as JSON in `bot_settings` under `appearance_public` and `appearance_private`; enable flags allow falling back to the default appearance without deleting the custom configuration.
- `db/schema-v8-appearance-and-owner-tools.sql` is the additive migration for existing databases.
- The technical tools are guarded by `OWNER_TELEGRAM_ID`, not merely `ADMIN_TELEGRAM_IDS`. Source export excludes `.env`, `.git`, and `node_modules`; database export is generated from PostgreSQL metadata and current rows so it remains independent of `pg_dump`.


## Multi-format backup and deep screens

The database backup is a ZIP archive containing SQL restore data, full JSON, per-table JSON, per-table CSV, schema metadata, a manifest, and a restore README. The source archive contains the portable source tree plus `SOURCE_MANIFEST.json`.

The appearance schema now has editable screen/state objects for public matching and chat flows and for private management flows. The editor paginates the complete nested item list, including screen titles, messages, button labels, and internal feedback texts. Telegram does not support arbitrary custom fonts in ordinary messages, so the templates use portable Unicode typography and deliberate copy/layout instead of image-dependent typography.


## Beginner-friendly server status

The owner-only status report now reads the visible memory limit where the host exposes it, compares current RSS usage against that limit, shows used/remaining values and a visual percentage bar, and explains green/yellow/red thresholds. It also reports Node heap usage, CPU cores/load, temporary disk usage, database connectivity, Telegram connectivity, basic user counts, Vercel execution-time limits, and a plain-language explanation of what each number means. If the platform does not expose a hard memory limit, the report explicitly says so instead of presenting the host total as a guaranteed plan limit.

## Deep creative themes

The three non-default themes now provide screen-by-screen copy, labels, feedback language, private-panel labels, and distinct keyboard layout rhythm. The routing layer resolves visible labels back to immutable IDs for both public and owner-only menus. This keeps the creative layer independent from bot behavior.
