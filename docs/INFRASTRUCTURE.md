# Infrastructure

Factual snapshot of Atlas Review **as currently built** in this repository and Replit workspace. Inspected from `package.json`, `.replit`, `shared/schema.ts`, `server/*`, env **names** present at doc time, and related config. Values of secrets are omitted. Items that could not be confirmed from code or runtime are marked **UNVERIFIED**.

---

## 1. Purpose

Atlas Review is a multi-specialty surgical board-prep web app (Plastic Surgery and Orthopaedics) with question banks, timed tests, spaced repetition, notes/bookmarks, and subscription gating. One Express+Vite deployment serves both marketing domains and per-user question-bank selection.

---

## 2. Stack

| Layer | Choice | Version (resolved / declared) |
|--------|--------|-------------------------------|
| Frontend | React, Vite, TypeScript, Tailwind CSS, shadcn/Radix, Wouter, TanStack Query, Framer Motion | React **18.3.1**, Vite **6.4.2**, TypeScript **5.9.3** (package declares `^5.8.3`) |
| Backend | Express (same Node process serves API + SPA), `tsx` runner | Express **4.22.1** (package `^4.21.2`) |
| ORM | Drizzle ORM + `drizzle-kit` | drizzle-orm **0.45.2**, drizzle-kit **0.31.7** |
| DB driver | `pg` (node-postgres) | **8.16.3** |
| Runtime | Node.js (Replit module `nodejs-20`) | Node **v20.20.0**, npm **10.8.2** |
| Package manager | npm (`package-lock.json`); `bun.lock` also present | **UNVERIFIED** whether Bun is used in deploy |

There is **no** `replit.nix` in the repo. Nix channel and modules are declared in `.replit`:

- `[nix] channel = "stable-25_05"`
- `modules = ["nodejs-20", "web", "postgresql-16"]`

---

## 3. Repo structure (top level)

| Path | Role |
|------|------|
| `client/` | Vite React app (`index.html`, `src/`, `public/` static assets including favicons and `question-images/`) |
| `server/` | Express entry (`index.ts`), routes, auth, Stripe, email/Slack, jobs, scripts, content bootstrap |
| `shared/` | Drizzle schema, Zod schemas, specialty/SEO/question-format shared modules |
| `drizzle/` | SQL migrations + Drizzle meta journal |
| `docs/` | Operational notes (institutional codes, subscription reset, section ID maps, etc.) |
| `attached_assets/` | Repo-attached media (e.g. logos referenced via `@assets`) |
| `public/` | Extra root static files (not the Vite `client/public` tree) |
| `dist/` | Production frontend build output (`dist/public`) |
| `.replit` | Replit modules, deployment, workflows, ports, some shared env |
| `.env` | Gitignored local env (loaded by `server/index.ts` only if key unset) |
| `package.json` / `vite.config.ts` / `drizzle.config.ts` / `tsconfig*.json` | Tooling |

---

## 4. Database

### Engine and host

- **Engine:** PostgreSQL 16 (Replit module `postgresql-16`).
- **App connection:** `DATABASE_URL` via `server/db.ts` (`Pool` + Drizzle).
- **Runtime observed (this workspace):** `DATABASE_URL` / `PGHOST` → host **`helium`**, database **`heliumdb`** (Replit Helium Postgres). SSL URL normalization for `sslmode=require` is applied in `normalizeDatabaseUrl`.
- **Also present in env:** `NEON_DATABASE_URL` → Neon (`*.aws.neon.tech` / `neondb`). **Not** used by the main app pool. Scripts such as `push:ortho` document that live targets must use explicit `IMPORT_DATABASE_URL` / deployment `DATABASE_URL`, not `NEON_DATABASE_URL`.

### Schema summary (tables in `shared/schema.ts`)

