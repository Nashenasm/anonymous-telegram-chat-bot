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
- Tests and build checks pass.

## Database upgrade

Back up the database first, then run:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/schema-v3.sql
```

Do not run `db/schema.sql` on a database that already contains production data.

## Current intentional scope limits

- Broadcast currently accepts text. Media broadcast should be added using Telegram `copyMessage` after validating the complete update/media flow.
- Forced channel join is represented in the admin menu but requires a channel registry and `getChatMember` checks before activation.
- Mid-chat advertising has settings placeholders but needs a scheduler/trigger strategy compatible with the selected host.
- The admin HTTP health endpoint remains separate from the Telegram `/manpin` panel.

## Verification

```bash
npm ci
npm test
npm run build
npm run lint
```
