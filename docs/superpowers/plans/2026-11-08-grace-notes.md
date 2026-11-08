# Grace Notes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Inside the social posts app, collect each week's Grace Notes content from contributors through permanent no-login links, remind them automatically, review the pastor's letter with Claude, and give Mitchell a block-by-block paste sheet. Event items are shared with the social pipeline.

**Architecture:** A new `src/gracenotes/` module in `apps/social-posts` (pure logic and repo functions, each with tests). It adds two route files: admin JSON under `/api/gracenotes/*` behind the hub login, and contributor page plus JSON under `/gn/<token>/*` on a new Traefik router that skips forward-auth. A 15-minute in-process clock creates the weekly issue and sends reminders through Resend. The admin UI is a new "Grace Notes" tab in its own `public/gracenotes.js`. The contributor page is a separate mobile page.

**Tech Stack:** TypeScript, Fastify 5, pg, node:test against `TEST_DATABASE_URL`, vanilla JS front end, Resend over `fetch`, Anthropic via the existing `callClaude`. No new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-11-05-grace-notes-design.md`

## Global Constraints

- Everything lives in `apps/social-posts`. No new dependencies (package.json keeps its 4 runtime deps).
- Schema is additive only: `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE … ADD COLUMN IF NOT EXISTS`, appended to `SCHEMA_SQL` in `src/schema.ts`.
- Dates are plain `YYYY-MM-DD` calendar dates in the `default_timezone` setting (default `America/New_York`). Never convert a date through UTC.
- Weekly defaults (settings, editable): send day Wednesday · create issue Sunday 18:00 · Monday 08:00 reminder · Tuesday 12:00 deadline plus final nudge to whoever is still outstanding.
- Reminder copy: subject `Grace Notes for {Wed Nov 11}: please check your piece`. Body opens: `Grace Notes goes out Wednesday. Check your piece by Tuesday noon:` followed by the link.
- Social marker copy: `New from {contributor name}` · `Changed by {contributor name}` · `needs graphic`.
- Contributor pages show only that contributor's own pieces, with no other contributor's name, email or content. Tokens come from `randomBytes(24).toString("base64url")`.
- Nothing is written to Mailchimp, and nothing is auto-created on the social side (no posts and no drafts).
- Grace at a Glance = every non-archived `events` row with a `start_date` in `[issueDate, issueDate + 27]`, sorted by date.
- Claude suggests and never rewrites. Every suggestion is accepted or rejected individually.
- Test files sit flat in `src/` as `gracenotes-*.test.ts` (the test script runs `dist/*.test.js`).
- Deploy note (not a task): take a DB backup before the first deploy.

## Review Focus

1. **A retired or wrong token** must get a plain 404 page and touch nothing. *(Task 8 test `gn route rejects retired token`.)*
2. **Pasted Word/Google Docs HTML** (spans, styles, `<o:p>`, `<script>`, `javascript:` links) must come out as clean allowed markup with the text intact. *(Task 1 tests.)*
3. **A server restart, or a clock tick that runs twice,** must not send a second Monday reminder or create two issues. *(Task 5 test `tick is idempotent`.)*
4. **A contributor with nothing in this week's issue** (all items passed or dropped) still gets a working page showing history and "Add something new," and gets no reminder. *(Task 4 test `contributor view with no pieces`, Task 5 test `no reminder without pieces`.)*
5. **An accepted suggestion whose original text no longer matches** (Mitchell edited the letter after review) is reported as "couldn't apply" and leaves the letter unchanged, instead of silently doing nothing or garbling the HTML. *(Task 6 test `applySuggestion misses cleanly`.)*

---

## File Structure

| File | Responsibility |
|---|---|
| `src/gracenotes/html.ts` | Allowlist sanitizer for rich text, plus HTML → plain text |
| `src/gracenotes/types.ts` | Row types and status constants |
| `src/gracenotes/repo.ts` | Contributors, sections, owners: CRUD |
| `src/gracenotes/issues.ts` | Create issue with carry-forward, glance HTML, per-contributor status |
| `src/gracenotes/pieces.ts` | Confirm / edit / drop / add, event sync, social review markers |
| `src/gracenotes/clock.ts` | Pure "what's due now", plus `tick()` |
| `src/gracenotes/mail.ts` | Resend send and reminder log |
| `src/gracenotes/letter.ts` | Claude letter review, plus applying suggestions |
| `src/gracenotes/sheet.ts` | Paste sheet blocks |
| `src/routes/gracenotes.ts` | Admin API |
| `src/routes/contributor.ts` | Public `/gn/<token>` page, assets and API |
| `src/public/gn/contributor.html`, `contributor.js`, `contributor.css` | Contributor page |
| `src/public/gracenotes.js` | Admin Grace Notes tab |
| Modify `src/schema.ts`, `src/index.ts`, `src/dates.ts`, `src/settings.ts`, `src/routes/settings.ts`, `src/public/index.html`, `src/public/pipeline.js`, `src/pipeline/repo.ts`, `docker-compose.yml` | Wiring |

---

### Task 1: Rich-text sanitizer

**Files:**
- Create: `src/gracenotes/html.ts`
- Test: `src/gracenotes-html.test.ts`

**Interfaces:**
- Produces: `sanitizeHtml(input: string): string` and `htmlToText(html: string): string`. Allowed tags: `p br strong em b i a ul ol li` (`b`→`strong`, `i`→`em`; `div` becomes `p`). The only attribute kept is `href` on `a`, and only for `http:`, `https:` or `mailto:` (everything else unwraps to text). Disallowed tags are removed but their text is kept. `<script>`/`<style>` are removed along with their contents, and so are comments. Bare `<`, `>` and `&` in text are escaped. `htmlToText` turns `</p>` into a blank line, `<br>` into a newline, `<li>` into `• ` lines, and `a` into `text (href)` when the two differ. Entities are decoded.

- [ ] **Step 1: Write failing tests** in `src/gracenotes-html.test.ts`:
  - `sanitize keeps allowed markup`: `<p>Hi <strong>all</strong> <a href="https://x.org">here</a></p>` comes back unchanged.
  - `sanitize strips word junk`: `<p class="MsoNormal" style="x"><span style="font:1">Hi</span><o:p></o:p></p>` → `<p>Hi</p>`.
  - `sanitize kills scripts and js links`: `<p onclick="x">a<script>alert(1)</script><a href="javascript:alert(1)">b</a></p>` → `<p>ab</p>`.
  - `sanitize maps b/i/div`: `<div><b>x</b><i>y</i></div>` → `<p><strong>x</strong><em>y</em></p>`.
  - `sanitize escapes stray brackets`: `a < b & c` → `a &lt; b &amp; c`.
  - `htmlToText`: `<p>One</p><p>Two<br>Three</p><ul><li>A</li></ul>` → `"One\n\nTwo\nThree\n\n• A"`.
- [ ] **Step 2:** `cd apps/social-posts && npm test`. Expected: compile FAIL (module missing).
- [ ] **Step 3: Implement** with a single regex tokenizer over `/<!--[\s\S]*?-->|<\/?([a-zA-Z0-9:]+)([^>]*)>|[^<]+|</g`. Keep a stack so closing tags only close what was opened, and close anything left open at the end.
- [ ] **Step 4:** `npm test`. Expected: the html tests pass.
- [ ] **Step 5:** `git commit -m "feat(grace-notes): rich text sanitizer"`

### Task 2: Schema, contributors and sections

**Files:**
- Modify: `src/schema.ts` (append)
- Create: `src/gracenotes/types.ts`, `src/gracenotes/repo.ts`
- Test: `src/gracenotes-repo.test.ts`

**Interfaces:**
- Produces this SQL (appended to `SCHEMA_SQL`):

```sql
CREATE TABLE IF NOT EXISTS gn_contributors (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name text NOT NULL, email text NOT NULL DEFAULT '',
  token text NOT NULL UNIQUE, retired_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS gn_sections (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  title text NOT NULL, kind text NOT NULL CHECK (kind IN ('text','events','glance')),
  position integer NOT NULL, retired boolean NOT NULL DEFAULT false);
CREATE TABLE IF NOT EXISTS gn_section_owners (
  section_id text NOT NULL REFERENCES gn_sections(id) ON DELETE CASCADE,
  contributor_id text NOT NULL REFERENCES gn_contributors(id) ON DELETE CASCADE,
  PRIMARY KEY (section_id, contributor_id));
CREATE TABLE IF NOT EXISTS gn_issues (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  issue_date date NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'collecting' CHECK (status IN ('collecting','sent')),
  created_at timestamptz NOT NULL DEFAULT now(), sent_at timestamptz);
CREATE TABLE IF NOT EXISTS gn_pieces (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  issue_id text NOT NULL REFERENCES gn_issues(id) ON DELETE CASCADE,
  section_id text NOT NULL REFERENCES gn_sections(id),
  contributor_id text REFERENCES gn_contributors(id) ON DELETE SET NULL, -- item owner; NULL on text pieces
  event_id text REFERENCES events(id) ON DELETE SET NULL,
  title text NOT NULL DEFAULT '', body_html text NOT NULL DEFAULT '',
  details jsonb NOT NULL DEFAULT '{}', -- {when, place, cost, link, linkLabel, contact}
  image_url text NOT NULL DEFAULT '',
  status text NOT NULL CHECK (status IN ('carried','confirmed','changed','dropped','new')),
  position integer NOT NULL DEFAULT 0,
  carried_from text, content_hash text NOT NULL DEFAULT '',
  updated_by text NOT NULL DEFAULT '', updated_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS gn_pieces_issue_idx ON gn_pieces (issue_id);
CREATE TABLE IF NOT EXISTS gn_reminders (
  id bigserial PRIMARY KEY, issue_id text NOT NULL REFERENCES gn_issues(id) ON DELETE CASCADE,
  contributor_id text NOT NULL REFERENCES gn_contributors(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('monday','deadline','manual')),
  status text NOT NULL CHECK (status IN ('sent','failed','skipped')), error text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS gn_reminders_auto_once ON gn_reminders (issue_id, contributor_id, kind) WHERE kind <> 'manual';
CREATE TABLE IF NOT EXISTS gn_letter_reviews (
  piece_id text PRIMARY KEY REFERENCES gn_pieces(id) ON DELETE CASCADE,
  suggestions jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE events ADD COLUMN IF NOT EXISTS image_url text NOT NULL DEFAULT '';
ALTER TABLE events ADD COLUMN IF NOT EXISTS review_note text NOT NULL DEFAULT '';
```

- `types.ts`: `PieceStatus`, `SectionKind`, `Contributor {id,name,email,token,retired:boolean}`, `Section {id,title,kind,position,retired,ownerIds:string[]}`, `Piece` (camelCase of the columns, plus `sectionTitle`, `sectionKind`, `eventName`, `eventStartDate`), and `Details`.
- `repo.ts` (`db: Pool | PoolClient` throughout, returning `Result<T>` from `pipeline/rules`):
  `createContributor(db,{name,email})`, `updateContributor(db,id,{name?,email?})`, `retireContributor(db,id)`, which sets `retired_at` and replaces the token so the old link dies, `listContributors(db)`, `contributorByToken(db,token): Promise<Contributor|null>` (non-retired only),
  `createSection(db,{title,kind})` (appends position), `updateSection(db,id,{title?,retired?})`, `reorderSections(db, ids: string[])`, `setSectionOwners(db, sectionId, contributorIds: string[])`, `listSections(db,{includeRetired?})`.

- [ ] **Step 1: Failing tests** (start with `DROP TABLE IF EXISTS gn_letter_reviews, gn_reminders, gn_pieces, gn_issues, gn_section_owners, gn_sections, gn_contributors`, then `SCHEMA_SQL`):
  - `contributor gets a long token`: the token is at least 32 chars and two contributors' tokens differ.
  - `retire kills the link`: after `retireContributor`, `contributorByToken(oldToken)` is `null`.
  - `sections keep order and owners`: create A, B, C, `reorderSections([C,A,B])`, set owners on A, and `listSections` returns C, A, B with A's `ownerIds`.
  - `contributor needs a name`: `createContributor({name:""})` returns `ok:false`.
  - `schema is rerunnable`: running `SCHEMA_SQL` twice doesn't throw.
- [ ] **Step 2:** `npm test`. Expected FAIL.
- [ ] **Step 3:** Implement the schema and repo.
- [ ] **Step 4:** `npm test`. Expected PASS (the existing suite stays green too).
- [ ] **Step 5:** `git commit -m "feat(grace-notes): contributors and sections"`

### Task 3: Issues, carry-forward and Grace at a Glance

**Files:**
- Create: `src/gracenotes/issues.ts`
- Modify: `src/dates.ts` (add `localTimeIn`, `weekdayOf`)
- Test: `src/gracenotes-issues.test.ts`

**Interfaces:**
- Consumes: Task 2 repo and types, and `sanitizeHtml` from Task 1.
- Produces:
  - `pieceHash(p: {title, bodyHtml, details, imageUrl, eventId}): string` (sha256 of canonical JSON).
  - `createIssue(db, issueDate: string): Promise<Result<Issue>>`. It errors `"There's already an issue for {date}."` if one exists. It copies from the newest issue with an earlier `issue_date`: every non-dropped piece of a non-retired, non-glance section, except event-backed pieces whose event's `COALESCE(end_date,start_date) < issueDate`, and unlinked items whose `details.endDate < issueDate`. Copies get `status='carried'` and `carried_from` = the source id, with the same hash. Every non-retired `text` section that's missing a piece gets an empty `carried` text piece. With no earlier issue, each text section gets an empty piece.
  - `glanceHtml(db, issueDate): Promise<string>` returns `<ul><li><strong>Sat Nov 7</strong> · CPR Training</li>…</ul>`, with the rules from Global Constraints. A multi-day event shows `Nov 18 – Nov 20`.
  - `getIssue(db, id)`, `currentIssue(db)` (newest `collecting` issue, else newest), `listIssues(db)`.
  - `pieceOwnerIds(piece, sections): string[]`, which returns `[piece.contributorId]` if set, else that section's `ownerIds`.
  - `contributorStatus(db, issueId): Promise<Array<{contributorId, name, state: 'outstanding'|'confirmed'|'changed'|'new'|'none', pieces: number, lastReminder: string|null}>>`. The state is `outstanding` if any owned piece is `carried`. Otherwise `new` if any is `new`, else `changed` if any is `changed`, else `confirmed`, and `none` when they have no pieces.
  - `nextIssueDate(today: string, sendDow: number): string`, the first date strictly after `today` whose weekday is `sendDow`.
  - `dates.ts`: `localTimeIn(tz, instant): string` (`"HH:MM"`, 24h) and `weekdayOf(iso): number` (0 = Sunday).

- [ ] **Step 1: Failing tests:**
  - `first issue gets empty text pieces`: 2 text sections and 1 events section → 2 empty `carried` pieces.
  - `carry copies and drops passed events`: the previous issue has a text piece, an item linked to an event ending `2026-11-07`, an item linked to an event on `2026-11-19`, and one dropped item. `createIssue('2026-11-11')` carries the text piece and the Nov 19 item only, all `carried`, with `carried_from` set.
  - `duplicate issue refused`.
  - `glance lists every dated event 4 weeks out`: events on Nov 10 (before), Nov 11, Dec 8, Dec 9, and an archived Nov 20, with issue Nov 11 → only Nov 11 and Dec 8, in order.
  - `status per contributor`: owner of a text section plus an item owner. The item gets confirmed → the item owner is `confirmed`, the section owner is `outstanding`, and a third contributor is `none`.
  - `nextIssueDate`: Sun `2026-11-08`, dow 3 → `2026-11-11`. Wed `2026-11-11` → `2026-11-18`.
- [ ] **Step 2:** `npm test`. Expected FAIL.
- [ ] **Step 3:** Implement. Run `createIssue` in one transaction.
- [ ] **Step 4:** `npm test`. Expected PASS.
- [ ] **Step 5:** `git commit -m "feat(grace-notes): weekly issue with carry-forward and glance"`

### Task 4: Piece actions and the social markers

**Files:**
- Create: `src/gracenotes/pieces.ts`
- Modify: `src/pipeline/repo.ts` (`EventRow` gains `imageUrl`, `reviewNote`; `listEvents`/`getEvent` select them; add `clearEventReview(db,id)`, `setEventImage(db,id,url)`)
- Test: `src/gracenotes-pieces.test.ts`

**Interfaces:**
- Consumes: Tasks 2–3 and `createEvent`/`updateEvent` from `pipeline/repo`.
- Produces (an `actor` is `{ kind: 'contributor', contributor: Contributor } | { kind: 'admin', email: string }`):
  - `confirmPiece(db, pieceId, actor)` sets `confirmed`.
  - `editPiece(db, pieceId, input: PieceInput, actor)`. `PieceInput = {title?, bodyHtml?, details?, imageUrl?, startDate?, endDate?}`. Body goes through `sanitizeHtml`. The status becomes `changed` if the new hash differs from the `carried_from` piece's hash (or there is no source), else `confirmed`; a `new` piece stays `new`. If the piece has an `event_id`, `title`/`startDate`/`endDate` are written to that event's `name`/`start_date`/`end_date` and `imageUrl` to `events.image_url`. If the actor is a contributor, the event's `review_note` becomes `Changed by {name}`.
  - `dropPiece(db, pieceId, actor)` works on event/item pieces only, and errors on text pieces with `"Text sections can't be dropped; clear the text instead."`.
  - `addItem(db, issueId, sectionId, input: PieceInput, actor)` only goes into an `events`-kind section. It creates a `new` piece owned by the contributor (null for admin). If `startDate` is given, it also creates an `events` row (`kind 'event'`, `name` = title, its dates, `owner_email` = contributor email), links it, and sets `review_note` to `New from {name}` when a contributor added it.
  - `linkEvent(db, pieceId, eventId)` (admin only).
  - `canTouch(piece, actor, sections): boolean`. Admin can touch anything. A contributor can touch a piece only if they're in `pieceOwnerIds`. Every action above checks it and errors `"That piece isn't yours."`.
  - `contributorView(db, contributor): Promise<{issue: {id,issueDate}|null, pieces: Piece[], sections: {id,title,kind}[] /* sections they own + all events sections they may add to */, history: Array<{issueDate, title, sectionTitle, bodyHtml, details, imageUrl}>}>`. History covers their pieces in earlier issues, excluding dropped ones, newest first, limited to 30. No other contributor's data appears.
  - `effectiveImage(piece): string` returns the event's `image_url` when linked, else the piece's.

- [ ] **Step 1: Failing tests:**
  - `edit unchanged stays confirmed`: editing with the same body → `confirmed`.
  - `edit changed marks event`: a contributor edits the title of an event-backed piece → piece `changed`, `events.name` updated, `review_note = 'Changed by Women of Grace'`.
  - `admin edit leaves no marker`: the same edit by admin → `review_note` unchanged.
  - `add item with date creates event`: → `events` row exists, piece `new`, `review_note = 'New from Eddie Rogers'`.
  - `not yours`: contributor B can't confirm contributor A's item.
  - `cannot drop text`.
  - `contributor view with no pieces`: a contributor whose only item has passed gets `pieces: []`, a non-empty `history`, and `issue` set.
  - `view is private`: the view's JSON has no other contributor's name or email.
- [ ] **Step 2:** `npm test`. Expected FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npm test`. Expected PASS.
- [ ] **Step 5:** `git commit -m "feat(grace-notes): contributor piece actions shared with events"`