| Table | Purpose / key relations |
|-------|-------------------------|
| `sessions` | `connect-pg-simple` session store (`sid`, `sess`, `expire`) |
| `users` | Accounts; email unique (also lower(email) unique index); specialty + legacy entitlement columns |
| `login_connections` | → `users`; OAuth provider links |
| `password_reset_tokens` | → `users`; hashed one-time reset tokens |
| `auth_handoff_tokens` | Cross-domain specialty handoff |
| `pending_checkout_plans` | Stripe checkout handoff (user → plan) |
| `sections` / `subsections` / `questions` | Q-bank hierarchy; questions → subsections → sections; `specialtyId` on sections |
| `content_promotions` | Per-specialty content bootstrap ledger |
| `question_responses` | → users, questions; answer progress |
| `test_sessions` | Timed/mock tests; → users; specialty-scoped |
| `notes` / `highlights` / `bookmarks` / `spaced_repetitions` | Study tools → users (+ question/subsection as applicable) |
| `subscription_plans` | Per-specialty paid plans + Stripe link/product fields |
| `subscription_transactions` | → users, plans; Stripe PI/invoice ids |
| `user_specialty_subscriptions` | Per-(user, specialty) entitlement (status, plan, Stripe sub id, institutional fields) |
| `institutional_codes` / `user_institutional_code_redemptions` | Institutional access codes |
| `question_reports` / `contact_messages` | Support / QA feedback |
| `question_revisions` / `agent_job_runs` / `agent_lessons` / `agent_finetune_examples` | Feedback-agent audit / memory |
| `oral_board_sessions` / `oral_board_messages` | Oral boards coach threads |

### Migrations approach

1. **Drizzle SQL** under `drizzle/` (`npm run db:generate` / `npm run db:push`; config: `drizzle.config.ts` → schema `./shared/schema.ts`).
2. **Runtime DDL** in `server/storage.ts` (`CREATE TABLE IF NOT EXISTS` / `ALTER TABLE … IF NOT EXISTS`) for multi-specialty and other evolutionary columns—applied on storage startup paths.
3. **Content bootstrap** (`server/content/contentBootstrap.ts`): on server start, insert-only promote of bundled `server/data/content/{prs,ortho}.content.json` into the connected DB (skippable with `CONTENT_BOOTSTRAP=0`).

---

## 5. Auth

- **Active implementation:** `server/customAuth.ts` (wired from `server/routes.ts` via `setupAuth` / `isAuthenticated`).
- **Methods:**
  - Email/password (bcrypt, 12 rounds); register/login/logout; password reset via hashed tokens + Resend email.
  - Optional Google OAuth (`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`); enabled only when both set. Login UI currently hardcodes `SHOW_GOOGLE_SIGN_IN = false`.
  - Cross-specialty domain handoff tokens (`/api/auth/handoff`, consume on destination host).
- **Session store:** `express-session` + `connect-pg-simple` → Postgres table `sessions`. Cookie is **host-only** per specialty apex (not shared across `prs-atlas.com` / `ortho-atlas.com`). Requires `SESSION_SECRET`.
- **Legacy / unused in routes:** `server/replitAuth.ts` (Replit OIDC / Passport, `REPL_ID`, `ISSUER_URL`) — **not imported** by current `routes.ts`.
- **Roles / access flags (no full RBAC):**
  - Subscriber / trial / institutional entitlement via specialty subscription rows.
  - `users.tester` for Atlas Trainer beta.
  - Admin operations gated by shared **`ADMIN_CODE`** header/body (default in code if unset: `"1127"`).
  - Forever free access: email allowlist in `server/adminGrantedAccess.ts` (+ optional `ADMIN_FOREVER_ACCESS_EMAILS`).

---

## 6. Third-party services

| Service | SDK / integration | Used for | User / learner data sent? |
|---------|-------------------|----------|---------------------------|
| **Stripe** | `stripe` SDK; Payment Links + Checkout; webhook | Subscriptions, fulfill, cancel, reconciliation | Yes: email, user id (metadata / `client_reference_id`), payment identifiers. No clinical PHI. |
| **Resend** | `resend` (`server/email.ts`) | Password reset, question-report email, support form email | Yes: recipient email, names, message bodies / report text. |
| **Slack** | Incoming webhooks (`fetch` to `hooks.slack.com`) | Question reports, support form, signup & purchase alerts | Yes: emails, names, specialty, question stems/choices/answers (reports), purchase amounts. |
| **OpenAI** | `openai` | Oral Boards Assistants API (`OPENAI_ASSISTANT_*`); chat bubble assistant (`OPENAI_CHATBUBBLE_*`); question generation / ortho scripts (`OPENAI_API_KEY` or `OPENAI_QUESTION_GENERATION_*`) | Oral/chat: user message text. Generation: educational vignette prompts + reference text—not live patient chart data. |
| **Anthropic** | `@anthropic-ai/sdk` | Feedback learning job; rephrase/rescreen scripts (`CLAUDE_API_KEY`) | Question text + user-submitted report messages (not payment card data). |
| **Google OAuth** | Direct token/userinfo HTTP (when configured) | Optional sign-in | Yes: Google profile email/name on first login. |

