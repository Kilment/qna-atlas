# Question-fix cloud agent

A cloud agent (Opus 5.5) fixes question stems, answer choices and explanations, and finds
open-access PubMed Central images for questions without one. Production is a separate database
with no credentials in the workspace, so the agent writes through a **token-protected HTTP API on
the live app**, not through a database URL and not through the insert-only content pipeline.

```
Cursor cloud agent ──HTTPS + bearer token──▶ live app /api/internal/question-agent/*
                                                   │  tier rules, caps, stale-write check, audit
                                                   ├─ safe text fix ──▶ questions + question_revisions (applied)
                                                   └─ everything else ─▶ question_agent_proposals ─▶ Slack link
                                                                          human opens signed review page ─▶ Approve / Reject
```

The agent runbook is `.cursor/skills/question-fix-agent/SKILL.md`.

## Approval tiers

Defined in `shared/questionAgentTiers.ts` (covered by `server/questionAgent/tiers.test.ts`).

| Tier | Changes | Result |
| --- | --- | --- |
| Auto-apply | typos and formatting; explanation wording with the key unchanged; removing "photograph is shown" phrases; cosmetic choice wording (similarity >= 0.9, >= 0.95 for the keyed choice, identical numbers and identical meaning-flipping words) | Applied at once, revision recorded, short Slack note |
| Proposal | key letter change; choice count or letters changed; non-cosmetic choice or stem change (including a swapped content word or a changed patient sex, age term or pronoun); drastic explanation shortening; unhide; hide; **any image attach, replace or removal** | Stored as a pending proposal, Slack message with a signed review link |

Images are never auto-published.

## Endpoints

All under `/api/internal/question-agent`, `Authorization: Bearer $QUESTION_AGENT_TOKEN`. A missing or
wrong token returns 404 (the API does not advertise itself) and repeated failures are rate limited.

| Method and path | Purpose |
| --- | --- |
| `GET /queue?category=reported,flagged,missing_media&specialty=&limit=&offset=&includePending=` | Work queue with `baseHash`, reports, media-promise detection, `pendingProposalId` |
| `GET /question/:id` | One question with recent revisions and proposals |
| `POST /fix` (`?dryRun=true`) | Submit a fix. Requires `questionId`, `runId`, `rationale`, `baseHash`. Optional `question`+`answer`, `imageUrl`+`imageAlt`+`imageAttribution`, `unhide`, `removeImage` (detach a wrong image), `hide` (flag and hide the question), `moveImageFromQuestionId` (reassign: attach the image currently on another question to this one, then remove it there and hide that question if its stem still promises media; refused while the source has a pending proposal, and goes stale if the source image changes before approval). Image removal, hiding and moves are always proposals; `removeImage` needs `hide` if the stem still refers to an image |
| `POST /image` (multipart `file`) | Upload an image (5 MB, JPEG/PNG/WebP/GIF, magic-byte checked) to the bucket |
| `POST /revert` | Undo a revision (`revisionId`, `runId`, `rationale`) |
| `GET /proposals` | List proposals |
| `GET /export?specialty=` | Read-only content snapshot for the prod-to-repo pull |

Human review, no token: `GET|POST /api/question-agent/review/:id?exp=&sig=`. The link is
HMAC-signed with `QUESTION_AGENT_APPROVAL_SECRET` and expires after 7 days. The agent does not
know that secret, so it cannot approve its own proposals. Slack incoming webhooks cannot render
buttons, so the link opens a page with Approve and Reject forms.

Safeguards on `/fix`: stale-write check (`baseHash` must match the current question), required
`runId` and `rationale`, question format validation, audit row in `question_revisions`
(`source` is `cloud_agent`, `cloud_agent_approved` after approval, `cloud_agent_revert` for
reverts), unhide blockers (radiographic or "see the image" stems cannot be unhidden without an
image), and caps (below). `?dryRun=true` classifies and validates without writing.

## Production setup (manual, once)

Set these in the **production deployment's Secrets** (not `.replit`):