### Task 5: Weekly clock and reminder email

**Files:**
- Create: `src/gracenotes/clock.ts`, `src/gracenotes/mail.ts`
- Modify: `src/settings.ts` (`SettingsView` gains `hasResend`, `mailFrom`, `publicBaseUrl`, and `gn` schedule fields), `src/routes/settings.ts` (save `resendKey`→`resend_api_key`, `mailFrom`→`mail_from`, `publicBaseUrl`→`public_base_url`, `gnSendDow`, `gnCreateAt`, `gnRemindAt`, `gnDeadlineAt`), `src/index.ts` (run `tick` at start and every 15 min, catching its own errors like `publishCheck`)
- Test: `src/gracenotes-clock.test.ts`

**Interfaces:**
- Produces:
  - `type Schedule = { sendDow: number; createDow: number; createAt: string; remindDow: number; remindAt: string; deadlineDow: number; deadlineAt: string }`, with defaults `{3, 0,"18:00", 1,"08:00", 2,"12:00"}` read from settings `gn_send_dow`, `gn_create_at`, `gn_remind_at` and `gn_deadline_at` (the create, remind and deadline days are fixed relative to the send day: −3, −2, −1).
  - `dueActions(now: {date: string; time: string}, s: Schedule, hasEarlierIssue: boolean): Array<{kind:'create'|'monday'|'deadline'; issueDate: string}>` is pure. On the create day, at or after `createAt`, with an earlier issue, it returns `create` for `nextIssueDate(date)`. On the remind day at or after `remindAt`, it returns `monday` for the coming send date, and the same for `deadline` on the deadline day. If the clock is behind (missed ticks), Tuesday at 13:00 still yields both `monday` and `deadline`.
  - `sendMail(fetchFn, cfg:{key,from}, msg:{to,subject,text,idempotencyKey}): Promise<{ok:true}|{ok:false,error}>`. This is the same contract as `apps/expenses/src/mailer.ts:sendViaResend`, copied, not imported across apps.
  - `remind(db, issueId, contributorId, kind, fetchFn = fetch): Promise<{status:'sent'|'failed'|'skipped', error?: string}>`. It skips when mail or `public_base_url` isn't set, or the contributor has no email. Each attempt goes into a `gn_reminders` row. For automatic kinds it uses `INSERT … ON CONFLICT DO NOTHING` *before* sending, so only the first run sends. Idempotency key: `gn-{issueId}-{contributorId}-{kind}`. The link is `{public_base_url}/gn/{token}`.
  - `tick(db, now = new Date(), fetchFn = fetch): Promise<{created?: string; reminded: number}>`. It creates the issue if due and not already there. On `monday` it reminds every contributor whose `contributorStatus` isn't `none`. On `deadline` it reminds only the `outstanding` ones.