No SendGrid package remains (historically replaced by Resend per `replit.md`).

There is **no real patient EHR integration**. Content is board-style **educational** clinical vignettes. Still treat emails, reports, and oral-board transcripts as personal/sensitive.

---

## 7. Environment variables (names and purpose only)

### Core / hosting

| Name | Purpose |
|------|---------|
| `PORT` | HTTP listen port (deploy/workflow uses 5000) |
| `NODE_ENV` | `production` vs development behavior |
| `DATABASE_URL` | Primary Postgres connection |
| `SESSION_SECRET` | Session cookie signing |
| `CANONICAL_PUBLIC_ORIGIN` | Optional origin override (dev/shared Replit env sets `https://prs-atlas.com`) |
| `APP_URL` / `APP_BASE_URL` / `VITE_APP_URL` | Non-prod URL overrides (auth/checkout redirects) |
| `CONTENT_BOOTSTRAP` | Set `0` to skip q-bank file promotion on boot |

### Auth / admin

| Name | Purpose |
|------|---------|
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google OAuth |
| `PASSWORD_RESET_TOKEN_TTL_MS` | Reset token lifetime |
| `ADMIN_CODE` | Shared admin API gate |
| `ADMIN_FOREVER_ACCESS_EMAILS` | Extra forever-access emails |
| `QUESTION_IMPORT_API_KEY` | Auth for question import API |
| `ENABLE_ADMIN_GENERATED_QUESTIONS_UI` | Feature flag for admin generated-questions UI |
| `TESTER_REDIRECT_SECRET` / `TESTER_VERIFY_SECRET` | Atlas Trainer token HMAC / verify |
| `FEEDBACK_AGENT_SECRET` | Optional gate for feedback-agent trigger |
| `ISSUER_URL` / `REPL_ID` | Replit Auth (legacy file only) |

### Email / Slack

| Name | Purpose |
|------|---------|
| `RESEND_API_KEY` / `RESEND_FROM_EMAIL` | Outbound email |
| `SLACK_WEBHOOK_URL` | Fallback Slack incoming webhook |
| `SLACK_QUESTION_REPORTS_WEBHOOK_URL` | Question reports channel |
| `SLACK_SUPPORT_WEBHOOK_URL` | Support form channel |
| `SLACK_GROWTH_WEBHOOK_URL` | Signups + purchases fallback |
| `SLACK_SIGNUPS_WEBHOOK_URL` / `SLACK_PURCHASES_WEBHOOK_URL` | Optional split growth channels |

### Stripe

| Name | Purpose |
|------|---------|
| `STRIPE_SECRET_KEY` | Stripe API (test or live) |
| `STRIPE_LIVE_SECRET_KEY` | Optional live key when default is test |
| `STRIPE_WEBHOOK_SECRET` | Webhook signature (`whsec_…`) |
| `STRIPE_RECONCILIATION_INTERVAL_MS` | In-process reconcile interval (default 3 days) |
| `STRIPE_PAYMENT_LINK_*` / `STRIPE_PAYMENT_LINK_ORTHO_*` (+ `_NO_TRIAL`) | Payment Link URL overrides |
| `STRIPE_PRODUCT_*` / `STRIPE_PRODUCT_ORTHO_*` | Product id overrides |
| `STRIPE_YEARLY_PAYMENT_LINK_PREFILLED_PROMO_CODE` | Present in env; **UNVERIFIED** code path usage |
| `RUN_SUBSCRIPTION_RESET` / `CONFIRM_RESET_ALL_SUBSCRIPTION_DATA` | Dangerous one-shot subscription wipes |

### AI / jobs

| Name | Purpose |
|------|---------|
| `OPENAI_API_KEY` / `OPENAI_QUESTION_GENERATION_API_KEY` / `OPENAI_QUESTION_GENERATION_MODEL` | Q-gen / scripts |
| `OPENAI_ASSISTANT_API_KEY` / `OPENAI_ASSISTANT_ID` | Oral boards |
| `OPENAI_CHATBUBBLE_API_KEY` / `OPENAI_CHATBUBBLE_ASSISTANT_ID` | In-app chat bubble |
| `CLAUDE_API_KEY` / `CLAUDE_REPHRASE_MODEL` / `FEEDBACK_AGENT_MODEL` | Anthropic jobs/scripts |
| `QUESTION_GENERATION_ENABLED` / `QUESTION_GENERATION_INTERVAL_MS` | Schedule question gen |
| `FEEDBACK_AGENT_*` | Enable, interval, period, max updates, run-on-start, all-history |
| `TOO_EASY_AGENT_*` | Enable, thresholds, interval, period, run-on-start, list size |