| Variable | Purpose |
| --- | --- |
| `QUESTION_AGENT_TOKEN` | Bearer token for the agent (at least 24 random characters). Without it the API is disabled |
| `QUESTION_AGENT_APPROVAL_SECRET` | Signs Slack review links (at least 24 random characters, different from the token, not given to the agent) |
| `CANONICAL_PUBLIC_ORIGIN` | Public origin used to build review links, for example `https://prs-atlas.com` |
| `SLACK_QUESTION_AGENT_WEBHOOK_URL` | Slack incoming webhook for proposals (falls back to the question-reports webhook) |
| Image bucket | Either Replit Object Storage (`IMAGE_BUCKET_ID`, or the default bucket) or S3 (`S3_BUCKET`, `S3_REGION`, optional `S3_ENDPOINT`, plus standard AWS credentials). Force with `QUESTION_AGENT_IMAGE_DRIVER=replit|s3`. The `local` driver writes to `server/data/agent-images` and is for development only |
| `QUESTION_AGENT_MAX_AUTO_PER_RUN` (25), `QUESTION_AGENT_MAX_AUTO_PER_DAY` (200), `QUESTION_AGENT_MAX_PROPOSALS_PER_RUN` (50) | Optional caps |
| `ADMIN_CODE` | **Must be set in production.** See the security changes below |

Set these in the **Cursor cloud agent environment**: `QUESTION_AGENT_BASE_URL` (the live app),
`QUESTION_AGENT_TOKEN`, `CLAUDE_API_KEY` or `ANTHROPIC_API_KEY` (required for the two-model vision
check on images; also enables optional `agent:pmc-image --score`), and optionally `NCBI_API_KEY` /
`NCBI_CONTACT_EMAIL` for NCBI E-utilities.

Why a bucket: Replit Autoscale deployments have an ephemeral, unshared disk, so files written by
one instance vanish and are invisible to others. Agent images are stored in the bucket and served
by the app at `/question-images/agent/<uuid>.<ext>` (nosniff, immutable caching).

## Image policy

- Source: NCBI PMC search (E-utilities `esearch`/`esummary`, `open access` + CC BY / CC0 / CC BY-SA
  license filters; optional `NCBI_API_KEY` and `NCBI_CONTACT_EMAIL` env vars), then the public PMC Open Access
  dataset for per-article metadata (authoritative license), XML and figures (`npm run agent:pmc-image`).
  Prefer `[Title]` phrase queries; broad queries return too many weak hits. Retries on 429/5xx are
  built in.
- Allowed licenses: CC0, CC BY, CC BY-SA, public domain. NC and ND licenses are rejected in the tool
  **and** again on the server (`shared/imageLicense.ts`).
- Figures that look third party (reproduced, adapted, copyright, courtesy of, or their own
  permissions block) are rejected. Captions **and article titles** that leak the diagnosis (via
  `--avoid`) are rejected — the credit line includes the article title and is shown under the image.
  Do not strip the title from attribution; pick a non-leaking article or reword the question.
- Downloaded candidates are downscaled to at most 1600 px and re-encoded to JPEG; they are never cropped.
- Attribution (credit, license, PMCID, source link) is stored on the question and shown under the
  image in the app.
- Authoritative image acceptance is `npm run agent:vision-check` (Opus 5.5 `claude-opus-5-5` and
  Sonnet 5.5 `claude-sonnet-5-5`, image ≤1568 px JPEG). Do not call the Anthropic SDK directly and
  do not call retired `claude-opus-4-1` / `claude-opus-4-1-20250805`. The script caches the shared
  rubric for 1 hour and the question text for 5 minutes; the image stays after those breakpoints.
  The Read tool’s text description of images is not reliable. Optional `agent:pmc-image --score`
  is only a single-model pre-screen (`QUESTION_AGENT_VISION_MODEL`, default `claude-opus-5-5`).
- If no acceptable licensed image is found after a reasonable search, **reword** the question so it
  does not require imaging (remove media phrases, describe the finding in text, remove the image /
  unhide as needed). Hide only as a last resort, always as a Slack proposal.

## Content pipeline interaction

`server/content/specialtyContent.ts` promotes repo content into a database insert-only (question
wording is never overwritten). Visibility, flagged and image fields used to sync unconditionally,
which would let a deploy revert an agent or admin edit made in production. They now sync only when
the row's `updated_at` is not newer than the incoming file's (last writer wins), covered by
`server/questionAgent/contentSync.test.ts`. `MODE=upsert npm run content:import` remains the manual
overwrite path.