- [ ] **Step 1: Failing tests:**
  - `dueActions Sunday evening` → `[{create,'2026-11-11'}]` at `2026-11-08 18:05`, and `[]` at `17:55` or without an earlier issue.
  - `dueActions catch-up Tuesday` → `monday` and `deadline` at `2026-11-10 13:00`.
  - `tick is idempotent`: run `tick` twice at Mon 08:10 with a stub fetch counting calls → one send per contributor and one `gn_reminders` row each.
  - `no reminder without pieces`: a contributor with status `none` gets nothing.
  - `deadline only outstanding`: a confirmed contributor isn't nudged Tuesday.
  - `mail off is skipped not failed`: no `resend_api_key` → `remind` returns `skipped` and fetch isn't called.
  - `reminder body has link and copy`: the stub fetch's JSON body contains `"Grace Notes goes out Wednesday. Check your piece by Tuesday noon:"` and `/gn/`.
- [ ] **Step 2:** `npm test`. Expected FAIL.
- [ ] **Step 3:** Implement, with the local date/time from `localDateIn`/`localTimeIn` using `default_timezone`.
- [ ] **Step 4:** `npm test`. Expected PASS.
- [ ] **Step 5:** `git commit -m "feat(grace-notes): weekly clock and email reminders"`

### Task 6: Pastor's letter review