### Script / import helpers (ops only)

`IMPORT_DB`, `IMPORT_DATABASE_URL`, `IMPORT_PATH`, `SPECIALTY`, `MODE`, `DRY_RUN`, `NEON_DATABASE_URL` (env only; not app pool), `QUESTION_REFERENCE_PATH`, `FLAG_PATH`, many `ORTHO_*` knobs for generation/validate/push scripts.

**Present in this workspace env at inspection (values redacted):** among others `DATABASE_URL`, `NEON_DATABASE_URL`, `SESSION_SECRET`, `RESEND_API_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `OPENAI_*`, `CLAUDE_API_KEY`, `SLACK_QUESTION_REPORTS_WEBHOOK_URL`, `SLACK_SUPPORT_WEBHOOK_URL`, `ADMIN_CODE`, Replit platform vars (`REPL_*` / `REPLIT_*`).

`.replit` `[userenv.shared]` also sets `PORT`, `CANONICAL_PUBLIC_ORIGIN`, `OPENAI_ASSISTANT_ID`, and `QUESTION_IMPORT_API_KEY` (see §13).

---

## 8. File / object storage

- **No** cloud object store (no GCS/S3/Replit Object Storage SDK in dependencies or app code).
- **Question images:** uploaded with Multer to **local disk** `client/public/question-images/`, served as static `/question-images/…` (max 5 MB; jpeg/png/webp/gif). Staging dir `server/data/question-images/` is gitignored.
- **Bundled q-bank:** JSON under `server/data/content/`.
- **Static marketing assets:** `client/public/`, `attached_assets/`.
- Production SPA: `dist/public` via `serveStatic` after `npm run build`.

Images on disk are **not durable across ephemeral containers** unless the deploy filesystem persists or assets are committed/redeployed—**UNVERIFIED** how Replit Autoscale persists uploaded files across instances.

---

## 9. Build, run, deploy, domains

### Commands

| Command | Role |
|---------|------|
| `npm run dev` | `tsx watch` on `server/index.ts` + Vite middleware (port 5000) |
| `npm run build` | Vite build → `dist/public` |
| `npm run start` | `NODE_ENV=production tsx server/index.ts` |
| `npm run db:generate` / `db:push` | Drizzle migrations |
| Various `npm run import:*` / `content:*` / `*-agent` / `generate:*` | Ops scripts |

Listen address: **`0.0.0.0`**. Health: `GET /health`.

### Replit hosting (from `.replit`)

- **Deployment target:** `autoscale`
- **Build:** `npm run build`
- **Run:** `PORT=5000 npm run start`
- **Workflow “Start application”:** `npm run dev`, `waitForPort = 5000`
- **Ports:** local `5000` → external `80` (additional local ports mapped for tooling)

### Domains / DNS (from code)

| Host | Specialty |
|------|-----------|
| `prs-atlas.com`, `www.prs-atlas.com` | Plastic Surgery (`prs`) |
| `ortho-atlas.com`, `www.ortho-atlas.com` | Orthopaedics (`ortho`) |
| `train.prs-atlas.com` | Separate Atlas Trainer app (callback + CORS only; not this SPA) |

Canonical origins: `https://prs-atlas.com`, `https://ortho-atlas.com`. Host-based redirects/SEO in `server/seoPublic.ts`.

Replit also exposes a `*.replit.dev` / `REPLIT_DEV_DOMAIN` for the workspace. Exact DNS registrar and how custom domains are attached in the Replit UI: **UNVERIFIED** from repo alone.

---

## 10. Background jobs, cron, webhooks

**No external cron product** in-repo. Scheduling is **in-process `setInterval`** after listen in `server/index.ts`:

| Job | Gate | Default cadence |
|-----|------|-----------------|
| `reconcileStripeSubscriptions` | Stripe configured | Every `STRIPE_RECONCILIATION_INTERVAL_MS` or **3 days**; also runs once at start |
| Question generation | `QUESTION_GENERATION_ENABLED=true` | `QUESTION_GENERATION_INTERVAL_MS` or **24h** |
| Feedback learning (Anthropic) | `FEEDBACK_AGENT_ENABLED=true` | Tick hourly-ish; weekly watermark |
| Too-easy questions digest (Slack) | `TOO_EASY_AGENT_ENABLED=true` | Tick hourly-ish; weekly watermark |

