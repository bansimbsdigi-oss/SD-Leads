# Sabhi Lead Platform: Build Plan

Status: Planning. Version 0.1
Owner: Sabhi Digital

---

## 1. Purpose

A multi-tenant lead management platform for Sabhi Digital and its clients.

- Each **client** has one or more **landing pages (LPs)**.
- Every LP's form submission is captured and stored as a **lead** in our database.
- Forms are **dynamic**: fields differ per LP, can be text questions, quiz questions or dropdowns, and new fields can appear at any time. A new field automatically becomes a new column.
- Leads are worked through a **pipeline** (table and Kanban views), with follow-ups, notifications and quick call/WhatsApp links.
- Lead outcomes are sent back to **Meta** via the Conversions API (CAPI).

Non-goals for v1: social media scheduling, video tool integration, WhatsApp Cloud API (planned for later phases).

---

## 2. Users and roles

| Role | Scope | Can do |
|---|---|---|
| Super admin (Sabhi) | All clients | Create clients, LPs, users; see everything; manage integrations |
| Account manager (Sabhi) | Assigned clients | Work leads, view reports, edit field labels |
| Client admin | Own client | Manage own users, LPs, pipeline stages; view all client leads |
| Client member | Own client, optionally assigned LPs | Work assigned leads only |

Every row that belongs to a client carries `client_id`. All data access goes through one tenant-scoped data layer.

---

## 3. Technology stack

| Layer | Choice |
|---|---|
| Language | TypeScript (Node.js LTS) |
| Web framework | Next.js (App Router), API routes |
| UI | Tailwind CSS, shadcn/ui |
| Tables / boards | TanStack Table (spreadsheet view), dnd-kit (Kanban) |
| Database | PostgreSQL 16 |
| ORM and migrations | Prisma |
| Validation | Zod |
| Queue | BullMQ + Redis |
| Auth | Auth.js (NextAuth), argon2 password hashing, optional 2FA for admins |
| Push | Web Push (VAPID) via `web-push` |
| Email | Resend (or existing SMTP) |
| Lead snippet | `lead.js`, plain JavaScript, no build step, served from our ingest server |
| WordPress delivery | Small plugin: "Sabhi Lead Connector" |
| Reverse proxy / HTTPS | Caddy |
| Containers | Docker, Docker Compose |
| Hosting | Hostinger KVM 2 VPS |
| Bot protection | Cloudflare Turnstile on ingest |
| Errors | Sentry (free tier) |
| Uptime | UptimeRobot on the ingest endpoint |
| Logs | Pino (structured JSON) |
| Source control / CI | GitHub (private repo), GitHub Actions: test, build, deploy over SSH |
| Testing | Vitest (unit), Playwright (end-to-end, incl. a test LP page) |
| Package manager | pnpm |
| Backups | Nightly `pg_dump`, copied off-VPS (Backblaze B2 via rclone) |

Developer tools: VS Code or Cursor with Claude Code, Docker Desktop, Prisma Studio, Bruno or Postman (ingest tests), Cloudflare Tunnel (local Meta webhook testing).

---

## 4. Architecture

```
Client LP (WordPress page, custom HTML form + lead.js)
        │  POST /api/ingest/{client}/{lp}
        ▼
Caddy (HTTPS) ──► Next.js app (UI + REST API)
                       │
          ┌────────────┼──────────────┐
          ▼            ▼              ▼
     PostgreSQL      Redis      Web Push / Email
                       │
                       ▼
                 Worker (BullMQ)
      Meta Graph API · CAPI · outbound webhooks · retries

Meta Lead Ads webhook ──► /api/meta/webhook ──► queue ──► Graph API fetch
```

Two processes from one codebase:

- `app`: UI and API. Saves leads quickly and returns.
- `worker`: slow or unreliable calls (Meta, webhooks, notifications, enrichment).

Compose services on the VPS: `app`, `worker`, `db`, `redis`, `caddy`, `backup`.

---

## 5. Data model

### 5.1 Core tables