**Files:**
- Create: `src/gracenotes/letter.ts`
- Test: `src/gracenotes-letter.test.ts`

**Interfaces:**
- Consumes: `callClaude(pool, system, user, {schema})` from `src/claude.ts`, Task 3's `getIssue`/`glanceHtml`, and `htmlToText`.
- Produces:
  - `type Suggestion = { id: string; kind: 'grammar'|'fact'; original: string; replacement: string; reason: string; source: string; state: 'open'|'accepted'|'rejected'|'missed' }`. `source` is empty for grammar. For a fact it names what it was checked against, e.g. `"Grace at a Glance: Stewardship Sunday, Nov 8"`.
  - `buildReviewPrompt(letterText, facts: {glance: string; sermon: string; events: string[]; previousLetter: string}): {system: string; user: string}`. The system prompt pins these rules: fix only grammar, spelling, punctuation and clear factual mismatches with the facts given; keep the pastor's voice and wording; `original` must be quoted exactly from the letter and as short as possible; never more than 25 suggestions.
  - `reviewLetter(pool, pieceId, call = callClaude): Promise<Suggestion[]>` stores the result in `gn_letter_reviews` (replacing any earlier one). Facts: this issue's glance, the text of the section titled like `/sermon/i`, the issue's event-item titles with dates, and the previous issue's letter. It applies to the piece of the section whose title matches `/pastor|message|letter/i`, and Mitchell can run it on any text piece.
  - `applySuggestion(html: string, s: Suggestion): {html: string; applied: boolean}` replaces the first occurrence of the HTML-escaped `original` that lies inside a text node (not inside a tag) with the escaped `replacement`.
  - `decideSuggestion(db, pieceId, suggestionId, decision: 'accepted'|'rejected', actorEmail)` updates the piece body through `editPiece` as admin on accept, or marks the suggestion `missed` and returns `{ok:false, error:"That sentence has changed since the review. Edit it by hand."}`.