Jobs can also be run via npm scripts (`generate:questions`, `feedback-agent`, `too-easy-agent`).

### Webhooks / HTTP hooks

| Endpoint | Auth | Events / role |
|----------|------|----------------|
| `POST /api/webhooks/stripe` | Stripe signature (`STRIPE_WEBHOOK_SECRET`); raw body | `checkout.session.completed`, `invoice.paid` (renewals); fulfill entitlements |
| Slack | Outbound only (incoming webhook URLs) | N/A inbound |
| `GET|POST /api/auth/verify-tester-token` | `TESTER_VERIFY_SECRET` | Called by `train.prs-atlas.com` |

---

## 11. Logging / monitoring

- **Logging:** `console.log` / `console.error` via `server/vite.ts` `log()` and ad hoc errors. Startup logs flag presence/absence of Resend, Slack, Stripe secrets.
- **Request timing:** middleware logs API path duration (and truncated JSON body for non-auth paths).
- **Timeouts:** 60s request timeout → HTTP 504; pool `connectionTimeoutMillis: 10000`.
- **Healthcheck:** `/health` → `{ ok: true }`.
- **No** Sentry, Datadog, OpenTelemetry, or structured log shipper found in dependencies or server code.

---

## 12. Replit-specific dependencies to replace for Google Cloud

| Replit concern | Current state | GCP migration note |
|----------------|---------------|--------------------|
| **Helium Postgres** (`PGHOST=helium`, `DATABASE_URL`) | Primary app DB | Move to Cloud SQL (Postgres) or equivalent; keep Drizzle/`pg` |
| **Neon URL in env** | Secondary / scripts only | Decide single source of truth; drop unused URL |
| **Secrets** | Replit Secrets + `.env` + some `.replit` userenv | Secret Manager / env on Cloud Run/GKE |
| **Autoscale deploy** | `.replit` `deploymentTarget = "autoscale"` | Cloud Run / GKE; multi-instance content lock already uses Postgres advisory locks |
| **Replit Auth** | File exists; **not** wired | Do not port; keep custom auth + Google OAuth |
| **`REPLIT_DB_URL`** | Present in platform env | **Not referenced** in app source—ignore |
| **Object Storage** | Not used | Introduce GCS (or similar) for `question-images` instead of local disk |
| **Dev domain / `REPL_ID`** | Platform / legacy auth | Replace with real domains + OAuth client IDs |
| **In-process cron** | `setInterval` on web process | Cloud Scheduler + worker, or always-on single worker (Autoscale multi-instance will multiply job runs unless gated) |
| **Committed secrets in `.replit`** | See §13 | Must not ship to GCP as plaintext in VCS |

---

## 13. Known tech debt / security gaps

1. **`ADMIN_CODE` defaults to `"1127"`** in source if env unset (`server/routes.ts`).
2. **`QUESTION_IMPORT_API_KEY` is set in committed `.replit` `[userenv.shared]`** (secret in VCS).
3. **`TESTER_REDIRECT_SECRET` defaults to `"change-me-in-production"`** if unset.
4. **Forever-access admin emails hardcoded** in `server/adminGrantedAccess.ts` (plus env merge).
5. **Dual schema evolution:** Drizzle migrations + large runtime `ensure*` DDL—easy to drift across environments.
6. **Legacy entitlement columns on `users`** mirrored only for PRS; Ortho lives in `user_specialty_subscriptions`—easy to misuse.
7. **`replitAuth.ts` dead code** still in tree; schema comment still says sessions table is “mandatory for Replit Auth”.
8. **Google sign-in UI disabled** (`SHOW_GOOGLE_SIGN_IN = false`) even though server OAuth exists.
9. **Local-disk image uploads** fragile on multi-instance / ephemeral FS.
10. **In-process Stripe reconcile / AI jobs** can duplicate work on multiple Autoscale instances (**UNVERIFIED** whether production runs >1 instance).
11. **No APM / error tracking**; ops rely on platform logs.
12. **`react-router-dom` is a dependency** but app routing uses **Wouter**—likely unused weight.
13. **Educational clinical vignettes** + user reports go to LLM providers—ensure vendor DPAs and retention policies; not EHR PHI, but still sensitive.
14. **Subscription change endpoint** (`/api/subscription/change`) can activate plans without Stripe in code path—treat as privileged/legacy risk if exposed without further controls (**verify auth + admin expectations before GCP cutover**).

---

*Generated from repository inspection. Re-verify env presence and DNS in the Replit / registrar consoles before migration.*
