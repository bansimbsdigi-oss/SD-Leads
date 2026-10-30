# Sabhi Leads

Multi-tenant lead platform for Sabhi Digital and its clients. The full build plan is in [docs/PLAN.md](docs/PLAN.md).

## Status

| Phase | State |
|---|---|
| 1. Foundation: schema, auth, roles, tenant layer, client + LP admin | Done (staging not set up yet) |
| 2. Ingestion: ingest API, field registry, form versions, `lead.js` | Done (Turnstile wired, needs real keys; WordPress test pending) |
| 3. Lead operations | Partly: registry-driven table, CSV export, lead detail, call/WhatsApp links, field manager. Notes/status/assignment/notifications to do |
| 4–7 | Not started |

## Client webhook (one URL per client)

Every client has one secret webhook URL, shown on the client page: `POST /api/hook/{token}`.
Paste the same URL into the webhook action of every form (Elementor, WPForms, Pabbly, Zapier, plain HTML).

- Accepts JSON, `x-www-form-urlencoded` and `multipart/form-data`, including Elementor's simple and advanced formats.
- The LP is worked out per lead: `?lp=LP_KEY` if given, else the page URL in the payload (`Page URL`, `page_url`, `referrer`), else the form name. A page seen for the first time becomes a new LP marked "auto".
- Name, phone and email are recognised from the field names (e.g. "Mobile Number", "WhatsApp", "Email Address").
- Metadata such as Date, Time, User Agent, Remote IP and UTM values goes into tracking, not answers.
- Without a `submission_id`, a hash of the body is used, so a tool retrying the same POST creates no second lead.
- "Regenerate URL" on the client page replaces the token; the old URL stops working at once.

Code: `src/app/api/hook/[token]/route.ts`, `src/lib/ingest/webhook.ts`, `src/lib/ingest/clientWebhook.ts`.

## Scale

Built for many clients × many LPs × millions of leads. Measured with `scripts/bench-leads.ts` on 1,000,000 leads
(12 clients, 5 LPs each, one client holding 300k), laptop Postgres 16 with default settings:

| Leads screen action | Before | After |
|---|---|---|
| Newest first (all clients / big client) | 100 ms | 5 ms |
| Search name / phone / answer text (big client) | 400–520 ms | 2–13 ms |
| Search across all clients | 1,300 ms | 2 ms |
| Dropdown filter, e.g. Budget is 5L+ | 120 ms | 27 ms |
| Page 400 | 95 ms | 8 ms |
| Sort 300k leads by a text column | 150 ms | 120–130 ms |
| Ingest, 20 concurrent into one LP | 340 leads/s | 630 leads/s |
| Ingest, 20 concurrent across clients | 1,000 leads/s | 1,950 leads/s |

How:
- `leads.search_text` (lowercased name, email, phone digits, answer values) with a `pg_trgm` GIN index: search is one indexed `LIKE`.
- Per-client indexes: `(client_id, created_at)`, `(client_id, phone/email)` for dedupe, `(client_id, status_id)`, `(client_id, owner_id)`, plus `created_at` for the all-clients view.
- Dropdown/radio/checkbox filters use `answers @> {...}`, served by the GIN index on `answers`.
- Totals are counted up to 10,000, then shown as "10,000+"; counting is what made broad filters slow.
- Sorts end in `id` so pages never repeat or skip rows.
- Ingest only writes the field registry when something changed (`last_seen_at` refreshes hourly), so concurrent leads on one LP don't queue on row locks.
- Production Postgres settings, pool sizes and a 15 s statement timeout for the app role are in `docker-compose.yml` / `deploy/db-init.sh`.

Re-run the benchmark: create a database, `prisma migrate deploy` it, load `scripts/bench-data.sql` with `prisma db execute`, then
`DATABASE_URL=postgresql://…/sabhi_leads_bench pnpm exec tsx scripts/bench-leads.ts`.

## Local development (no Docker needed)

```bash
pnpm install
pnpm db:start          # embedded Postgres 16 on :5433, keep this running
pnpm db:migrate        # in a second terminal
pnpm db:seed
pnpm dev               # http://localhost:3000
```

Demo users (password is `SEED_PASSWORD`, default in `prisma/seed.ts`):

| Email | Role |
|---|---|
| admin@sabhi.test | Super admin |
| am@sabhi.test | Account manager (Ritu Agarwal only) |
| ritu.admin@client.test | Client admin, Ritu Agarwal |
| ritu.member@client.test | Client member, Ritu Agarwal |
| neha.admin@client.test | Client admin, FitWithNeha |

A test landing page is at http://localhost:3000/demo/webinar.html. Submissions appear under Leads.

`REDIS_URL` empty → background jobs are skipped. `TURNSTILE_SECRET_KEY` empty → Turnstile is skipped.

## Tests

```bash
pnpm test        # unit + DB tests (needs pnpm db:start running; uses database sabhi_leads_test)
pnpm typecheck
pnpm lint
```

## Layout

```
prisma/schema.prisma        data model (plan §5)
public/lead.js              LP snippet (plan §7)
src/app/api/ingest/...      public ingest endpoint (plan §6)
src/lib/ingest/             key rules, normalisation, guards, registry + save
src/lib/tenant.ts           role/tenant scoping filters
src/lib/data.ts             tenant-scoped data layer (all UI/API reads go through here)
src/worker/index.ts         BullMQ worker
docker-compose.yml, deploy/ VPS stack: app, worker, db, redis, caddy, backup
```

## Decisions made while building

- **Field labels:** the form's latest label is stored in `form_fields.label`; an admin rename goes in `display_label` and wins in the UI, so the next submission never overwrites it.
- **Removed fields:** not auto-hidden (that flaps when forms have conditional fields). The UI marks fields "not in current form" from the current form version; `is_hidden` is only set by an admin.
- **Reserved keys** (`submission_id`, `lp`, `tracking`) are renamed with a `_field` suffix instead of rejecting the lead.
- **Notes** are folded into `lead_events` (type `note`).
- **Quiz scores** stored per field in `leads.scores` and summed in `leads.total_score`.
- **Client members** see leads they own plus leads on LPs they are assigned to.
- **Rate limiting** is in-memory per process (20/min per IP, 600/min per LP). Move to Redis if the app runs more than one instance.

## Deploy (VPS)

Production runs at https://zbot.sabhidigital.com on the shared Hostinger VPS, in `/opt/sd-leads`
(compose project `sd-leads`, so it never touches the other apps there). Traefik on that host owns
ports 80/443 and issues the certificate, so the stack runs with `docker-compose.shared-host.yml`
(no Caddy, memory limits, smaller Postgres). `.env` on the server sets
`COMPOSE_FILE=docker-compose.yml:docker-compose.shared-host.yml`, so plain `docker compose` commands
in that folder use both files.

Update by hand:

```bash
cd /opt/sd-leads && git pull
docker compose build app worker
docker compose run --rm worker sh -c 'DATABASE_URL=$MIGRATE_URL node_modules/.bin/prisma migrate deploy'
docker compose up -d
```

- First admin / password reset: `docker compose run --rm worker node_modules/.bin/tsx scripts/create-admin.ts you@example.com "Name"` prints a new password.
- Backups: `deploy/backup-local.sh` runs nightly from root's crontab and keeps 14 dumps in `/root/backups/sd-leads`.
- On a dedicated server instead, leave `COMPOSE_FILE` unset: the base file includes Caddy on 80/443.

CI (`.github/workflows/ci.yml`) runs typecheck, lint, tests and build on every push, and deploys `main` over SSH.