- [ ] **Step 1: Failing tests** (stub `call` returns fixed JSON):
  - `prompt carries facts`: `buildReviewPrompt` user text contains the glance line `Stewardship Sunday` and the previous letter.
  - `applySuggestion replaces in text only`: html `<p>Commitment Sunday is <a href="/commitment">here</a></p>`, original `Commitment Sunday`, replacement `Stewardship Sunday` → only the text changes and the href is untouched.
  - `applySuggestion misses cleanly`: original not present → `applied:false` with the html identical.
  - `accept updates piece and state`: after `decideSuggestion(...,'accepted')` the piece body has the replacement and the stored state is `accepted`.
- [ ] **Step 2:** `npm test`. Expected FAIL.
- [ ] **Step 3:** Implement with the schema `{suggestions: [{kind, original, replacement, reason, source}]}` (`kind` enum), and assign ids after parsing.
- [ ] **Step 4:** `npm test`. Expected PASS.
- [ ] **Step 5:** `git commit -m "feat(grace-notes): Claude review of the pastor's letter"`

### Task 7: Paste sheet

**Files:**
- Create: `src/gracenotes/sheet.ts`
- Test: `src/gracenotes-sheet.test.ts`

**Interfaces:**
- Produces: `buildSheet(db, issueId): Promise<Array<{ sectionId; title; kind; unchanged: boolean; html: string; text: string; images: Array<{url, alt}> }>>`, covering non-retired sections in position order.
  - text section: `html` = the piece body.
  - events section: for each non-dropped piece in `position` order, `<p><strong>{title}</strong></p>` + `<p>{details.when} · {details.place} · {details.cost}</p>` (empty parts left out) + body + `<p><a href="{link}">{linkLabel or "Register here"}</a></p>` + `<p>Contact: {contact}</p>`.
  - glance: `glanceHtml`.
  - `text` = `htmlToText(html)`. `images` = `effectiveImage` of each item that has one.
  - `unchanged` is true when every piece is `carried` or `confirmed`, the hash equals its `carried_from` hash, and there are no added or dropped pieces compared with the previous issue. For glance, it compares with the previous issue's glance.