### Production to repo, and reconciling dev-only fixes

```bash
export QUESTION_AGENT_BASE_URL=https://prs-atlas.com QUESTION_AGENT_TOKEN=...

# Snapshot production wording into server/data/content/<specialty>.content.json
npm run agent:pull-prod -- prs --dry-run     # diff summary only
npm run agent:pull-prod -- prs               # writes the file (refuses a >5% drop unless --force)

# Ship fixes that exist only in the workspace DB through the guarded API
npm run agent:reconcile -- prs               # dry run: classifies every difference
npm run agent:reconcile -- prs --apply --limit=25
```

`agent:reconcile` uses `DATABASE_URL` (the workspace DB) for its local side and never connects to
production. It only sends a fix when the workspace row is newer than the production row, uses the
production `baseHash`, and the same tier rules and caps apply, so key changes arrive as Slack
proposals. Rows that are new in the workspace travel with a normal deploy.

## Security changes made with this feature

- `ADMIN_CODE` no longer has a default (`1127`) and the check is timing-safe. If it is unset, the
  admin-code endpoints reject everything. The admin page no longer checks the code in the browser;
  it verifies with the server. **Set `ADMIN_CODE` in production before deploying.**
- `QUESTION_IMPORT_API_KEY` was removed from `.replit` (it was committed). **Treat the old value as
  leaked: generate a new one and set it in Secrets.** The import key check is now timing-safe.
- `docs/INFRASTRUCTURE.md` may still mention the old `ADMIN_CODE` default; update it if you keep
  that file.

## Coordination with the feedback learning job

`server/jobs/feedbackLearningJob.ts` (`FEEDBACK_AGENT_*`) also edits questions and writes
`question_revisions` (`source: feedback_agent`, capped by `FEEDBACK_AGENT_MAX_UPDATES`, default 15
per week). Both record to the same revision table, so every change is auditable and revertible. The
cloud agent's `baseHash` check protects it from overwriting a change made after it read the
question, but the feedback job is not aware of the agent, so they can both work on the same
reported question. The cloud-agent runbook works **`reported` first**, then `flagged`, then
`missing_media`. To avoid duplicate effort with the feedback job, either disable one
(`FEEDBACK_AGENT_ENABLED`), or point one of them away from `reported`. Filing a new proposal
supersedes any pending proposal on the same question. The cloud agent's own caps are the three
`QUESTION_AGENT_MAX_*` variables above.

## Scheduling

Use Cursor Automations to run the cloud agent on a schedule (for example weekly). Point it at this
repository, give it the runbook skill `question-fix-agent`, paste the prompt from
`docs/QUESTION_AGENT_CLOUD_PROMPT.md`, and add `QUESTION_AGENT_BASE_URL`, `QUESTION_AGENT_TOKEN`,
and `CLAUDE_API_KEY` or `ANTHROPIC_API_KEY` as its secrets (plus optional NCBI keys). This is a
separate interactive setup in Cursor and has not been created for you.

## Dry runs and the first pilot

- `POST /fix?dryRun=true` (CLI: `npm run agent:api -- fix file.json --dry-run`) returns the tier,
  the reasons and whether a cap would block it, and writes nothing. The runbook requires it before
  every real write. `agent:reconcile` is a dry run unless `--apply` is passed.
- First production run: 10 questions (`--limit=10`, `QUESTION_AGENT_MAX_AUTO_PER_RUN=10`). Review
  every applied item and every proposal, revert anything wrong with
  `npm run agent:api -- revert <revisionId>`, then raise the caps gradually.

## Tests

```bash
npm run test:question-agent
```

Runs the tier rules, auth and link signing, PMC figure vetting, content import (last-writer-wins,
snapshot validation), and an API integration suite against `DATABASE_URL` using a throwaway
question that is deleted afterwards. Do not point `DATABASE_URL` at production for tests.

## Reverting

Every applied change has a revision id. `npm run agent:api -- revert <revisionId> --run-id=... --rationale="..."`
restores the previous text (recorded as `cloud_agent_revert`). Pending proposals can be rejected from
the review page.