```
clients
  id, name, slug (unique), status, created_at

users
  id, client_id (nullable for Sabhi staff), name, email (unique),
  password_hash, role, status, last_login_at

user_lp_access
  user_id, lp_id

landing_pages
  id, client_id, name, lp_key (unique, public), allowed_domains (text[]),
  status (active | paused), current_form_version, created_at

form_fields                      -- the field registry (dynamic fields)
  id, lp_id, field_key, label, input_type, options (jsonb),
  role (phone | email | name | null), is_hidden, first_seen_at, last_seen_at

form_versions
  id, lp_id, version_hash, field_keys (text[]), created_at

leads
  id, client_id, lp_id, form_version_id, status_id, owner_id,
  submission_id (unique per lp), name, phone_normalised, email_normalised,
  answers (jsonb), tracking (jsonb), consent (jsonb), source,
  created_at, updated_at, last_activity_at

pipeline_stages
  id, client_id, name, position, is_won, is_lost, meta_event_name (nullable)

lead_events
  id, lead_id, type (created | status_changed | note | assigned | call | whatsapp | meta_sent),
  payload (jsonb), actor_id, created_at

notes                            -- or fold into lead_events
  id, lead_id, author_id, body, created_at

integrations
  id, client_id, type (meta | whatsapp | webhook), config (encrypted jsonb), status

outbound_deliveries
  id, lead_id, integration_id, attempt, status, response_code, error, created_at

audit_log
  id, actor_id, client_id, action, target, created_at
```

Indexes: `leads (client_id, created_at)`, `leads (lp_id, created_at)`, `leads (phone_normalised)`, `leads (email_normalised)`, unique `leads (lp_id, submission_id)`, GIN index on `leads.answers` (jsonb_path_ops).

### 5.2 Dynamic fields: how they work

- Lead answers are stored in `leads.answers` (jsonb), keyed by `field_key`.
- The registry (`form_fields`) defines what each LP's fields are: label, type, options.
- New field key seen in an LP → registered automatically → shows as a new column with a "new" badge.
- Label change → stored as a registry update; old answer data is never rewritten.
- Field removed from the form → kept in the registry, marked hidden, data preserved.
- Each distinct field set gets a `form_version` (hash of keys + types). Leads record their version so old leads show blanks for fields they never had.
- No `ALTER TABLE` per field. Columns in the UI are generated from the registry.
- If a field needs fast filtering or reporting later (e.g. quiz score), add a deliberate index on that key.

### 5.3 Field key rules

- Derived from the input `name`, lowercased, non-alphanumeric characters replaced with `_`, max 64 characters.
- Duplicate keys within one submission: suffix `_2`, `_3`.
- Reserved keys (`submission_id`, `lp`, `tracking`) cannot be used as field keys.

### 5.4 Core-field roles

`data-role` (or detected by input type) marks special fields: `name`, `phone`, `email`. Only these feed the core columns and dedupe. Everything else stays in `answers`.

---

## 6. Ingest API

### 6.1 Endpoint

`POST /api/ingest/{clientSlug}/{lpKey}`
Content-Type: `application/json`
Public: yes (no login). Protected by LP key, origin check, rate limit and Turnstile.

### 6.2 Request

```json
{
  "submission_id": "a8f3c1e2-…",
  "turnstile_token": "…",
  "fields": [
    { "key": "name",   "type": "text",   "label": "Your name", "role": "name",  "value": "Asha" },
    { "key": "phone",  "type": "tel",    "label": "Mobile",    "role": "phone", "value": "9876543210" },
    { "key": "q1",     "type": "radio",  "label": "How often do you post?",
      "options": ["Never", "Weekly", "Daily"], "value": "Weekly", "score": 2 },
    { "key": "budget", "type": "select", "label": "Budget", "options": ["<1L", "1-5L", "5L+"], "value": "5L+" }
  ],
  "tracking": { "utm_source": "meta", "utm_campaign": "…", "fbclid": "…", "fbp": "…", "fbc": "…", "page_url": "…" },
  "consent": { "given": true, "text": "I agree to be contacted", "at": "2027-01-10T10:00:00Z" }
}
```

### 6.3 Server steps

1. Resolve client and LP by slug and key. Reject if inactive.
2. Check `Origin` against `allowed_domains`. Reject otherwise.
3. Verify Turnstile token.
4. Rate limit per IP and per LP.
5. Validate with Zod: field count limit (e.g. 100), value length limit (e.g. 5,000 characters), required structure.
6. Normalise phone (E.164, default +91 for 10-digit numbers) and email (lowercase, trimmed).
7. Check idempotency: if `(lp_id, submission_id)` exists, return the existing lead, do not duplicate.
8. Dedupe: same phone or email for the same client within 30 days → new lead is still saved and linked as a duplicate (`lead_events` entry), flagged in UI.
9. Register new fields and form version if the field set changed.
10. Save lead in a transaction (lead + answers + tracking + consent + `created` event).
11. Enqueue jobs: notification, Meta enrichment (optional), outbound webhook forwarding.
12. Respond `202 Accepted` with `{ "lead_id": "…", "status": "received" }`.

### 6.4 Responses

| Code | Meaning |
|---|---|
| 202 | Saved (or already saved, idempotent) |
| 400 | Malformed payload |
| 403 | Origin not allowed or LP paused |
| 404 | Unknown client or LP |
| 422 | Validation failed (returns field errors) |
| 429 | Rate limited |
| 500 | Server error (snippet keeps the lead in local retry queue) |