- [ ] **Step 1: Failing tests:**
  - `sheet follows section order`.
  - `untouched section is unchanged`; `confirmed-but-same is unchanged`; `dropped item makes section changed`.
  - `event block format`: details `{when:"Sat Nov 7, 10:30am", place:"Mickler Hall", cost:"$25", link:"https://x", contact:"Eddie Rogers"}` → html contains `Sat Nov 7, 10:30am · Mickler Hall · $25` and `>Register here</a>`.
- [ ] **Step 2:** `npm test`. Expected FAIL.
- [ ] **Step 3:** Implement. All interpolated values are HTML-escaped; the body is already sanitized.
- [ ] **Step 4:** `npm test`. Expected PASS.
- [ ] **Step 5:** `git commit -m "feat(grace-notes): paste sheet in email order"`

### Task 8: Routes and the public router

**Files:**
- Create: `src/routes/gracenotes.ts`, `src/routes/contributor.ts`
- Modify: `src/index.ts` (register both), `docker-compose.yml` (router below), `src/routes/pipeline.ts` (events PATCH accepts `imageUrl`; add `POST /api/pipeline/events/:id/reviewed` → `clearEventReview`)
- Test: `src/gracenotes-routes.test.ts` (Fastify `inject` with the routes registered on a test app against `TEST_DATABASE_URL`)

**Interfaces:**
- Admin (`/api/gracenotes`, identity from `getIdentity`, `{ok, …}` / `{ok:false,error}` like `guard` in `routes/pipeline.ts`):
  `GET|POST /contributors`, `PATCH /contributors/:id`, `POST /contributors/:id/retire`. The contributor list includes `link` = `{public_base_url or https://{req.hostname}}/gn/{token}`.
  `GET|POST /sections`, `PATCH /sections/:id`, `POST /sections/order {ids}`, `PUT /sections/:id/owners {contributorIds}`.
  `GET /issues`, `POST /issues {issueDate}`, `GET /issues/:id` (issue, pieces, `contributorStatus`, the latest review), `POST /issues/:id/sent`.
  `POST /pieces/:id/confirm|edit|drop|link`, `POST /issues/:id/sections/:sid/items`.
  `POST /issues/:id/remind/:contributorId` (manual).
  `POST /pieces/:id/review`, `POST /pieces/:id/review/:sid {decision}`.
  `GET /issues/:id/sheet`.
- Public (`src/routes/contributor.ts`):
  `GET /gn/:token` serves `public/gn/contributor.html`, or a plain "This link isn't active. Ask Mitchell for a new one." page with status 404.
  `GET /gn/_/:file` for an allowlist of `contributor.js`, `contributor.css` and `grmc.css` (from `public/assets/grmc.css`).
  `GET /gn/:token/api/view` → `contributorView`.
  `POST /gn/:token/api/pieces/:id/confirm|edit|drop`, `POST /gn/:token/api/sections/:sid/items`.
  `POST /gn/:token/api/image` (raw `image/*` body, ≤10 MB, images only) → `storeUpload` → `{url}`.
- `docker-compose.yml`, next to `social-ical`, with a comment in the same style:
  `traefik.http.routers.social-gn.rule=Host(\`social.${BASE_DOMAIN}\`) && PathPrefix(\`/gn/\`)`, plus `entrypoints=websecure`, `tls=true` and `service=social`.

- [ ] **Step 1: Failing tests:**
  - `gn route rejects retired token`: `GET /gn/<old>` → 404, and `POST /gn/<old>/api/pieces/x/confirm` → 404 with the piece unchanged.
  - `gn view returns own pieces`.
  - `gn cannot touch others`: a confirm on someone else's piece → `ok:false`, `"That piece isn't yours."`.
  - `gn image rejects video`: `video/mp4` → `ok:false`.
  - `admin sheet route`: returns blocks in order.
- [ ] **Step 2:** `npm test`. Expected FAIL.
- [ ] **Step 3:** Implement. Register `contributorRoutes` before `fastifyStatic` can claim `/gn/*`.
- [ ] **Step 4:** `npm test`. Expected PASS. Then run `docker compose config -q` from the repo root. Expected: no output.
- [ ] **Step 5:** `git commit -m "feat(grace-notes): admin API and contributor links"`

### Task 9: Contributor page (layout A)

**Files:**
- Create: `src/public/gn/contributor.html`, `contributor.js`, `contributor.css`

**Interfaces:**
- Consumes: Task 8 public API. The token is read from `location.pathname`.

This page has no automated tests (the repo has no front-end test harness). It's verified by hand in Step 2.

- [ ] **Step 1: Build the page** to match the spec's "Contributor page (layout A)":
  - a header `Next issue · {Wed Nov 11} · please check by Tue noon`;
  - a card per piece showing it as it'll read in the email, with **Looks right** / **Change something** (plus **Drop it** on items);
  - the editor: `contenteditable` with Bold, Italic, Link and List buttons (`document.execCommand`), title, date (items), details fields (when, place, cost, link, link label, contact) and an image upload;
  - a dashed **+ Add something new for this issue** card (choose which section if they can add to more than one);
  - **Earlier issues**: the 5 most recent, then "Show more", each expanding to the rendered piece.

  Make it mobile-first, single column, max-width 560px, with tap targets ≥44px. Use `grmc.css` from `/gn/_/grmc.css`. Saves show a toast "Saved. Thank you!", and errors show the server's message.