CORS: allow only the LP's registered origins. Send `Access-Control-Allow-Origin` for the matching origin only.

---

## 7. `lead.js` snippet

### 7.1 Embed

```html
<script src="https://ingest.sabhidigital.com/lead.js"
        data-client="ritu-agarwal"
        data-lp="webinar-jan-2027"
        defer></script>
```

### 7.2 Behaviour

- Attaches to every `<form data-lead-form>` on the page.
- On submit: prevents default, reads all named inputs, selects, textareas, checkboxes and radios.
- Builds the `fields` array with type, label (from `<label for>` or nearest label text), options (for select/radio/checkbox), value, score (`data-score`) and role (`data-role`).
- Multi-value checkboxes sent as arrays.
- Adds `tracking` from UTM parameters (stored on first visit in cookie or localStorage), `fbclid`, `_fbp` and `_fbc` cookies, and page URL.
- Generates `submission_id` (UUID v4) once per submit attempt.
- Gets a Turnstile token from the widget if present.
- Posts with `fetch`. On success: fires the form's existing thank-you behaviour or the `data-redirect` URL.
- On network failure or 5xx: stores the payload in `localStorage` (key `sabhi_pending_leads`) and retries on the next page load and every 30 seconds while the page is open. Max 10 retries, then dropped with a console warning.
- Disables the submit button while sending to prevent double submits.
- Never blocks the page if the script fails.

### 7.3 Form rules for LP builders

- `name` attributes describe the question: `budget`, `q1`, `city`, not `input7`.
- `data-role="phone" | "email" | "name"` on core fields.
- `data-score="N"` on quiz options that have points.
- Every field should have a `<label>`.
- Form carries `data-lead-form`.

---

## 8. WordPress plugin: "Sabhi Lead Connector"

- Installed on each client's WordPress site.
- Settings page: client slug, ingest base URL, default Turnstile site key.
- Per-page meta box: LP key (the LP the page represents).
- Prints the `lead.js` tag in the footer only on pages with an LP key.
- Asks caching plugins (WP Rocket, LiteSpeed, W3 Total Cache) to exclude `lead.js` from minify and defer.
- Self-update: checks our server for new plugin versions.
- Ships with no form builder; forms remain custom HTML.

Compatibility checks before rollout: Gutenberg Custom HTML block keeps `data-*` attributes, Hostinger WordPress hosting allows the plugin, and existing webinar date tool (`webi.php`) still works alongside.

---

## 9. Meta integration

### 9.1 Lead Ads (inbound)

- Meta app with `leads_retrieval`, `pages_manage_ads`, `pages_read_engagement` permissions.
- Webhook endpoint `/api/meta/webhook` verifies signature (`X-Hub-Signature-256`) and handles `leadgen` events.
- Worker fetches the lead via Graph API using the `leadgen_id`, maps its fields into the same registry and `answers` structure, and sets `source = meta_instant_form`.
- Page access tokens stored encrypted (AES-256-GCM, key in environment, not in repo). Token expiry or revocation raises an alert.

### 9.2 Conversions API (outbound)

- Each pipeline stage can map to a Meta event (e.g. Qualified → `Lead` with custom event, Won → `Purchase`).
- Worker sends the event with the lead's `event_id`, hashed email and phone (SHA-256, normalised), `fbp`/`fbc`, and event time.
- Each send is logged in `outbound_deliveries`. Failures retry with backoff; after max attempts, flagged in UI.
- Test events mode before going live.

---

## 10. Lead operations

- Notifications on new lead: in-app, Web Push, email. Configurable per user and per LP.
- Quick actions: `tel:` link, WhatsApp deep link (`https://wa.me/91…`), copy phone, mark status.
- Assignment: manual, or round-robin per LP (later).
- Notes and activity timeline per lead.
- Follow-up date with reminder.
- Duplicate badge when phone or email was seen before.

---

## 11. Screens

1. **Login**
2. **Dashboard:** today's leads, by LP, by status, quiz summary, Meta send status.
3. **Clients** (Sabhi only): list, create, edit, invite users.
4. **LPs** (per client): list, create LP (name, domain, generated LP key, snippet code to copy), status toggle.
5. **Field manager** (per LP): registry view, rename labels, set role, hide fields, see first seen date and form versions.
6. **Leads table:** columns generated from the registry; filters (LP, status, owner, date, source, any answer value); bulk assign; export CSV (same columns as screen).
7. **Lead detail:** all answers grouped as in the form, tracking, timeline, notes, status, owner, follow-up.
8. **Pipeline:** Kanban by stage, drag to change; toggle to spreadsheet view on the same filters.
9. **Quiz view** (per LP): answer counts per question, score distribution.
10. **Integrations:** Meta connection status, outbound webhooks, test buttons.
11. **Users and roles.**
12. **Audit log** (Sabhi admin).

---

## 12. Security and compliance

- Passwords: argon2id. Sessions: httpOnly, secure, SameSite=Lax cookies.
- Tenant isolation: every query scoped by `client_id` in the data layer; automated tests for cross-tenant access.
- Secrets (Meta tokens, SMTP, VAPID private key) in environment variables or encrypted config; never in repo or browser.
- Public ingest: LP key only (not secret), origin allow-list, Turnstile, rate limits, payload size limit.
- HTTPS everywhere via Caddy. HSTS on.
- Personal data: store consent with timestamp and text. Keep audit log of views and exports. Support deletion of a lead on request (hard delete with audit entry).
- India's DPDP Act: privacy notice on LPs, purpose limitation, retention rule (proposed: 24 months after last activity, then anonymise).
- Backups encrypted before leaving the VPS.
- Least-privilege DB user for the app; migrations run by a separate user.

---

## 13. Environments

- `local`: Docker Compose with Postgres and Redis, seed script with two demo clients and sample LPs.
- `staging`: subdomain on the VPS, test LP pages, Meta test leads.
- `production`: VPS, Caddy, real clients.

Deploy: merge to `main` → GitHub Actions runs tests → builds images → SSH deploy → migrations → health check. Rollback by previous image tag.

---

## 14. Build phases

### Phase 1: Foundation (week 1)
- Repo, Docker Compose, CI pipeline, staging environment
- Prisma schema for tenants, users, LPs, leads, registry, events
- Auth, roles, tenant scoping layer with tests
- Client and LP admin screens (create LP, copy snippet)

**Done when:** a Sabhi admin can create a client and LP, a client user can log in and see only their own client, and tests prove isolation.

### Phase 2: Ingestion (week 2)
- Ingest endpoint with all validation, dedupe and idempotency
- Field registry and form versioning
- `lead.js` snippet with retry queue
- Turnstile, rate limit, origin check
- Test on one real WordPress LP with a quiz-style form

**Done when:** a real submission from the LP lands in the database with all fields, a repeat submit creates no duplicate, a new field appears as a registry entry, and a network-failure test recovers.

### Phase 3: Lead operations (week 3)
- Leads table driven by registry, filters, search, CSV export
- Lead detail page, notes, status, owner, follow-up
- Notifications: in-app, Web Push, email
- Quick call and WhatsApp links
- Field manager screen

**Done when:** a team member can find, assign, call and update a lead from the table, and the CSV matches the screen.

### Phase 4: Pipeline and quiz view (week 4)
- Kanban and spreadsheet pipeline on shared filters
- Stage history, won and lost reasons
- Quiz summary per LP

**Done when:** moving a card changes status, is logged in the timeline, and shows in the table.

### Phase 5: Meta (week 5)
- Lead Ads webhook and Graph API fetch
- Encrypted token storage and expiry alerts
- CAPI stage mapping and outbound sends with logs
- Test event mode

**Done when:** a Meta test lead appears in the same table with the same structure, and a status change sends a test CAPI event that shows in Meta Events Manager.

### Phase 6: WordPress plugin and rollout (week 5–6)
- Sabhi Lead Connector plugin with settings and per-page LP key
- Rollout to first client, then others
- Monitoring: UptimeRobot on ingest, Sentry alerts

### Phase 7: Later
- WhatsApp Cloud API
- Outbound webhooks to com.bot / Pabbly
- Round-robin assignment
- Social media scheduling module
- Database connection for the video tool

---

## 15. Acceptance tests (must pass before each client goes live)

- [ ] Submit an LP form with 10+ fields of mixed types; all values appear in the lead.
- [ ] Add a new field to the HTML form; a new column appears without code changes.
- [ ] Submit the same form twice quickly; one lead only.
- [ ] Submit from a non-allowed domain; rejected with 403.
- [ ] Turn off network, submit, turn on network; lead arrives once.
- [ ] Phone with spaces or +91 prefix is normalised; duplicate is flagged.
- [ ] Client A user cannot see Client B leads (API and UI).
- [ ] CSV export column order and values match the table.
- [ ] Meta test lead arrives in the table.
- [ ] Status change sends a CAPI test event that Meta shows.

---

## 16. Open questions

1. Hosting of each client's WordPress site: Hostinger shared/managed, or the VPS?
2. Admin access to each client's WordPress and Meta Business accounts?
3. Email provider: Resend or existing SMTP?
4. Lead retention period (proposed 24 months after last activity)?
5. Pipeline stages: one standard set for all clients, or custom per client?
6. Client logins from day one, or Sabhi-only until phase 3 is stable?