- [ ] **Step 2: Verify by hand:** `npm run build && SOCIALPOSTS_DB_*=… node dist/index.js` against a local DB seeded through the admin API. Open `/gn/<token>` at 390px width, then confirm, edit (paste from a Google Doc), add an item with an image, and check that history expands. Expected: each action persists after a reload, and pasted formatting comes back as plain bold/links.
- [ ] **Step 3:** `git commit -m "feat(grace-notes): contributor page"`

### Task 10: Admin Grace Notes tab

**Files:**
- Create: `src/public/gracenotes.js`
- Modify: `src/public/index.html` (add tab `<a class="tab" href="#gracenotes" data-view="gracenotes">Grace Notes</a>` after Recurring, plus `<script src="/gracenotes.js">` before `pipeline.js`), `src/public/pipeline.js` (`views.gracenotes = window.GraceNotes.render`; hide the toolbar on it; Settings gets a "Grace Notes email" card for the Resend key, from address, public link base and the four schedule fields), `src/public/pipeline.css`

**Interfaces:**
- Consumes: Task 8 admin API. `window.GraceNotes = { render(main, arg): Promise<void> }` using its own small `api`/`esc`/`toast`, following the copies in `pipeline.js`. Sub-routes: `#gracenotes` (current issue), `#gracenotes/people`, `#gracenotes/sections`, `#gracenotes/issue/{id}`.

This tab has no automated tests (same reason as Task 9).

- [ ] **Step 1: Build the views:**
  - **Issue page:** a status strip per contributor (state chip plus "reminded Mon 8:00" plus **Nudge**; when mail isn't set up, **Copy link** instead with the hint "Email reminders are off. Set them up in Settings."). Pieces grouped by section, each editable in place by Mitchell. **Review letter** on the letter piece shows suggestions inline with Accept/Reject (grammar and fact visually distinct, fact showing its `source`). **Paste sheet**: blocks in order, "Same as last week · skip" badge, **Copy** using `navigator.clipboard.write([new ClipboardItem({'text/html': …, 'text/plain': …})])` with a `writeText` fallback, image thumbnails with **Download**. **Mark sent**.
  - **No issue yet:** "Start an issue" with a date input defaulting to `nextIssueDate`, and a short note that the first one is filled in by hand and later ones copy forward.
  - **People:** list, add, edit, retire (confirm dialog: "Their old link will stop working."), **Copy link**, section ownership checkboxes.
  - **Sections:** list with up/down reorder, add (title + kind), rename, retire, owners.
- [ ] **Step 2: Verify by hand** (local, same as Task 9): set up 3 sections and 2 people, start an issue, review a letter with a stub-free Anthropic key, accept one suggestion, then use Copy on a block and paste it into a Mailchimp text block (or Google Docs) to check that bold and links survive. Expected: all of the above, and Mark sent moves the issue into history.
- [ ] **Step 3:** `git commit -m "feat(grace-notes): admin tab, issue page and paste sheet"`

### Task 11: Social-side markers and event image

**Files:**
- Modify: `src/public/pipeline.js` (`renderEvents`, `renderEvent`, `renderBoard`, `renderDashboard`), `src/public/pipeline.css`

**Interfaces:**
- Consumes: `EventRow.reviewNote`, `EventRow.imageUrl` (Task 4), `PATCH` `imageUrl` and `POST /api/pipeline/events/:id/reviewed` (Task 8).

- [ ] **Step 1: Build:**
  - Events list and event page: a gold badge with the `reviewNote` text, plus a `needs graphic` badge when the event has no `imageUrl` and its start date is in the future. The event page gets **Mark reviewed** (clears the note) and an **Event image** upload/replace control that uses the existing `/api/pipeline/uploads` and then PATCHes `imageUrl`.
  - Dashboard: a "From Grace Notes" card listing events with a `reviewNote`, linking to each event.
  - Board: the badge on event group headers.
- [ ] **Step 2: Verify by hand:** a contributor adds "Hanging of the Greens, Nov 18" through their link → the Dashboard card and Events badge read `New from …` and `needs graphic`. Upload an image → `needs graphic` goes away and the same image shows on the paste sheet. Mark reviewed → the badge goes away.
- [ ] **Step 3:** Run the full suite with `npm test`. Expected: every test passes.
- [ ] **Step 4:** `git commit -m "feat(grace-notes): show contributor changes on the social side"`
