# Pipeline as the Main App: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Content Pipeline the whole Social Posts app. The Wednesday, Friday, Podcast and Series drafting become editable drafting profiles on events, applied by Draft with Claude, and the old page is removed.

**Architecture:**
- **Profiles:** a drafting profile (source, instructions, angles) lives as jsonb on `events`. Overrides live on `recurrences` and `content_items`.
- **Drafting pieces:** one pure resolver (`effectiveProfile`) and one pure prompt builder (`buildDraftPrompt`) feed `draftCaptions`, which fetches the source item (a Mailchimp campaign or Buzzsprout episode) by the post's date and logs every draft against the post.
- **Planning:** an episode becomes several angle posts, and a series is planned with Claude; both create ordinary content items.
- **Rollout:** a one-time boot migration seeds the run profiles with today's prompts word for word. The old page, the run code and the series code are then deleted.

**Tech stack:**
- TypeScript (CommonJS), Fastify 5, `pg`, Postgres 16.
- `node --test` on compiled `dist/*.test.js`.
- Vanilla JS client (no build step).
- No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-20-pipeline-as-main-app-design.md`

## Global Constraints

- **Starting point:** a clean working tree on a branch off `main`, with the previous round's work (per-platform captions, the Instagram image rule, Approvals media) committed. Task 12's upgrade check builds the commit just before Task 1.

- Every API route answers `{ ok: true, ... }` or `{ ok: false, error }` with HTTP 200, as the rest of the app does.
- Dates are plain `YYYY-MM-DD` strings and are never passed through a timezone. `pg` returns `date` columns as strings because `src/pipeline/repo.ts` sets the type parser.
- The seeded instructions are copied **word for word** from today's `runs.ts`, `series.ts` and `podcast-angles.ts`. Tests assert the exact strings.
- Test files live at `apps/social-posts/src/*.test.ts` (the runner only globs `dist/*.test.js`). Database tests read `TEST_DATABASE_URL`.
- Run the suite from `apps/social-posts`: `npx tsc -p . && TEST_DATABASE_URL=postgres://postgres:test@localhost:55432/socialposts npm test`. Start the throwaway database first: `docker run -d --name grmc-pipeline-test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=socialposts -p 55432:5432 postgres:16`.
- Client code matches `src/public/pipeline.js`: ES5 `var`/`function` style, string-built HTML through `esc()`, and one delegated handler per event type keyed on `data-act`.
- UI copy is sentence case, plain verbs, and errors say what to do next. Media status "captured" is shown as "Collected".
- No new npm dependencies. Playwright is used only for verification, from an existing local install via `NODE_PATH`. It is not added to the repo.

## Review Focus

1. **Mailchimp or Buzzsprout not configured or unreachable** when the editor opens or Draft is pressed. Expected: the source panel shows the error with a link to Settings, and drafting from pasted content still works. Pinned in Task 4.
2. **A post with no publish date** on a `postDate` or `followingSunday` Mailchimp profile. Expected: the newest matching issue is used, with no crash. Pinned in Task 3.
3. **The event's profile changes after a post was drafted.** Expected: the post keeps the issue it was drafted from (its stored `source_ref`) until someone changes it. Pinned in Task 4.
4. **Planning from an episode with no publish date** (unreleased or private). Expected: posts are dated from today plus each offset, not dropped and not crashing. Pinned in Task 5.
5. **Claude returns malformed JSON or misses a platform's key.** Expected: a clear error, and nothing saved. "Draft all" reports that post's failure and carries on with the rest. Pinned in Tasks 4 and 5.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/pipeline/drafting.ts` (new) | Profile, override and source-ref types; validation; `effectiveProfile()`. Pure. |
| `src/pipeline/drafting-seed.ts` (new) | Today's run prompts, angles, series instructions and house voice, word for word. Data only. |
| `src/pipeline/prompt.ts` (new) | `buildDraftPrompt()`: one prompt from voice, context, instructions, post fields and source content. Pure. |
| `src/pipeline/sources.ts` (new) | `cutoffDate()` and `pickCampaign()` (pure); `resolveSource()`, which fetches a Mailchimp campaign or Buzzsprout episode for a post. |
| `src/pipeline/history.ts` (new) | Logs each draft against its post and lists a post's earlier drafts. |
| `src/pipeline/caption.ts` (rewrite) | `draftCaptions()` and `draftAndSave()`: resolve profile and source, build the prompt, call Claude, retry a long X post, log. |
| `src/pipeline/planning.ts` (new) | `planFromEpisode()`, `proposeSeriesPlan()`, `saveSeriesPlan()`. |
| `src/pipeline/migrate-drafting.ts` (new) | One-time boot migration: run profiles, the Sunday worship split, series context. |
| `src/mailchimp.ts` (modify) | Adds `listCampaigns()` and `getCampaignText()`; the run-only helpers are removed in Task 7. |
| `src/pipeline/rules.ts`, `repo.ts`, `recurring.ts`, `recurrence.ts`, `config.ts`, `sync.ts` (modify) | Carry `drafting`, `source_ref` and `phase`; the Sunday worship run event; series sync and run hooks removed. |
| `src/routes/pipeline.ts` (modify) | Source, drafting, history and planning routes. |
| `src/settings.ts`, `src/routes/settings.ts` (modify) | The house voice setting. |
| `src/index.ts` (modify) | Migration on boot; `/pipeline` redirects to `/`; old routes unregistered. |
| `src/public/index.html` (was `pipeline.html`), `pipeline.js`, `pipeline.css` (modify) | Settings tab; event drafting card; editor source panel, override and history; planning dialogs. |
| Deleted | `runs.ts`, `runs.test.ts`, `series.ts`, `series.test.ts`, `voice.ts`, `podcast-angles.ts`, `podcast-angles.test.ts`, `schedule.test.ts`, `drafts.ts`, `routes/drafts.ts`, `routes/series.ts`, `routes/mailchimp.ts`, `public/index.html` (old), `public/app.js`, `public/app.css` |

---

### Task 1: Drafting profiles: types, validation, resolution, persistence

**Files:**
- Create: `apps/social-posts/src/pipeline/drafting.ts`
- Modify: `apps/social-posts/src/schema.ts`, `src/pipeline/rules.ts`, `src/pipeline/repo.ts`, `src/pipeline/recurrence.ts`, `src/pipeline/recurring.ts`
- Test: `apps/social-posts/src/pipeline-drafting.test.ts` (new, pure), `apps/social-posts/src/pipeline.test.ts` (append)

**Interfaces:**
- Produces:
  - `SourceKind = "none" | "mailchimp" | "buzzsprout"`
  - `Cutoff = "latest" | "postDate" | "followingSunday"`
  - `SourceConfig { kind; subjectContains?: string; cutoff?: Cutoff }`
  - `Angle { key; label; instructions; offsetDays }`
  - `Profile { source?; instructions?; angles? }`
  - `Override { source?; instructions? }`
  - `SourceRef { kind: "mailchimp" | "buzzsprout" | "manual"; id?; title?; url?; date?; content? }`
  - `Effective { source: SourceConfig; instructions: string; context: string; angles: Angle[]; from: "post" | "recurrence" | "event" | "default" }`
  - `parseProfile(raw): Result<Profile>`, `parseOverride(raw): Result<Override>`, `parseSourceRef(raw): Result<SourceRef | null>`
  - `effectiveProfile(event: { notes: string; drafting: Profile } | null, recurrence: { drafting: Override } | null, item: { drafting: Override }): Effective`
  - `GENERIC_INSTRUCTIONS: string`
  - New row fields: `EventRow.drafting: Profile`; `ContentRow.drafting: Override`, `ContentRow.sourceRef: SourceRef | null`, `ContentRow.phase: string`; `RecurrenceRow.drafting: Override`
  - New input fields: `EventInput.drafting`; `ContentInput.drafting / sourceRef / phase`; `RecurrenceInput.drafting`

- [ ] **Step 1: Write the failing pure tests**

Create `apps/social-posts/src/pipeline-drafting.test.ts`:

```ts
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { GENERIC_INSTRUCTIONS, effectiveProfile, parseOverride, parseProfile, parseSourceRef } from "./pipeline/drafting";

test("profiles validate their source, instructions and angles", () => {
  assert.ok(parseProfile({}).ok, "an empty profile is fine");
  const gn = parseProfile({ source: { kind: "mailchimp", subjectContains: "Grace Notes", cutoff: "followingSunday" }, instructions: "Warm summary." });
  assert.ok(gn.ok);
  assert.deepEqual(gn.value.source, { kind: "mailchimp", subjectContains: "grace notes", cutoff: "followingSunday" }, "subject match is stored lower-case");
  assert.ok(!parseProfile({ source: { kind: "mailchimp" } }).ok, "Mailchimp needs a subject to match");
  assert.ok(!parseProfile({ source: { kind: "rss" } }).ok);
  assert.ok(!parseProfile({ source: { kind: "mailchimp", subjectContains: "x", cutoff: "yesterday" } }).ok);
  assert.deepEqual(parseProfile({ source: { kind: "mailchimp", subjectContains: "blog" } }).ok && (parseProfile({ source: { kind: "mailchimp", subjectContains: "blog" } }) as any).value.source.cutoff, "latest", "cutoff defaults to latest");
  assert.ok(!parseProfile({ angles: [{ key: "a", label: "A", instructions: "x", offsetDays: 0 }, { key: "a", label: "B", instructions: "y", offsetDays: 1 }] }).ok, "angle keys are unique");
  assert.ok(!parseProfile({ angles: [{ key: "Bad Key", label: "A", instructions: "x", offsetDays: 0 }] }).ok);
  assert.ok(!parseProfile({ angles: [{ key: "a", label: "A", instructions: "", offsetDays: 0 }] }).ok, "an angle needs instructions");
});

test("overrides carry instructions and source but never angles", () => {
  const o = parseOverride({ instructions: "  Invite them.  ", angles: [] });
  assert.ok(o.ok);
  assert.deepEqual(o.value, { instructions: "Invite them." });
  assert.deepEqual((parseOverride({ instructions: "" }) as any).value, {}, "blank instructions mean inherit");
});

test("source refs", () => {
  assert.deepEqual(parseSourceRef(null), { ok: true, value: null });
  assert.ok(parseSourceRef({ kind: "manual", content: "Pasted text", url: "https://x.org" }).ok);
  assert.ok(!parseSourceRef({ kind: "manual" }).ok, "pasted content can't be empty");
  assert.ok(parseSourceRef({ kind: "mailchimp", id: "abc123", title: "Grace Notes" }).ok);
  assert.ok(!parseSourceRef({ kind: "mailchimp" }).ok, "a picked campaign needs its id");
});

test("the post's override wins, then the recurrence's, then the event's", () => {
  const event = { notes: "Founded 2022.", drafting: { source: { kind: "mailchimp" as const, subjectContains: "grace notes", cutoff: "followingSunday" as const }, instructions: "Event says.", angles: [] } };
  const rec = { drafting: { instructions: "Recurrence says." } };
  assert.equal(effectiveProfile(event, rec, { drafting: { instructions: "Post says." } }).instructions, "Post says.");
  const viaRec = effectiveProfile(event, rec, { drafting: {} });
  assert.equal(viaRec.instructions, "Recurrence says.");
  assert.equal(viaRec.from, "recurrence");
  assert.equal(viaRec.source.kind, "mailchimp", "source still inherited from the event");
  assert.equal(viaRec.context, "Founded 2022.");
  const own = effectiveProfile(event, null, { drafting: { source: { kind: "none" } } });
  assert.equal(own.source.kind, "none", "a post can switch its source off");
  const bare = effectiveProfile(null, null, { drafting: {} });
  assert.equal(bare.instructions, GENERIC_INSTRUCTIONS);
  assert.equal(bare.source.kind, "none");
  assert.equal(bare.from, "default");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/social-posts && npx tsc -p .`
Expected: FAIL. `Cannot find module './pipeline/drafting'`.

- [ ] **Step 3: Implement `drafting.ts`**

Create `apps/social-posts/src/pipeline/drafting.ts`:

```ts
// Drafting profiles: what Draft with Claude works from for a post — where its
// source material comes from and what each post should do. An event holds the
// profile; a recurring post or a single post may override its instructions
// and/or source. Pure.
import { Result } from "./rules";

export const SOURCE_KINDS = ["none", "mailchimp", "buzzsprout"] as const;
export type SourceKind = typeof SOURCE_KINDS[number];
export const CUTOFFS = ["latest", "postDate", "followingSunday"] as const;
export type Cutoff = typeof CUTOFFS[number];

export interface SourceConfig { kind: SourceKind; subjectContains?: string; cutoff?: Cutoff }
export interface Angle { key: string; label: string; instructions: string; offsetDays: number }
export interface Profile { source?: SourceConfig; instructions?: string; angles?: Angle[] }
export interface Override { source?: SourceConfig; instructions?: string }
export interface SourceRef {
  kind: "mailchimp" | "buzzsprout" | "manual";
  id?: string; title?: string; url?: string; date?: string; content?: string;
}
export interface Effective {
  source: SourceConfig; instructions: string; context: string; angles: Angle[];
  from: "post" | "recurrence" | "event" | "default";
}

export const GENERIC_INSTRUCTIONS = "Write one post that serves the brief. Make someone want to act on it.";

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });
const obj = (raw: unknown): Record<string, any> => (raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, any> : {});

export function parseSource(raw: unknown): Result<SourceConfig> {
  const r = obj(raw);
  if (!(SOURCE_KINDS as readonly string[]).includes(r.kind)) return fail("Source must be none, Mailchimp or Buzzsprout.");
  if (r.kind !== "mailchimp") return { ok: true, value: { kind: r.kind } };
  const subjectContains = String(r.subjectContains ?? "").trim().toLowerCase();
  if (!subjectContains) return fail("Say which Mailchimp campaigns to use: text their subject contains.");
  if (subjectContains.length > 100) return fail("The subject match is too long.");
  const cutoff = r.cutoff ?? "latest";
  if (!(CUTOFFS as readonly string[]).includes(cutoff)) return fail("Pick which issue to use.");
  return { ok: true, value: { kind: "mailchimp", subjectContains, cutoff } };
}

function parseInstructions(v: unknown): Result<string | undefined> {
  if (v == null) return { ok: true, value: undefined };
  if (typeof v !== "string") return fail("Instructions must be text.");
  if (v.length > 4000) return fail("Instructions are too long.");
  return { ok: true, value: v.trim() || undefined };
}

function parseAngles(v: unknown): Result<Angle[]> {
  if (!Array.isArray(v)) return fail("Angles must be a list.");
  const out: Angle[] = [];
  for (const a of v) {
    const key = String(a?.key ?? "");
    if (!/^[a-z][a-z0-9-]{0,30}$/.test(key)) return fail(`"${key}" can't be an angle key: use lower-case letters, digits and dashes.`);
    if (out.some((x) => x.key === key)) return fail(`Two angles share the key "${key}".`);
    const label = String(a?.label ?? "").trim(), instructions = String(a?.instructions ?? "").trim();
    if (!label || !instructions) return fail("Each angle needs a label and instructions.");
    const offsetDays = Number(a?.offsetDays ?? 0);
    if (!Number.isInteger(offsetDays) || offsetDays < -30 || offsetDays > 60) return fail("Angle days must be between -30 and 60.");
    out.push({ key, label, instructions, offsetDays });
  }
  return { ok: true, value: out };
}

export function parseOverride(raw: unknown): Result<Override> {
  const r = obj(raw), out: Override = {};
  if (r.source != null) {
    const s = parseSource(r.source);
    if (!s.ok) return s;
    out.source = s.value;
  }
  const i = parseInstructions(r.instructions);
  if (!i.ok) return i;
  if (i.value) out.instructions = i.value;
  return { ok: true, value: out };
}

export function parseProfile(raw: unknown): Result<Profile> {
  const base = parseOverride(raw);
  if (!base.ok) return base;
  const out: Profile = { ...base.value };
  const r = obj(raw);
  if (r.angles != null) {
    const a = parseAngles(r.angles);
    if (!a.ok) return a;
    out.angles = a.value;
  }
  return { ok: true, value: out };
}

export function parseSourceRef(raw: unknown): Result<SourceRef | null> {
  if (raw == null) return { ok: true, value: null };
  const r = obj(raw);
  if (!["mailchimp", "buzzsprout", "manual"].includes(r.kind)) return fail("That source item isn't valid.");
  const s = (k: string, max: number) => (r[k] == null ? undefined : String(r[k]).slice(0, max));
  const ref: SourceRef = { kind: r.kind, id: s("id", 100), title: s("title", 300), url: s("url", 2000), date: s("date", 10), content: s("content", 20000) };
  if (ref.kind === "manual" && !ref.content?.trim()) return fail("Paste the content to draft from.");
  if (ref.kind !== "manual" && !ref.id) return fail("That source item has no id.");
  for (const k of Object.keys(ref) as (keyof SourceRef)[]) if (ref[k] === undefined) delete ref[k];
  return { ok: true, value: ref };
}

export function effectiveProfile(
  event: { notes: string; drafting: Profile } | null,
  recurrence: { drafting: Override } | null,
  item: { drafting: Override },
): Effective {
  const layers: Array<[Effective["from"], Override | Profile | undefined]> = [
    ["post", item.drafting], ["recurrence", recurrence?.drafting], ["event", event?.drafting],
  ];
  const withInstructions = layers.find(([, d]) => d?.instructions);
  const withSource = layers.find(([, d]) => d?.source);
  return {
    instructions: withInstructions ? withInstructions[1]!.instructions! : GENERIC_INSTRUCTIONS,
    from: withInstructions ? withInstructions[0] : "default",
    source: withSource ? withSource[1]!.source! : { kind: "none" },
    context: event?.notes || "",
    angles: event?.drafting?.angles || [],
  };
}
```

- [ ] **Step 4: Run the pure tests to verify they pass**

Run: `npx tsc -p . && node --test dist/pipeline-drafting.test.js`
Expected: PASS, 4 tests.

- [ ] **Step 5: Write the failing persistence test**

Append to `apps/social-posts/src/pipeline.test.ts`, and add `updateEvent` to its `./pipeline/repo` import list:

```ts
test("profiles and overrides are stored, and a recurrence's override reaches its posts", async () => {
  const ev = await createEvent(pool, { name: "Newsletter", kind: "department" });
  const upd = await updateEvent(pool, ev.id, { drafting: { source: { kind: "mailchimp", subjectContains: "youth news", cutoff: "postDate" }, instructions: "Tease it." } });
  assert.ok(upd.ok);
  assert.deepEqual(upd.value.drafting.source, { kind: "mailchimp", subjectContains: "youth news", cutoff: "postDate" });

  const post = await createContent(pool, { title: "Youth news", publishDate: "2026-11-06", eventId: ev.id, platforms: ["facebook"],
    drafting: { instructions: "Just this one." }, sourceRef: { kind: "manual", content: "Pasted" }, phase: "Part 1" }, "me@x.org");
  assert.ok(post.ok);
  assert.equal(post.value.drafting.instructions, "Just this one.");
  assert.equal(post.value.sourceRef?.kind, "manual");
  assert.equal(post.value.phase, "Part 1");

  const r = await createRecurrence(pool, { title: "Saturday invite", platforms: ["facebook"], drafting: { instructions: "Invite." }, rule: weekly([6]) }, "me@x.org", REF);
  assert.ok(r.ok);
  const first = (await occ(r.value.id))[0];
  assert.deepEqual(first.drafting, { instructions: "Invite." }, "copied onto each occurrence");
  await updateRecurrence(pool, r.value.id, { drafting: { instructions: "Invite warmly." } }, REF);
  assert.deepEqual((await occ(r.value.id))[0].drafting, { instructions: "Invite warmly." }, "series edits reach untouched posts");
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npx tsc -p .`
Expected: FAIL. TypeScript errors: `drafting` does not exist on `EventInput`, `ContentInput` or `RecurrenceInput`.

- [ ] **Step 7: Add the columns**

In `apps/social-posts/src/schema.ts`, append before the closing backtick of `SCHEMA_SQL`:

```sql
-- Drafting profiles (docs/superpowers/specs/2026-10-20-pipeline-as-main-app-design.md):
-- an event's profile, and the overrides a recurring post or a post may carry.
ALTER TABLE events ADD COLUMN IF NOT EXISTS drafting jsonb NOT NULL DEFAULT '{}';
ALTER TABLE recurrences ADD COLUMN IF NOT EXISTS drafting jsonb NOT NULL DEFAULT '{}';
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS drafting jsonb NOT NULL DEFAULT '{}';
-- The source item a post was drafted from (a campaign, an episode, or pasted text).
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS source_ref jsonb;
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS phase text NOT NULL DEFAULT '';
-- Draft history: which post a draft belongs to.
ALTER TABLE post_drafts ADD COLUMN IF NOT EXISTS content_item_id text;
CREATE INDEX IF NOT EXISTS post_drafts_item_idx ON post_drafts (content_item_id);
```

- [ ] **Step 8: Validate the new input fields in `rules.ts`**

In `apps/social-posts/src/pipeline/rules.ts`:

1. Add the import: `import { Override, Profile, SourceRef, parseOverride, parseProfile, parseSourceRef } from "./drafting";`
2. Extend the input types:

```ts
// in ContentInput:
  drafting?: Override; sourceRef?: SourceRef | null; phase?: string;
// in EventInput:
  drafting?: Profile;
```

3. In `parseContentInput`, add three entries to the `collect(out, [ ... ])` list:

```ts
    ["drafting", "drafting" in body ? parseOverride(body.drafting) : undefined],
    ["sourceRef", "sourceRef" in body ? parseSourceRef(body.sourceRef) : undefined],
    ["phase", optText(body, "phase", "Phase", 200)],
```

4. In `parseEventInput`, add one entry:

```ts
    ["drafting", "drafting" in body ? parseProfile(body.drafting) : undefined],
```

`drafting.ts` imports only the `Result` type from `rules.ts`, so the circular import is type-only and safe.

- [ ] **Step 9: Persist the fields in `repo.ts`**

In `apps/social-posts/src/pipeline/repo.ts`:

1. Add the import: `import { Override, Profile, SourceRef } from "./drafting";`
2. `EventRow` gains `drafting: Profile;`. In `eventOf`, add `drafting: r.drafting || {},`.
3. `EVENT_COLUMNS` gains `drafting: "drafting",`.
4. `ContentRow` gains `drafting: Override; sourceRef: SourceRef | null; phase: string;`. In `contentOf`, add `drafting: r.drafting || {}, sourceRef: r.source_ref ?? null, phase: r.phase || "",`.
5. `CONTENT_COLUMNS` gains `drafting: "drafting", sourceRef: "source_ref", phase: "phase",`.
6. `TEMPLATE_KEYS` gains `"drafting"`: overriding one occurrence's instructions detaches it.
7. In `createContent`, extend the INSERT:

```ts
    `INSERT INTO content_items (title, event_id, platforms, publish_date, publish_time, status, owner_email,
                                brief, caption, no_media_needed, caption_mode, captions, drafting, source_ref, phase, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
    [input.title, input.eventId ?? null, input.platforms ?? DEFAULT_PLATFORMS, input.publishDate ?? null,
     input.publishTime ?? null, status, input.ownerEmail || "", input.brief || "", input.caption || "",
     !!input.noMediaNeeded, input.captionMode || "same", input.captions || {}, input.drafting || {},
     input.sourceRef ?? null, input.phase || "", createdBy],
```

8. In the scope `"future"` branch of `updateContent`, add `drafting: "drafting"` to the `map` object, so "this and later posts" carries the override to the recurrence.

- [ ] **Step 10: Carry overrides on recurrences**

In `apps/social-posts/src/pipeline/recurrence.ts`:

- `RecurrenceInput` gains `drafting?: Override;` (import `Override` and `parseOverride` from `./drafting`).
- In `parseRecurrenceInput`, before the `rule` block, add:

```ts
  if ("drafting" in b) {
    const d = parseOverride(b.drafting);
    if (!d.ok) return d;
    out.drafting = d.value;
  }
```

In `apps/social-posts/src/pipeline/recurring.ts`:

- `TEMPLATE_FIELDS` gains `["drafting", "drafting", "drafting"]`.
- `RecurrenceRow` gains `drafting: Override;`. In `recurrenceOf`, add `drafting: r.drafting || {},`.
- In `createRecurrence`, `cols` gains `drafting: input.drafting || {},`.
- In `materialize`, extend the occurrence INSERT so each new post copies the override:

```ts
        `INSERT INTO content_items (title, event_id, platforms, publish_date, publish_time, status, owner_email, brief,
                                    no_media_needed, draft_key, recurrence_id, occurrence_date, drafting, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$4,$12,'recurrence')
         ON CONFLICT (recurrence_id, occurrence_date) DO NOTHING RETURNING id`,
        [rec.title, rec.event_id, rec.platforms, date, rec.publish_time, rec.brief ? "planned" : "idea",
         rec.owner_email, rec.brief, rec.no_media_needed, rec.draft_key, rec.id, rec.drafting || {}],
```

- [ ] **Step 11: Run the whole suite**

Run: `npx tsc -p . && TEST_DATABASE_URL=postgres://postgres:test@localhost:55432/socialposts npm test`
Expected: PASS, including the new persistence test, with every existing test still green.

- [ ] **Step 12: Commit**

```bash
git add apps/social-posts/src/pipeline/drafting.ts apps/social-posts/src/pipeline-drafting.test.ts apps/social-posts/src/schema.ts apps/social-posts/src/pipeline/rules.ts apps/social-posts/src/pipeline/repo.ts apps/social-posts/src/pipeline/recurrence.ts apps/social-posts/src/pipeline/recurring.ts apps/social-posts/src/pipeline.test.ts
git commit -m "feat(pipeline): drafting profiles on events, overrides on recurrences and posts"
```

---

### Task 2: Seed texts and the prompt builder

**Files:**
- Create: `apps/social-posts/src/pipeline/drafting-seed.ts`, `apps/social-posts/src/pipeline/prompt.ts`
- Test: `apps/social-posts/src/pipeline-prompt.test.ts` (new)

**Interfaces:**
- Consumes: `Angle`, `Profile` (Task 1); `Platform` and `PLATFORMS` (`config.ts`); `countChars` (`platforms.ts`).
- Produces:
  - Seed data: `DEFAULT_VOICE: string`, `GRACE_NOTES_PROFILE: Profile`, `SUNDAY_PROFILE: Profile`, `BLOG_PROFILE: Profile`, `PODCAST_PROFILE: Profile`, `SERIES_INSTRUCTIONS: string`, `SERIES_PLAN_PROMPT(params): string[]`
  - `SourceContent { kind: "mailchimp" | "buzzsprout" | "manual"; id; title; url; date; dateLine; content; isDraft?; notYetPublic?; durationLabel? }`
  - `PromptInput { voice; context; instructions; eventName; eventKind; eventDates; title; brief; phase; publishDate: string | null; seriesPosition: { n: number; of: number } | null; source: SourceContent | null; platforms: string[]; captionMode: "same" | "separate"; caption; captions: Record<string, string> }`
  - `buildDraftPrompt(p: PromptInput): { system: string; user: string; keys: string[] }`, where `keys` is `["post"]` in same mode and the platform keys in separate mode.

- [ ] **Step 1: Write the failing tests**

Create `apps/social-posts/src/pipeline-prompt.test.ts`:

```ts
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { BLOG_PROFILE, DEFAULT_VOICE, GRACE_NOTES_PROFILE, PODCAST_PROFILE, SUNDAY_PROFILE } from "./pipeline/drafting-seed";
import { PromptInput, buildDraftPrompt } from "./pipeline/prompt";

const base: PromptInput = {
  voice: DEFAULT_VOICE, context: "", instructions: "", eventName: "", eventKind: "", eventDates: "",
  title: "Grace Notes", brief: "", phase: "", publishDate: "2026-10-21", seriesPosition: null, source: null,
  platforms: ["instagram", "facebook"], captionMode: "same", caption: "", captions: {},
};

test("seeded profiles carry today's run instructions word for word", () => {
  assert.equal(GRACE_NOTES_PROFILE.instructions,
    "Warm summary of what is inside this week Grace Notes. End with the archive link. Make people feel there is something worth reading, not just a notification.");
  assert.deepEqual(GRACE_NOTES_PROFILE.source, { kind: "mailchimp", subjectContains: "grace notes", cutoff: "followingSunday" });
  assert.match(SUNDAY_PROFILE.instructions!, /^Anticipatory invite for this Sunday's service\. Warm, specific to what is happening\. Should make someone who has not been in a while feel welcomed back\./);
  assert.deepEqual(BLOG_PROFILE.source, { kind: "mailchimp", subjectContains: "weekly blog", cutoff: "latest" });
  assert.match(BLOG_PROFILE.instructions!, /^Tease the most compelling idea or question from the blog\. Make someone want to read it\./);
  assert.deepEqual(PODCAST_PROFILE.angles!.map((a) => [a.key, a.offsetDays]),
    [["announcement", 0], ["question", 2], ["quote", 4], ["guest", 1], ["invite", 5]]);
  assert.match(DEFAULT_VOICE, /^GRMC voice rules: short, punchy, warm but not stiff\./);
});

test("a Grace Notes draft prompt reads like the Wednesday run's", () => {
  const p = buildDraftPrompt({ ...base, instructions: GRACE_NOTES_PROFILE.instructions!, source: {
    kind: "mailchimp", id: "c1", title: "Grace Notes - October 18, 2026", url: "https://mailchi.mp/x", date: "2026-10-18",
    dateLine: "Sent Oct 15, 2026", content: "This week: the harvest supper.",
  } });
  assert.ok(p.user.includes(DEFAULT_VOICE));
  assert.ok(p.user.includes(GRACE_NOTES_PROFILE.instructions!));
  assert.match(p.user, /SOURCE: Grace Notes - October 18, 2026/);
  assert.match(p.user, /SOURCE URL: https:\/\/mailchi\.mp\/x/);
  assert.match(p.user, /This week: the harvest supper\./);
  assert.deepEqual(p.keys, ["post"]);
  assert.match(p.system, /Return ONLY a JSON object/);
});

test("an unsent campaign and an unreleased episode are flagged to Claude", () => {
  const draft = buildDraftPrompt({ ...base, source: { kind: "mailchimp", id: "c", title: "T", url: "", date: "", dateLine: "", content: "x", isDraft: true } });
  assert.match(draft.user, /not been sent yet/);
  const ep = buildDraftPrompt({ ...base, source: { kind: "buzzsprout", id: "9", title: "Too small?", url: "https://buzz/9", date: "2026-11-01",
    dateLine: "Drops Nov 1, 2026", content: "Show notes", notYetPublic: true, durationLabel: "32 min" } });
  assert.match(ep.user, /EPISODE TITLE: Too small\?/);
  assert.match(ep.user, /LISTEN URL: https:\/\/buzz\/9/);
  assert.match(ep.user, /EPISODE LENGTH: 32 min/);
  assert.match(ep.user, /NOT YET PUBLIC: this episode is Drops Nov 1, 2026\. Write as though it is landing, not as though it is already out\./);
});

test("separate captions ask for one key per platform, with each platform's guidance", () => {
  const p = buildDraftPrompt({ ...base, platforms: ["instagram", "x"], captionMode: "separate", captions: { x: "Old X" } });
  assert.deepEqual(p.keys, ["instagram", "x"]);
  assert.match(p.user, /link in bio/);
  assert.match(p.user, /Hard limit 280 characters/);
  assert.match(p.user, /X: Old X/, "current drafts are passed back to improve on");
  assert.match(p.system, /"instagram", "x"/);
});

test("same caption going to X must fit X; series posts say where they sit", () => {
  const p = buildDraftPrompt({ ...base, platforms: ["facebook", "x"], seriesPosition: { n: 3, of: 13 }, phase: "Our roots", context: "Founded 2022." });
  assert.match(p.user, /at most 280 characters/);
  assert.match(p.user, /THIS POST: 3 of 13/);
  assert.match(p.user, /PHASE: Our roots/);
  assert.match(p.user, /BACKGROUND AND KEY MESSAGES: Founded 2022\./);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx tsc -p .`
Expected: FAIL. `Cannot find module './pipeline/drafting-seed'`.

- [ ] **Step 3: Create the seed data**

Create `apps/social-posts/src/pipeline/drafting-seed.ts`. The strings are copied verbatim from the current `voice.ts`, `runs.ts`, `podcast-angles.ts` and `series.ts`; do not reword them.

```ts
// What the old Wednesday/Friday/Podcast runs and series drafting said to
// Claude, carried over word for word so drafts don't change when the runs
// become profiles. Seeded once by migrate-drafting.ts; editable afterwards.
import { Profile } from "./drafting";

export const DEFAULT_VOICE = "GRMC voice rules: short, punchy, warm but not stiff. Salutations ('Family of Grace', 'Hey everyone') should be used sparingly, and rarely on content for both members and guests. Salutations are acceptible on posts that are more towards members. Open as an invitation, not insider communication. 2-4 sentences, line breaks between thoughts. No hashtags unless natural. Sentence case. No em-dashes as decoration.";

export const GRACE_NOTES_PROFILE: Profile = {
  source: { kind: "mailchimp", subjectContains: "grace notes", cutoff: "followingSunday" },
  instructions: "Warm summary of what is inside this week Grace Notes. End with the archive link. Make people feel there is something worth reading, not just a notification.",
};

// The run's "service preview" box is now the post's brief.
export const SUNDAY_PROFILE: Profile = {
  source: { kind: "none" },
  instructions: "Anticipatory invite for this Sunday's service. Warm, specific to what is happening. Should make someone who has not been in a while feel welcomed back. The brief has this Sunday's service details; if it has none, write a warm general invite to Sunday 11am worship.",
};

export const BLOG_PROFILE: Profile = {
  source: { kind: "mailchimp", subjectContains: "weekly blog", cutoff: "latest" },
  instructions: "Tease the most compelling idea or question from the blog. Make someone want to read it. End with the archive URL on its own line. Do not summarize everything — hook with one strong thread.",
};

export const PODCAST_PROFILE: Profile = {
  source: { kind: "buzzsprout" },
  instructions: "Promote this podcast episode. Each post stands alone. Do not number them or refer to the others.",
  angles: [
    { key: "announcement", label: "Announcement", offsetDays: 0,
      instructions: "The episode is out. Open with the most compelling thread in it, name the guest if there is one, and end with the listen link on its own line. Make someone want to press play, not merely know it exists." },
    { key: "question", label: "The question it wrestles with", offsetDays: 2,
      instructions: "Lead with the real question this episode sits with. Ask it plainly and let it breathe, then point to the episode as where it gets worked through. Do not answer it in the post." },
    { key: "quote", label: "Pull quote", offsetDays: 4,
      instructions: "One striking line or idea from the episode, framed so it stands on its own. Keep it short. Attribute it when there is a clear speaker. Close with the listen link." },
    { key: "guest", label: "Guest or topic spotlight", offsetDays: 1,
      instructions: "Introduce who is on this episode, or what it digs into when there is no guest, and why this person or subject is worth an hour of someone's attention." },
    { key: "invite", label: "Invite to Sunday", offsetDays: 5,
      instructions: "Connect the episode's theme to gathering on Sunday at 11am. Warm, never a hard sell. It should read as an open door to someone who has never walked through it." },
  ],
};

export const SERIES_INSTRUCTIONS = "Write it as the next chapter in an unfolding story, not a standalone fact post. Tone: educational but not lecture-y, warm, inviting, makes people want to follow along.";

// From series.ts generateSeriesPostsWithClaude, with dates asked for as
// YYYY-MM-DD so they land straight on the calendar.
export function SERIES_PLAN_PROMPT(p: { name: string; description: string; context: string; count: number; cadence: string; startDate: string }): string[] {
  return [
    `Generate a post schedule for a social media series called "${p.name}".`,
    "Description: " + p.description,
    "Context: " + p.context,
    "Number of posts: " + p.count,
    "Cadence: " + (p.cadence || "weekly"),
    "Start date: " + (p.startDate || "TBD"),
    "",
    "Return ONLY a JSON array of objects, each with: date (YYYY-MM-DD), phase (string, group label or empty), title (short post title), sub (angle/description for this post, 1-2 sentences).",
    "Plan the arc: build toward a conclusion, group into 2-3 phases if it makes sense.",
    "No markdown fences, just valid JSON array.",
  ];
}
```

Before committing, check the copies character for character against the originals: `git show HEAD:apps/social-posts/src/runs.ts`, `git show HEAD:apps/social-posts/src/podcast-angles.ts`, `git show HEAD:apps/social-posts/src/series.ts`, `git show HEAD:apps/social-posts/src/voice.ts`. The Sunday text adds one sentence, which replaces the run's "(not provided - write a warm general invite…)" fallback; the Podcast instructions combine the run's two closing lines. Both changes are intended.

- [ ] **Step 4: Create the prompt builder**

Create `apps/social-posts/src/pipeline/prompt.ts`:

```ts
// One prompt for every kind of post: house voice, the event's background,
// the instructions in force, the post itself, the source material, and how
// each platform wants it. Pure, so tests can hold the wording steady.
import { formatMonthDayYear } from "../dates";
import { PLATFORMS } from "./config";

export interface SourceContent {
  kind: "mailchimp" | "buzzsprout" | "manual";
  id: string; title: string; url: string; date: string; dateLine: string; content: string;
  isDraft?: boolean; notYetPublic?: boolean; durationLabel?: string;
}

export interface PromptInput {
  voice: string; context: string; instructions: string;
  eventName: string; eventKind: string; eventDates: string;
  title: string; brief: string; phase: string; publishDate: string | null;
  seriesPosition: { n: number; of: number } | null;
  source: SourceContent | null;
  platforms: string[]; captionMode: "same" | "separate"; caption: string; captions: Record<string, string>;
}

const SYS = "You draft social media posts for Grace Resurrection Methodist Church (GRMC) in Marietta, GA. "
  + "Return ONLY a JSON object, no markdown fences, just valid JSON.";

export function buildDraftPrompt(p: PromptInput): { system: string; user: string; keys: string[] } {
  const selected = PLATFORMS.filter((x) => p.platforms.includes(x.key));
  const separate = p.captionMode === "separate" && selected.length > 0;
  const lines: string[] = [
    separate
      ? `Draft one GRMC post for each of these platforms: ${selected.map((x) => x.label).join(", ")}. Same message, written natively for each platform.`
      : "Draft one GRMC social media post that will go out unchanged on: " + (selected.map((x) => x.label).join(", ") || "Instagram, Facebook") + ".",
    "", p.voice, "", "--- CONTEXT ---",
    "POST TITLE: " + (p.title || "(none)"),
    "BRIEF: " + (p.brief || "(none — work from the title and source)"),
    "PUBLISH DATE: " + (p.publishDate ? formatMonthDayYear(p.publishDate) : "not set"),
  ];
  if (p.eventName) lines.push(`EVENT/DEPARTMENT: ${p.eventName}${p.eventKind ? ` (${p.eventKind})` : ""}`);
  if (p.eventDates) lines.push("EVENT DATES: " + p.eventDates);
  if (p.context) lines.push("BACKGROUND AND KEY MESSAGES: " + p.context);
  if (p.seriesPosition) lines.push(`THIS POST: ${p.seriesPosition.n} of ${p.seriesPosition.of}`);
  if (p.phase) lines.push("PHASE: " + p.phase);

  const s = p.source;
  if (s && s.kind === "buzzsprout") {
    lines.push("", "--- SOURCE ---", "EPISODE TITLE: " + (s.title || "(not available)"), "LISTEN URL: " + (s.url || "(not provided)"));
    if (s.durationLabel) lines.push("EPISODE LENGTH: " + s.durationLabel);
    if (s.notYetPublic) lines.push("NOT YET PUBLIC: this episode is " + s.dateLine + ". Write as though it is landing, not as though it is already out.");
    lines.push("", "EPISODE DESCRIPTION:", s.content || "(not provided)");
  } else if (s) {
    lines.push("", "--- SOURCE ---", "SOURCE: " + (s.title || "(untitled)") + (s.isDraft ? " (this issue has not been sent yet; don't describe it as already out)" : ""),
      "SOURCE URL: " + (s.url || "(not provided)"), "", "SOURCE CONTENT:", s.content || "(not provided)");
  }

  lines.push("", "--- WHAT TO WRITE ---", p.instructions);

  let keys: string[];
  if (separate) {
    keys = selected.map((x) => x.key);
    lines.push("", "--- PLATFORMS ---", ...selected.map((x) => x.guidance));
    const current = selected.filter((x) => p.captions[x.key]);
    if (current.length) {
      lines.push("", "CURRENT DRAFTS (improve on them, keep what works):");
      for (const x of current) lines.push(`${x.label.toUpperCase()}: ${p.captions[x.key]}`);
    }
  } else {
    keys = ["post"];
    if (selected.some((x) => x.key === "x")) lines.push("", "It must fit X: at most 280 characters, any link counting as 23.");
    if (selected.some((x) => x.key === "instagram")) lines.push("It goes under an image on Instagram, where links aren't clickable; if there's a link, also say where to find it.");
    if (p.caption) lines.push("", "CURRENT DRAFT (improve on it, keep what works):", p.caption);
  }
  const system = SYS + ` Keys: ${keys.map((k) => `"${k}"`).join(", ")}, each a string holding that post's text.`;
  return { system, user: lines.join("\n"), keys };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx tsc -p . && node --test dist/pipeline-prompt.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/social-posts/src/pipeline/drafting-seed.ts apps/social-posts/src/pipeline/prompt.ts apps/social-posts/src/pipeline-prompt.test.ts
git commit -m "feat(pipeline): run prompts as seed data and a single draft prompt builder"
```

---

### Task 3: Sources: choosing and fetching the Mailchimp issue or Buzzsprout episode

**Files:**
- Create: `apps/social-posts/src/pipeline/sources.ts`
- Modify: `apps/social-posts/src/mailchimp.ts`
- Test: `apps/social-posts/src/pipeline-sources.test.ts` (new, pure), `apps/social-posts/src/pipeline.test.ts` (append)

**Interfaces:**
- Consumes: `SourceConfig`, `SourceRef`, `Cutoff` (Task 1); `SourceContent` (Task 2); `getEpisode(pool, id): Promise<Episode>` (`buzzsprout.ts`, unchanged).
- Produces:
  - In `mailchimp.ts`: `CampaignSummary { id; subject; status; archiveUrl; sentAt; createdAt; issueDate; isDraft; dateLine }`, `listCampaigns(pool, subjectMatch: string): Promise<CampaignSummary[]>` (newest first) and `getCampaignText(pool, id: string): Promise<string>`.
  - In `sources.ts`: `cutoffDate(cutoff: Cutoff, postDate: string | null): string | null`, `pickCampaign(campaigns: CampaignSummary[], cutoff: Cutoff, postDate: string | null): CampaignSummary | null` and `resolveSource(pool, source: SourceConfig, ref: SourceRef | null, postDate: string | null): Promise<SourceContent | null>`.

- [ ] **Step 1: Write the failing pure tests**

Create `apps/social-posts/src/pipeline-sources.test.ts`:

```ts
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { cutoffDate, pickCampaign } from "./pipeline/sources";
import { CampaignSummary } from "./mailchimp";

const c = (id: string, createdAt: string): CampaignSummary => ({
  id, subject: "Grace Notes " + id, status: "sent", archiveUrl: "https://x/" + id, sentAt: createdAt, createdAt,
  issueDate: "", isDraft: false, dateLine: "",
});
// Newest first, as listCampaigns returns them.
const list = [c("oct25", "2026-10-23T14:00:00Z"), c("oct18", "2026-10-16T14:00:00Z"), c("oct11", "2026-10-09T14:00:00Z")];

test("the Sunday on or after a post's date", () => {
  assert.equal(cutoffDate("followingSunday", "2026-10-21"), "2026-10-25", "Wednesday → that Sunday");
  assert.equal(cutoffDate("followingSunday", "2026-10-25"), "2026-10-25", "a Sunday is its own cutoff");
  assert.equal(cutoffDate("postDate", "2026-10-21"), "2026-10-21");
  assert.equal(cutoffDate("latest", "2026-10-21"), null);
  assert.equal(cutoffDate("followingSunday", null), null, "no date: no cutoff");
});

test("picking the issue, as the Wednesday and Friday runs did", () => {
  assert.equal(pickCampaign(list, "latest", "2026-10-14")?.id, "oct25");
  assert.equal(pickCampaign(list, "followingSunday", "2026-10-14")?.id, "oct18", "Wed Oct 14 gets the issue made by Sun Oct 18");
  assert.equal(pickCampaign(list, "followingSunday", "2026-10-07")?.id, "oct11", "Wed Oct 7 gets the issue made by Sun Oct 11");
  assert.equal(pickCampaign(list, "postDate", "2026-10-20")?.id, "oct18");
  assert.equal(pickCampaign(list, "followingSunday", null)?.id, "oct25", "no publish date: newest");
  assert.equal(pickCampaign(list, "postDate", "2026-01-01")?.id, "oct25", "nothing old enough: newest, as the run did");
  assert.equal(pickCampaign([], "latest", null), null);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx tsc -p .`
Expected: FAIL. `Cannot find module './pipeline/sources'`, and `CampaignSummary` is not exported from `./mailchimp`.

- [ ] **Step 3: Split the Mailchimp campaign lookup**

In `apps/social-posts/src/mailchimp.ts`, add these exports above `getLatestCampaign`, and re-implement `getLatestCampaign` on top of them so the old routes keep working until Task 7:

```ts
export interface CampaignSummary {
  id: string; subject: string; status: string; archiveUrl: string;
  sentAt: string; createdAt: string; issueDate: string; isDraft: boolean; dateLine: string;
}

/** The newest 30 campaigns whose subject contains `subjectMatch` (resends skipped), newest first. */
export async function listCampaigns(pool: Pool, subjectMatch: string): Promise<CampaignSummary[]> {
  const mc = await getMailchimpAuth(pool);
  const listUrl =
    mc.base +
    "/campaigns?count=30&sort_field=create_time&sort_dir=DESC" +
    "&fields=campaigns.id,campaigns.status,campaigns.settings.subject_line,campaigns.archive_url,campaigns.send_time,campaigns.create_time";
  const listRes: any = await (await fetch(listUrl, { headers: mc.headers })).json();
  const match = subjectMatch.toLowerCase();
  const tz = (await getSetting(pool, "default_timezone")) || DEFAULT_TZ;
  return (listRes.campaigns || [])
    .filter((c: any) => {
      const subj = (c.settings?.subject_line || "").toLowerCase();
      return subj.indexOf(match) !== -1 && subj.indexOf("resend") === -1;
    })
    .map((c: any) => {
      const subject = c.settings?.subject_line || "";
      const dates: CampaignDates = { status: c.status || "", sentAt: c.send_time || "", createdAt: c.create_time || "", issueDate: parseIssueDate(subject) };
      return { id: c.id, subject, archiveUrl: c.archive_url || "", ...dates, isDraft: isDraftStatus(dates.status), dateLine: campaignDateLine(dates, tz) };
    });
}

/** A campaign's text, cleaned and trimmed the way the runs used it. */
export async function getCampaignText(pool: Pool, id: string): Promise<string> {
  const mc = await getMailchimpAuth(pool);
  const res: any = await (await fetch(mc.base + "/campaigns/" + encodeURIComponent(id) + "/content?fields=plain_text", { headers: mc.headers })).json();
  return cleanCampaignText(res.plain_text || "").substring(0, 4000);
}
```

Then replace the body of `getLatestCampaign` with:

```ts
async function getLatestCampaign(pool: Pool, subjectMatch: string, beforeDate: string | null): Promise<CampaignContent> {
  const matches = await listCampaigns(pool, subjectMatch);
  if (!matches.length) throw new Error(`No ${subjectMatch} campaigns found in Mailchimp.`);
  let target = matches[0];
  if (beforeDate) {
    const cutoff = new Date(beforeDate + "T23:59:59");
    for (const c of matches) if (new Date(c.createdAt) <= cutoff) { target = c; break; }
  }
  const { id: _id, ...rest } = target;
  return { ...rest, preview: await getCampaignText(pool, target.id) };
}
```

- [ ] **Step 4: Create `sources.ts`**

Create `apps/social-posts/src/pipeline/sources.ts`:

```ts
// Where a post's source material comes from: the Mailchimp issue the profile
// points at for this post's date, the Buzzsprout episode it's pinned to, or
// text someone pasted. Fetched only when asked (opening the editor's source
// panel, or drafting), never on a schedule.
import { Pool } from "pg";
import { addDays } from "../dates";
import { CampaignSummary, getCampaignText, listCampaigns } from "../mailchimp";
import { getEpisode } from "../buzzsprout";
import { Cutoff, SourceConfig, SourceRef } from "./drafting";
import { SourceContent } from "./prompt";

/** The last day an issue may have been created on, or null for "newest". */
export function cutoffDate(cutoff: Cutoff, postDate: string | null): string | null {
  if (!postDate || cutoff === "latest") return null;
  if (cutoff === "postDate") return postDate;
  const dow = new Date(postDate + "T12:00:00Z").getUTCDay();
  return addDays(postDate, (7 - dow) % 7);
}

/**
 * The issue a post should draft from: the newest created on or before the
 * cutoff, else the newest overall (what the runs did when nothing was old
 * enough). `campaigns` is newest first.
 */
export function pickCampaign(campaigns: CampaignSummary[], cutoff: Cutoff, postDate: string | null): CampaignSummary | null {
  if (!campaigns.length) return null;
  const day = cutoffDate(cutoff, postDate);
  if (!day) return campaigns[0];
  const limit = new Date(day + "T23:59:59");
  return campaigns.find((c) => new Date(c.createdAt) <= limit) || campaigns[0];
}

/**
 * The content Draft with Claude should use for a post. A stored ref (a picked
 * campaign or episode, or pasted text) wins over the profile; otherwise a
 * Mailchimp profile picks by date. A Buzzsprout profile with no pinned episode
 * returns null: the editor asks which episode.
 */
export async function resolveSource(
  pool: Pool, source: SourceConfig, ref: SourceRef | null, postDate: string | null,
): Promise<SourceContent | null> {
  if (ref?.kind === "manual") {
    return { kind: "manual", id: "", title: ref.title || "Pasted content", url: ref.url || "", date: "", dateLine: "", content: ref.content || "" };
  }
  if (ref?.kind === "buzzsprout" || (!ref && source.kind === "buzzsprout")) {
    if (!ref?.id) return null;
    const ep = await getEpisode(pool, ref.id);
    return {
      kind: "buzzsprout", id: String(ep.id), title: ep.title, url: ep.listenUrl, date: ep.publishDate, dateLine: ep.dateLine,
      content: ep.description, notYetPublic: !ep.isPublished, durationLabel: ep.durationLabel,
    };
  }
  if (ref?.kind === "mailchimp" || source.kind === "mailchimp") {
    let summary: CampaignSummary | null = null;
    if (ref?.kind === "mailchimp" && ref.id) {
      const recent = source.kind === "mailchimp" ? await listCampaigns(pool, source.subjectContains || "") : [];
      summary = recent.find((c) => c.id === ref.id) || {
        id: ref.id, subject: ref.title || "Mailchimp campaign", status: "sent", archiveUrl: ref.url || "",
        sentAt: "", createdAt: "", issueDate: ref.date || "", isDraft: false, dateLine: "",
      };
    } else {
      const matches = await listCampaigns(pool, source.subjectContains || "");
      if (!matches.length) throw new Error(`No Mailchimp campaigns with "${source.subjectContains}" in the subject.`);
      summary = pickCampaign(matches, source.cutoff || "latest", postDate);
    }
    if (!summary) return null;
    return {
      kind: "mailchimp", id: summary.id, title: summary.subject, url: summary.archiveUrl, date: summary.issueDate,
      dateLine: summary.dateLine, content: await getCampaignText(pool, summary.id), isDraft: summary.isDraft,
    };
  }
  return null;
}
```

- [ ] **Step 5: Write the failing fetch-stubbed resolution test**

Append to `apps/social-posts/src/pipeline.test.ts`:

```ts
// Stands in for Mailchimp, Buzzsprout and Anthropic in database tests.
function stubFetch(routes: Array<[RegExp, (url: string, init?: any) => unknown]>) {
  const real = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (url: unknown, init?: any) => {
    const u = String(url);
    calls.push(u);
    const route = routes.find(([re]) => re.test(u));
    if (!route) throw new Error("Unexpected fetch: " + u);
    const body = route[1](u, init);
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = real; } };
}

const CAMPAIGNS = { campaigns: [
  { id: "c25", status: "save", settings: { subject_line: "Grace Notes - October 25, 2026" }, archive_url: "https://mc/c25", send_time: "", create_time: "2026-10-23T14:00:00Z" },
  { id: "c18", status: "sent", settings: { subject_line: "Grace Notes - October 18, 2026" }, archive_url: "https://mc/c18", send_time: "2026-10-16T14:00:00Z", create_time: "2026-10-16T13:00:00Z" },
  { id: "b1", status: "sent", settings: { subject_line: "Weekly Blog - Oct 16" }, archive_url: "https://mc/b1", send_time: "2026-10-16T14:00:00Z", create_time: "2026-10-16T13:00:00Z" },
] };

test("a Mailchimp source picks the issue for the post's week, and a pinned ref wins", async () => {
  const { resolveSource } = await import("./pipeline/sources");
  await pool.query("INSERT INTO settings (key, value) VALUES ('mailchimp_api_key','k'), ('mailchimp_server','us1') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value");
  const f = stubFetch([
    [/\/campaigns\?/, () => CAMPAIGNS],
    [/\/campaigns\/(\w+)\/content/, (u) => ({ plain_text: "Text of " + /campaigns\/(\w+)\//.exec(u)![1] })],
  ]);
  try {
    const gn = { kind: "mailchimp" as const, subjectContains: "grace notes", cutoff: "followingSunday" as const };
    const wk = await resolveSource(pool, gn, null, "2026-10-14");
    assert.equal(wk?.id, "c18");
    assert.equal(wk?.content, "Text of c18");
    const next = await resolveSource(pool, gn, null, "2026-10-21");
    assert.equal(next?.id, "c25");
    assert.equal(next?.isDraft, true, "an unsent issue is marked");
    const pinned = await resolveSource(pool, gn, { kind: "mailchimp", id: "c18", title: "Grace Notes - October 18, 2026" }, "2026-10-21");
    assert.equal(pinned?.id, "c18", "the post keeps the issue it was drafted from");
    const undated = await resolveSource(pool, gn, null, null);
    assert.equal(undated?.id, "c25", "no publish date: newest");
    assert.equal(await resolveSource(pool, { kind: "buzzsprout" }, null, "2026-10-21"), null, "no episode picked yet");
    const manual = await resolveSource(pool, gn, { kind: "manual", content: "Pasted", url: "https://p" }, "2026-10-21");
    assert.equal(manual?.content, "Pasted");
  } finally {
    f.restore();
    await pool.query("DELETE FROM settings WHERE key IN ('mailchimp_api_key','mailchimp_server')");
  }
});
```

- [ ] **Step 6: Run the suite**

Run: `npx tsc -p . && TEST_DATABASE_URL=postgres://postgres:test@localhost:55432/socialposts npm test`
Expected: PASS. `mailchimp.test.ts` still passes, since its pure helpers are unchanged.

- [ ] **Step 7: Commit**

```bash
git add apps/social-posts/src/mailchimp.ts apps/social-posts/src/pipeline/sources.ts apps/social-posts/src/pipeline-sources.test.ts apps/social-posts/src/pipeline.test.ts
git commit -m "feat(pipeline): resolve a post's Mailchimp issue or Buzzsprout episode by date"
```

---
### Task 4: Draft with Claude from the profile and source, with draft history

**Files:**
- Create: `apps/social-posts/src/pipeline/history.ts`
- Rewrite: `apps/social-posts/src/pipeline/caption.ts`
- Modify: `apps/social-posts/src/routes/pipeline.ts`
- Test: `apps/social-posts/src/pipeline.test.ts` (append; replace the iteration-3 "Draft with Claude writes one caption per platform…" test)

**Interfaces:**
- Consumes: `effectiveProfile`, `parseOverride`, `parseSourceRef`, `Override`, `SourceRef`, `Effective` (Task 1); `buildDraftPrompt`, `SourceContent`, `DEFAULT_VOICE` (Task 2); `resolveSource` (Task 3); `getContentRow` (`repo.ts`); `callClaude`, `stripJsonFences` (`claude.ts`).
- Produces:
  - In `history.ts`: `DraftEntry { id: number; at: string; by: string; origin: "claude" | "run"; captionMode: "same" | "separate"; caption: string; captions: Record<string, string> }`, `logDraft(db, contentItemId: string, d: { captionMode; caption?; captions? }, createdBy: string): Promise<void>` and `listDraftHistory(db, contentItemId: string): Promise<DraftEntry[]>` (newest first, at most 20, including the run draft linked by `draft_id`).
  - In `caption.ts`:
    - `DraftRequest { contentItemId: string | null; title; brief; phase; eventId: string | null; platforms: string[]; publishDate: string | null; captionMode: "same" | "separate"; caption; captions; drafting: Override; sourceRef: SourceRef | null }`
    - `parseDraftRequest(raw, opts?: { preview?: boolean }): Result<DraftRequest>`
    - `resolveForDraft(pool, req): Promise<{ effective: Effective; source: SourceContent | null; event: { name; kind; notes; startDate; endDate } | null }>`
    - `DraftResult { caption?: string; captions?: Record<string, string>; warnings: string[]; source: SourceContent | null }`
    - `draftCaptions(pool, req, createdBy: string): Promise<Result<DraftResult>>`
    - `draftAndSave(pool, id: string, createdBy: string): Promise<Result<ContentRow>>`
    - `draftAll(pool, ids: string[], createdBy: string): Promise<Array<{ id: string; ok: boolean; error?: string }>>`
  - Routes:
    - `POST /api/pipeline/draft-caption` (body: editor state plus `contentItemId`) returns `{ ok, caption | captions, warnings, source }`.
    - `POST /api/pipeline/source/preview` (body: editor state) returns `{ ok, effective: { source, instructions, from }, source: SourcePreview | null, error?: string }`, where `SourcePreview` is a `SourceContent` minus `content`, plus `excerpt` (the first 400 characters).
    - `GET /api/pipeline/sources/campaigns?subject=…` returns `{ ok, campaigns: CampaignSummary[] }`.
    - `GET /api/pipeline/sources/episodes` returns `{ ok, episodes: Episode[] }`.
    - `GET /api/pipeline/content/:id/drafts` returns `{ ok, drafts: DraftEntry[] }`.
    - `POST /api/pipeline/draft-all` (body `{ ids }`) returns `{ ok, results }`.

- [ ] **Step 1: Write the failing tests**

In `apps/social-posts/src/pipeline.test.ts`, **delete** the test titled `"Draft with Claude writes one caption per platform and keeps X under 280"` (its request shape is gone). Then append:

```ts
const anthropicReply = (obj: unknown) => ({ content: [{ text: JSON.stringify(obj) }] });

async function withKeys<T>(fn: () => Promise<T>): Promise<T> {
  await pool.query(`INSERT INTO settings (key, value) VALUES ('anthropic_api_key','t'), ('mailchimp_api_key','k'), ('mailchimp_server','us1')
                    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
  try { return await fn(); }
  finally { await pool.query("DELETE FROM settings WHERE key IN ('anthropic_api_key','mailchimp_api_key','mailchimp_server')"); }
}

test("Draft with Claude drafts a Grace Notes post from that week's issue, and logs it", async () => {
  const { draftAndSave } = await import("./pipeline/caption");
  const { listDraftHistory } = await import("./pipeline/history");
  const { GRACE_NOTES_PROFILE } = await import("./pipeline/drafting-seed");
  const ev = await createEvent(pool, { name: "GN test", kind: "series" });
  await updateEvent(pool, ev.id, { drafting: GRACE_NOTES_PROFILE });
  const post = await createContent(pool, { title: "Grace Notes", publishDate: "2026-10-14", eventId: ev.id, platforms: ["facebook"] }, "me@x.org");
  assert.ok(post.ok);
  const prompts: string[] = [];
  const f = stubFetch([
    [/\/campaigns\?/, () => CAMPAIGNS],
    [/\/campaigns\/(\w+)\/content/, (u) => ({ plain_text: "Text of " + /campaigns\/(\w+)\//.exec(u)![1] })],
    [/api\.anthropic\.com/, (_u, init) => { prompts.push(JSON.parse(init.body).messages[0].content); return anthropicReply({ post: "This week in Grace Notes…" }); }],
  ]);
  try {
    const r = await withKeys(() => draftAndSave(pool, post.value.id, "me@x.org"));
    assert.ok(r.ok);
    assert.equal(r.value.caption, "This week in Grace Notes…");
    assert.equal(r.value.status, "drafted");
    assert.equal(r.value.sourceRef?.id, "c18", "remembers the issue it drafted from");
    assert.ok(prompts[0].includes(GRACE_NOTES_PROFILE.instructions!), "the Wednesday instructions, word for word");
    assert.match(prompts[0], /Text of c18/);
    assert.equal((await listDraftHistory(pool, post.value.id)).length, 1);

    // The event's profile changes; the drafted post keeps its issue.
    await updateEvent(pool, ev.id, { drafting: { ...GRACE_NOTES_PROFILE, source: { kind: "mailchimp", subjectContains: "grace notes", cutoff: "latest" } } });
    await withKeys(() => draftAndSave(pool, post.value.id, "me@x.org"));
    assert.match(prompts[1], /Text of c18/);
    assert.equal((await listDraftHistory(pool, post.value.id)).length, 2);
  } finally { f.restore(); }
});

test("drafting without Mailchimp set up still works from pasted content", async () => {
  const { draftCaptions, parseDraftRequest, resolveForDraft } = await import("./pipeline/caption");
  const { GRACE_NOTES_PROFILE } = await import("./pipeline/drafting-seed");
  const ev = await createEvent(pool, { name: "GN no keys", kind: "series" });
  await updateEvent(pool, ev.id, { drafting: GRACE_NOTES_PROFILE });
  const req = parseDraftRequest({ title: "Grace Notes", eventId: ev.id, platforms: ["facebook"], publishDate: "2026-10-14" });
  assert.ok(req.ok);
  await assert.rejects(() => resolveForDraft(pool, req.value), /Mailchimp credentials not configured/);
  const pasted = parseDraftRequest({ title: "Grace Notes", eventId: ev.id, platforms: ["facebook"], publishDate: "2026-10-14",
    sourceRef: { kind: "manual", content: "Pasted issue text", url: "https://mc/x" } });
  assert.ok(pasted.ok);
  await pool.query("INSERT INTO settings (key, value) VALUES ('anthropic_api_key','t') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value");
  const f = stubFetch([[/api\.anthropic\.com/, () => anthropicReply({ post: "From the paste" })]]);
  try {
    const r = await draftCaptions(pool, pasted.value, "me@x.org");
    assert.ok(r.ok);
    assert.equal(r.value.caption, "From the paste");
  } finally { f.restore(); await pool.query("DELETE FROM settings WHERE key = 'anthropic_api_key'"); }
});

test("a bad reply from Claude saves nothing, and Draft all carries on past it", async () => {
  const { draftAll } = await import("./pipeline/caption");
  const a = await createContent(pool, { title: "A", publishDate: "2026-11-02", platforms: ["facebook"], caption: "keep me" }, "me@x.org");
  const b = await createContent(pool, { title: "B", publishDate: "2026-11-03", platforms: ["facebook", "x"], captionMode: "separate" }, "me@x.org");
  const c = await createContent(pool, { title: "C", publishDate: "2026-11-04", platforms: ["facebook"] }, "me@x.org");
  assert.ok(a.ok && b.ok && c.ok);
  const replies = ["not json at all", JSON.stringify({ facebook: "FB only" }), JSON.stringify({ post: "C drafted" })];
  await pool.query("INSERT INTO settings (key, value) VALUES ('anthropic_api_key','t') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value");
  const f = stubFetch([[/api\.anthropic\.com/, () => ({ content: [{ text: replies.shift() }] })]]);
  try {
    const results = await draftAll(pool, [a.value.id, b.value.id, c.value.id], "me@x.org");
    assert.deepEqual(results.map((r) => r.ok), [false, false, true]);
    assert.match(results[0].error!, /wasn't readable/);
    assert.match(results[1].error!, /didn't write the X caption/);
    assert.equal((await getContent(pool, a.value.id)).ok && (await pool.query("SELECT caption FROM content_items WHERE id=$1", [a.value.id])).rows[0].caption, "keep me");
  } finally { f.restore(); await pool.query("DELETE FROM settings WHERE key = 'anthropic_api_key'"); }
});

test("a podcast post can't draft until its episode is picked", async () => {
  const { draftCaptions, parseDraftRequest } = await import("./pipeline/caption");
  const ev = await createEvent(pool, { name: "Pod test", kind: "series" });
  await updateEvent(pool, ev.id, { drafting: { source: { kind: "buzzsprout" } } });
  const req = parseDraftRequest({ title: "Episode post", eventId: ev.id, platforms: ["facebook"], publishDate: "2026-11-02" });
  assert.ok(req.ok);
  const r = await draftCaptions(pool, req.value, "me@x.org");
  assert.ok(!r.ok);
  assert.match(r.error, /Pick the episode this post is about/);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/social-posts && npx tsc -p .`
Expected: FAIL. `Cannot find module './pipeline/history'`, and `draftAndSave` is not exported from `./pipeline/caption`.

- [ ] **Step 3: Create `history.ts`**

Create `apps/social-posts/src/pipeline/history.ts`:

```ts
// Every Draft with Claude result, kept against its post, so an earlier
// draft can be brought back. Stored in post_drafts (which also holds the old
// runs' drafts) with content_item_id set.
import { Pool, PoolClient } from "pg";

type Db = Pool | PoolClient;

export interface DraftEntry {
  id: number; at: string; by: string; origin: "claude" | "run";
  captionMode: "same" | "separate"; caption: string; captions: Record<string, string>;
}

export async function logDraft(
  db: Db, contentItemId: string,
  d: { captionMode: "same" | "separate"; caption?: string; captions?: Record<string, string> }, createdBy: string,
): Promise<void> {
  const separate = d.captionMode === "separate";
  await db.query(
    `INSERT INTO post_drafts (run, post_date, key, text, status, created_by, content_item_id)
     VALUES ('pipeline', '', $1, $2, 'draft', $3, $4)`,
    [separate ? "separate" : "all", separate ? JSON.stringify(d.captions || {}) : d.caption || "", createdBy, contentItemId],
  );
}

export async function listDraftHistory(db: Db, contentItemId: string): Promise<DraftEntry[]> {
  const r = await db.query(
    `SELECT * FROM post_drafts
      WHERE content_item_id = $1 OR id = (SELECT draft_id FROM content_items WHERE id = $1)
      ORDER BY id DESC LIMIT 20`,
    [contentItemId],
  );
  return r.rows.map((row) => {
    let captions: Record<string, string> = {};
    if (row.key === "separate") { try { captions = JSON.parse(row.text); } catch { captions = {}; } }
    return {
      id: Number(row.id), at: new Date(row.created_at).toISOString(), by: row.created_by,
      origin: row.run === "pipeline" ? "claude" : "run",
      captionMode: row.key === "separate" ? "separate" : "same",
      caption: row.key === "separate" ? "" : row.text, captions,
    };
  });
}
```

- [ ] **Step 4: Rewrite `caption.ts`**

Replace the whole of `apps/social-posts/src/pipeline/caption.ts`:

```ts
// Draft with Claude. Works out the profile in force for the post (its own
// override, its recurrence's, its event's), fetches the source item that
// profile points at for the post's date, builds one prompt, and asks Claude.
// Works from the editor's state, saved or not; draftAndSave works from a
// saved post and stores the result.
import { Pool } from "pg";
import { callClaude, stripJsonFences } from "../claude";
import { getSetting } from "../settings";
import { formatMonthDayYear } from "../dates";
import { DEFAULT_PLATFORMS, PLATFORMS } from "./config";
import { countChars } from "./platforms";
import { Result } from "./rules";
import { Effective, Override, SourceRef, effectiveProfile, parseOverride, parseSourceRef } from "./drafting";
import { DEFAULT_VOICE } from "./drafting-seed";
import { SourceContent, buildDraftPrompt } from "./prompt";
import { resolveSource } from "./sources";
import { logDraft } from "./history";
import { ContentRow, getContentRow } from "./repo";

export interface DraftRequest {
  contentItemId: string | null; title: string; brief: string; phase: string; eventId: string | null;
  platforms: string[]; publishDate: string | null; captionMode: "same" | "separate";
  caption: string; captions: Record<string, string>; drafting: Override; sourceRef: SourceRef | null;
}
export interface DraftResult { caption?: string; captions?: Record<string, string>; warnings: string[]; source: SourceContent | null }

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

export function parseDraftRequest(raw: unknown, opts: { preview?: boolean } = {}): Result<DraftRequest> {
  const b = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  const known = PLATFORMS.map((p) => p.key);
  const platforms = Array.isArray(b.platforms) ? b.platforms.filter((p: unknown) => known.includes(p as string)) : [];
  const title = String(b.title ?? "").trim(), brief = String(b.brief ?? "").trim();
  if (!opts.preview && !title && !brief) return fail("Write a title or a brief first so there's something to draft from.");
  const drafting = parseOverride(b.drafting ?? {});
  if (!drafting.ok) return drafting;
  const sourceRef = parseSourceRef(b.sourceRef ?? null);
  if (!sourceRef.ok) return sourceRef;
  return { ok: true, value: {
    contentItemId: typeof b.contentItemId === "string" && b.contentItemId ? b.contentItemId : null,
    title, brief, phase: String(b.phase ?? ""), eventId: b.eventId || null,
    platforms: platforms.length ? platforms : DEFAULT_PLATFORMS,
    publishDate: typeof b.publishDate === "string" && b.publishDate ? b.publishDate : null,
    captionMode: b.captionMode === "separate" ? "separate" : "same",
    caption: String(b.caption ?? ""), captions: b.captions && typeof b.captions === "object" ? b.captions : {},
    drafting: drafting.value, sourceRef: sourceRef.value,
  } };
}

/** The profile in force and its source item. Throws if a source service fails. */
export async function resolveForDraft(pool: Pool, req: DraftRequest) {
  const ev = req.eventId
    ? (await pool.query("SELECT name, kind, notes, drafting, start_date::text, end_date::text FROM events WHERE id = $1", [req.eventId])).rows[0]
    : null;
  const rec = req.contentItemId
    ? (await pool.query(
        "SELECT r.drafting FROM content_items ci JOIN recurrences r ON r.id = ci.recurrence_id WHERE ci.id = $1", [req.contentItemId])).rows[0]
    : null;
  const effective: Effective = effectiveProfile(
    ev ? { notes: ev.notes || "", drafting: ev.drafting || {} } : null,
    rec ? { drafting: rec.drafting || {} } : null,
    { drafting: req.drafting },
  );
  const source = await resolveSource(pool, effective.source, req.sourceRef, req.publishDate);
  const event = ev ? { name: ev.name, kind: ev.kind, notes: ev.notes || "", startDate: ev.start_date, endDate: ev.end_date } : null;
  return { effective, source, event };
}

function overLimit(key: string, text: string): string {
  const p = PLATFORMS.find((x) => x.key === key)!;
  const n = countChars(key, text);
  return n > p.limit ? `${p.label} draft is ${n} characters; the limit is ${p.limit}. Trim it before sending.` : "";
}

async function shortenForX(pool: Pool, text: string): Promise<string> {
  const raw = await callClaude(pool, 'Return ONLY a JSON object with key "x", no markdown fences.',
    `Shorten this X post to at most 250 characters (links count as 23), keeping its point and any link:\n\n${text}`);
  try {
    const x = JSON.parse(stripJsonFences(raw)).x;
    return typeof x === "string" && x.trim() ? x.trim() : text;
  } catch { return text; }
}

export async function draftCaptions(pool: Pool, req: DraftRequest, createdBy: string): Promise<Result<DraftResult>> {
  let resolved;
  try { resolved = await resolveForDraft(pool, req); }
  catch (e) { return fail((e as Error).message); }
  const { effective, source, event } = resolved;
  if (effective.source.kind === "buzzsprout" && !source) return fail("Pick the episode this post is about.");

  let seriesPosition: { n: number; of: number } | null = null;
  if (event?.kind === "series" && req.contentItemId && req.eventId) {
    const ids = (await pool.query(
      "SELECT id FROM content_items WHERE event_id = $1 AND status <> 'cancelled' ORDER BY publish_date NULLS LAST, created_at",
      [req.eventId])).rows.map((r) => r.id);
    const n = ids.indexOf(req.contentItemId);
    if (n !== -1) seriesPosition = { n: n + 1, of: ids.length };
  }

  const prompt = buildDraftPrompt({
    voice: (await getSetting(pool, "house_voice")) || DEFAULT_VOICE,
    context: effective.context, instructions: effective.instructions,
    eventName: event?.name || "", eventKind: event?.kind || "",
    eventDates: event?.startDate ? formatMonthDayYear(event.startDate) + (event.endDate ? " to " + formatMonthDayYear(event.endDate) : "") : "",
    title: req.title, brief: req.brief, phase: req.phase, publishDate: req.publishDate, seriesPosition, source,
    platforms: req.platforms, captionMode: req.captionMode, caption: req.caption, captions: req.captions,
  });

  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(stripJsonFences(await callClaude(pool, prompt.system, prompt.user))); }
  catch (e) {
    const msg = (e as Error).message;
    return fail(e instanceof SyntaxError ? "Claude's reply wasn't readable. Try again." : msg);
  }

  const result: DraftResult = { warnings: [], source };
  if (prompt.keys[0] === "post") {
    let caption = typeof parsed.post === "string" ? parsed.post.trim() : "";
    if (!caption) return fail("Claude came back without a draft. Try again.");
    if (req.platforms.includes("x") && overLimit("x", caption)) caption = await shortenForX(pool, caption);
    result.caption = caption;
    result.warnings = req.platforms.map((k) => overLimit(k, caption)).filter(Boolean);
  } else {
    const captions: Record<string, string> = {};
    const missing: string[] = [];
    for (const k of prompt.keys) {
      const v = parsed[k];
      if (typeof v === "string" && v.trim()) captions[k] = v.trim();
      else missing.push(PLATFORMS.find((p) => p.key === k)!.label);
    }
    if (missing.length) return fail(`Claude didn't write the ${missing.join(" and ")} caption. Try again.`);
    if (captions.x && overLimit("x", captions.x)) captions.x = await shortenForX(pool, captions.x);
    result.captions = captions;
    result.warnings = Object.entries(captions).map(([k, v]) => overLimit(k, v)).filter(Boolean);
  }
  if (req.contentItemId) {
    await logDraft(pool, req.contentItemId, { captionMode: req.captionMode, caption: result.caption, captions: result.captions }, createdBy);
  }
  return { ok: true, value: result };
}

/** Draft a saved post and store the result: caption(s), the source it used, and Drafted. */
export async function draftAndSave(pool: Pool, id: string, createdBy: string): Promise<Result<ContentRow>> {
  const item = await getContentRow(pool, id);
  if (!item) return fail("Post not found.");
  const r = await draftCaptions(pool, {
    contentItemId: id, title: item.title, brief: item.brief, phase: item.phase, eventId: item.eventId,
    platforms: item.platforms.length ? item.platforms : DEFAULT_PLATFORMS, publishDate: item.publishDate,
    captionMode: item.captionMode, caption: item.caption, captions: item.captions,
    drafting: item.drafting, sourceRef: item.sourceRef,
  }, createdBy);
  if (!r.ok) return r;
  const s = r.value.source;
  const ref = s && s.kind !== "manual" ? { kind: s.kind, id: s.id, title: s.title, url: s.url, date: s.date } : item.sourceRef;
  await pool.query(
    `UPDATE content_items
        SET caption = COALESCE($2, caption), captions = COALESCE($3, captions), source_ref = $4,
            status = CASE WHEN status IN ('idea','planned') THEN 'drafted' ELSE status END, updated_at = now()
      WHERE id = $1`,
    [id, r.value.caption ?? null, r.value.captions ?? null, ref ?? null],
  );
  return { ok: true, value: (await getContentRow(pool, id))! };
}

/** Draft several saved posts in turn; one failing doesn't stop the rest. */
export async function draftAll(pool: Pool, ids: string[], createdBy: string): Promise<Array<{ id: string; ok: boolean; error?: string }>> {
  const out: Array<{ id: string; ok: boolean; error?: string }> = [];
  for (const id of ids) {
    const r = await draftAndSave(pool, id, createdBy);
    out.push(r.ok ? { id, ok: true } : { id, ok: false, error: r.error });
  }
  return out;
}
```

- [ ] **Step 5: Wire the routes**

In `apps/social-posts/src/routes/pipeline.ts`:

1. Change the caption import to `import { draftAll, draftCaptions, parseDraftRequest, resolveForDraft } from "../pipeline/caption";`.
2. Add `import { listDraftHistory } from "../pipeline/history";`, `import { listCampaigns } from "../mailchimp";` and `import { listEpisodes } from "../buzzsprout";`.
3. Replace the existing `/api/pipeline/draft-caption` route with:

```ts
  // Drafts from the editor's current (possibly unsaved) state; logs it when the post exists.
  app.post("/api/pipeline/draft-caption", async (req) => guard(async () => {
    const input = parseDraftRequest(req.body);
    if (!input.ok) return input;
    const r = await draftCaptions(pool, input.value, getIdentity(req).email);
    return r.ok ? { ok: true, ...r.value } : r;
  }));

  // What Draft with Claude would use, for the editor's source panel. A source
  // service failing is reported here, not raised: pasting by hand still works.
  app.post("/api/pipeline/source/preview", async (req) => guard(async () => {
    const input = parseDraftRequest(req.body, { preview: true });
    if (!input.ok) return input;
    try {
      const { effective, source } = await resolveForDraft(pool, input.value);
      const { content, ...rest } = source || ({} as Record<string, string>);
      return { ok: true, effective: { source: effective.source, instructions: effective.instructions, from: effective.from },
               source: source ? { ...rest, excerpt: (content || "").slice(0, 400) } : null };
    } catch (e) {
      return { ok: true, effective: null, source: null, error: (e as Error).message };
    }
  }));

  app.get("/api/pipeline/sources/campaigns", async (req) => guard(async () => {
    const subject = String((req.query as Query).subject || "").trim();
    if (!subject) return { ok: false, error: "Say which campaigns: text their subject contains." };
    return { ok: true, campaigns: await listCampaigns(pool, subject) };
  }));

  app.get("/api/pipeline/sources/episodes", async () => guard(async () => ({ ok: true, episodes: await listEpisodes(pool) })));

  app.get("/api/pipeline/content/:id/drafts", async (req) => guard(async () =>
    ({ ok: true, drafts: await listDraftHistory(pool, (req.params as { id: string }).id) })));

  app.post("/api/pipeline/draft-all", async (req) => guard(async () => {
    const ids = (req.body as { ids?: unknown } | null)?.ids;
    if (!Array.isArray(ids) || !ids.every((i) => typeof i === "string")) return { ok: false, error: "Say which posts to draft." };
    return { ok: true, results: await draftAll(pool, ids as string[], getIdentity(req).email) };
  }));
```

- [ ] **Step 6: Run the suite**

Run: `npx tsc -p . && TEST_DATABASE_URL=postgres://postgres:test@localhost:55432/socialposts npm test`
Expected: PASS, including the four new tests.

- [ ] **Step 7: Commit**

```bash
git add apps/social-posts/src/pipeline/history.ts apps/social-posts/src/pipeline/caption.ts apps/social-posts/src/routes/pipeline.ts apps/social-posts/src/pipeline.test.ts
git commit -m "feat(pipeline): Draft with Claude uses the post's profile and source, and keeps a history"
```

---

### Task 5: Planning: posts from an episode, and a series planned with Claude

**Files:**
- Create: `apps/social-posts/src/pipeline/planning.ts`
- Modify: `apps/social-posts/src/routes/pipeline.ts`
- Test: `apps/social-posts/src/pipeline.test.ts` (append)

**Interfaces:**
- Consumes: `createContent` (`repo.ts`, with `drafting`, `sourceRef` and `phase` from Task 1); `getEpisode` (`buzzsprout.ts`); `SERIES_PLAN_PROMPT` (Task 2); `callClaude`, `stripJsonFences`; `isIsoDate` (`rules.ts`); `addDays` (`dates.ts`).
- Produces:
  - `planFromEpisode(pool, eventId: string, episodeId: string, angleKeys: string[], createdBy: string, today: string): Promise<Result<ContentRow[]>>`
  - `PlannedPost { date: string; phase: string; title: string; sub: string }`
  - `proposeSeriesPlan(pool, eventId: string, params: { count: number; cadence: string; startDate: string }): Promise<Result<PlannedPost[]>>`
  - `saveSeriesPlan(pool, eventId: string, posts: PlannedPost[], createdBy: string): Promise<Result<ContentRow[]>>`
  - Routes:
    - `POST /api/pipeline/events/:id/plan-episode` (body `{ episodeId, angles }`) returns `{ ok, items }`.
    - `POST /api/pipeline/events/:id/plan-series/propose` (body `{ count, cadence, startDate }`) returns `{ ok, posts }`.
    - `POST /api/pipeline/events/:id/plan-series` (body `{ posts }`) returns `{ ok, items }`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/social-posts/src/pipeline.test.ts`:

```ts
test("planning from an episode makes one pinned post per angle, on its offset day", async () => {
  const { planFromEpisode } = await import("./pipeline/planning");
  const { PODCAST_PROFILE } = await import("./pipeline/drafting-seed");
  const ev = await createEvent(pool, { name: "Pod plan", kind: "series" });
  await updateEvent(pool, ev.id, { drafting: PODCAST_PROFILE });
  await pool.query(`INSERT INTO settings (key, value) VALUES ('buzzsprout_api_token','t'), ('buzzsprout_podcast_id','77')
                    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
  const episode = (id: number, published_at: string) => ({ id, title: "Too small or too big?", description: "<p>Notes</p>", custom_url: null,
    published_at, duration: 1920, episode_number: 4, season_number: 1, private: false });
  const f = stubFetch([[/buzzsprout\.com\/api\/77\/episodes\/(\d+)\.json/, (u) => /episodes\/9\./.test(u) ? episode(9, "2026-11-01T10:00:00Z") : episode(10, "")]]);
  try {
    const r = await planFromEpisode(pool, ev.id, "9", ["announcement", "quote"], "me@x.org", REF);
    assert.ok(r.ok);
    assert.deepEqual(r.value.map((i) => [i.title, i.publishDate]), [
      ["Announcement: Too small or too big?", "2026-11-01"], ["Pull quote: Too small or too big?", "2026-11-05"],
    ]);
    assert.equal(r.value[1].drafting.instructions, PODCAST_PROFILE.angles!.find((a) => a.key === "quote")!.instructions);
    assert.deepEqual([r.value[0].sourceRef?.kind, r.value[0].sourceRef?.id], ["buzzsprout", "9"]);

    const undated = await planFromEpisode(pool, ev.id, "10", ["guest"], "me@x.org", REF);
    assert.ok(undated.ok);
    assert.equal(undated.value[0].publishDate, "2026-11-02", "no episode date: today + offset");

    assert.ok(!(await planFromEpisode(pool, ev.id, "9", [], "me@x.org", REF)).ok, "needs an angle");
    const plain = await createEvent(pool, { name: "No source" });
    const wrong = await planFromEpisode(pool, plain.id, "9", ["announcement"], "me@x.org", REF);
    assert.ok(!wrong.ok);
    assert.match(wrong.error, /source isn't Buzzsprout/);
  } finally {
    f.restore();
    await pool.query("DELETE FROM settings WHERE key IN ('buzzsprout_api_token','buzzsprout_podcast_id')");
  }
});

test("a series is planned with Claude, edited, then saved as posts", async () => {
  const { proposeSeriesPlan, saveSeriesPlan } = await import("./pipeline/planning");
  const ev = await createEvent(pool, { name: "Advent 2026", kind: "series", notes: "Four weeks of hope." });
  await pool.query("INSERT INTO settings (key, value) VALUES ('anthropic_api_key','t') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value");
  let prompt = "";
  const f = stubFetch([[/api\.anthropic\.com/, (_u, init) => {
    prompt = JSON.parse(init.body).messages[0].content;
    return { content: [{ text: JSON.stringify([
      { date: "2026-11-29", phase: "Waiting", title: "Hope", sub: "Light the first candle." },
      { date: "Dec 6", phase: "", title: "Peace", sub: "Second candle." },
    ]) }] };
  }]]);
  try {
    const p = await proposeSeriesPlan(pool, ev.id, { count: 2, cadence: "weekly", startDate: "2026-11-29" });
    assert.ok(p.ok);
    assert.match(prompt, /Generate a post schedule for a social media series called "Advent 2026"/);
    assert.match(prompt, /Context: Four weeks of hope\./);
    assert.deepEqual(p.value.map((x) => x.date), ["2026-11-29", ""], "a date Claude didn't format is left for the person to fill");
    assert.ok(!(await saveSeriesPlan(pool, ev.id, p.value, "me@x.org")).ok, "every post needs a date before saving");
    const saved = await saveSeriesPlan(pool, ev.id, [p.value[0], { ...p.value[1], date: "2026-12-06" }], "me@x.org");
    assert.ok(saved.ok);
    assert.deepEqual(saved.value.map((i) => [i.title, i.publishDate, i.brief, i.phase, i.eventId]), [
      ["Hope", "2026-11-29", "Light the first candle.", "Waiting", ev.id],
      ["Peace", "2026-12-06", "Second candle.", "", ev.id],
    ]);
  } finally { f.restore(); await pool.query("DELETE FROM settings WHERE key = 'anthropic_api_key'"); }
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx tsc -p .`
Expected: FAIL. `Cannot find module './pipeline/planning'`.

- [ ] **Step 3: Create `planning.ts`**

Create `apps/social-posts/src/pipeline/planning.ts`:

```ts
// Turning one thing into several posts: an episode into one post per angle
// (what the Podcast run did), and a series into a plan Claude proposes and a
// person edits (what the Series tab's "Generate post plan" did).
import { Pool } from "pg";
import { addDays } from "../dates";
import { getEpisode } from "../buzzsprout";
import { callClaude, stripJsonFences } from "../claude";
import { DEFAULT_PLATFORMS } from "./config";
import { SERIES_PLAN_PROMPT } from "./drafting-seed";
import { ContentRow, createContent } from "./repo";
import { Result, isIsoDate } from "./rules";

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

export async function planFromEpisode(
  pool: Pool, eventId: string, episodeId: string, angleKeys: string[], createdBy: string, today: string,
): Promise<Result<ContentRow[]>> {
  const ev = (await pool.query("SELECT drafting FROM events WHERE id = $1", [eventId])).rows[0];
  if (!ev) return fail("Event not found.");
  if (ev.drafting?.source?.kind !== "buzzsprout") return fail("This event's source isn't Buzzsprout, so there are no episodes to plan from.");
  const angles = (ev.drafting.angles || []).filter((a: { key: string }) => angleKeys.includes(a.key));
  if (!angles.length) return fail("Pick at least one angle.");
  const ep = await getEpisode(pool, episodeId);
  const base = ep.publishDate || today;
  const items: ContentRow[] = [];
  for (const a of angles) {
    const r = await createContent(pool, {
      title: `${a.label}: ${ep.title}`, eventId, publishDate: addDays(base, a.offsetDays), platforms: DEFAULT_PLATFORMS,
      drafting: { instructions: a.instructions },
      sourceRef: { kind: "buzzsprout", id: String(ep.id), title: ep.title, url: ep.listenUrl, date: ep.publishDate },
    }, createdBy);
    if (!r.ok) return r;
    items.push(r.value);
  }
  return { ok: true, value: items };
}

export interface PlannedPost { date: string; phase: string; title: string; sub: string }

export async function proposeSeriesPlan(
  pool: Pool, eventId: string, params: { count: number; cadence: string; startDate: string },
): Promise<Result<PlannedPost[]>> {
  const ev = (await pool.query("SELECT name, notes FROM events WHERE id = $1", [eventId])).rows[0];
  if (!ev) return fail("Event not found.");
  if (!Number.isInteger(params.count) || params.count < 1 || params.count > 52) return fail("Plan between 1 and 52 posts.");
  const sys = "You are a social media content strategist for Grace Resurrection Methodist Church (GRMC) in Marietta, GA.";
  const lines = SERIES_PLAN_PROMPT({ name: ev.name, description: "", context: ev.notes || "", count: params.count,
    cadence: params.cadence || "weekly", startDate: params.startDate || "" });
  let rows: unknown;
  try { rows = JSON.parse(stripJsonFences(await callClaude(pool, sys, lines.join("\n")))); }
  catch (e) { return fail(e instanceof SyntaxError ? "Claude's plan wasn't readable. Try again." : (e as Error).message); }
  if (!Array.isArray(rows)) return fail("Claude's plan wasn't a list. Try again.");
  const posts = rows.map((r: any) => ({
    date: isIsoDate(r?.date) ? r.date : "", phase: String(r?.phase ?? ""), title: String(r?.title ?? "").trim(), sub: String(r?.sub ?? ""),
  })).filter((p) => p.title);
  return posts.length ? { ok: true, value: posts } : fail("Claude's plan had no posts. Try again.");
}

export async function saveSeriesPlan(pool: Pool, eventId: string, posts: PlannedPost[], createdBy: string): Promise<Result<ContentRow[]>> {
  const bad = posts.findIndex((p) => !String(p.title || "").trim() || !isIsoDate(p.date));
  if (bad !== -1) return fail(`Post ${bad + 1} needs a title and a date.`);
  const items: ContentRow[] = [];
  for (const p of posts) {
    const r = await createContent(pool, { title: p.title.trim(), publishDate: p.date, brief: p.sub || "", phase: p.phase || "", eventId }, createdBy);
    if (!r.ok) return r;
    items.push(r.value);
  }
  return { ok: true, value: items };
}
```

- [ ] **Step 4: Add the routes**

In `apps/social-posts/src/routes/pipeline.ts`, add `import { planFromEpisode, proposeSeriesPlan, saveSeriesPlan } from "../pipeline/planning";`, and next to the duplicate-event route add:

```ts
  app.post("/api/pipeline/events/:id/plan-episode", async (req) => guard(async () => {
    const b = (req.body ?? {}) as { episodeId?: string | number; angles?: unknown };
    if (!b.episodeId) return { ok: false, error: "Pick an episode." };
    const angles = Array.isArray(b.angles) ? b.angles.map(String) : [];
    const r = await planFromEpisode(pool, (req.params as { id: string }).id, String(b.episodeId), angles,
      getIdentity(req).email, await referenceDate(pool));
    return r.ok ? { ok: true, items: r.value } : r;
  }));

  app.post("/api/pipeline/events/:id/plan-series/propose", async (req) => guard(async () => {
    const b = (req.body ?? {}) as { count?: number; cadence?: string; startDate?: string };
    const r = await proposeSeriesPlan(pool, (req.params as { id: string }).id,
      { count: Number(b.count), cadence: String(b.cadence || "weekly"), startDate: String(b.startDate || "") });
    return r.ok ? { ok: true, posts: r.value } : r;
  }));

  app.post("/api/pipeline/events/:id/plan-series", async (req) => guard(async () => {
    const posts = (req.body as { posts?: unknown } | null)?.posts;
    if (!Array.isArray(posts)) return { ok: false, error: "There's no plan to save." };
    const r = await saveSeriesPlan(pool, (req.params as { id: string }).id, posts as any[], getIdentity(req).email);
    return r.ok ? { ok: true, items: r.value } : r;
  }));
```

- [ ] **Step 5: Run the suite**

Run: `npx tsc -p . && TEST_DATABASE_URL=postgres://postgres:test@localhost:55432/socialposts npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/social-posts/src/pipeline/planning.ts apps/social-posts/src/routes/pipeline.ts apps/social-posts/src/pipeline.test.ts
git commit -m "feat(pipeline): plan posts from an episode, and plan a series with Claude"
```

---

### Task 6: One-time migration: run profiles, Sunday worship, series context

**Files:**
- Create: `apps/social-posts/src/pipeline/migrate-drafting.ts`
- Modify: `apps/social-posts/src/pipeline/config.ts`, `src/pipeline/sync.ts` (`ensureRunEvents`), `src/pipeline/recurring.ts` (`seedRunRecurrences`), `src/index.ts`
- Test: `apps/social-posts/src/pipeline.test.ts` (append; update the existing seeding test)

**Interfaces:**
- Consumes: `GRACE_NOTES_PROFILE`, `SUNDAY_PROFILE`, `BLOG_PROFILE`, `PODCAST_PROFILE`, `SERIES_INSTRUCTIONS`, `DEFAULT_VOICE` (Task 2); `ensureRunEvents` (`sync.ts`).
- Produces:
  - `RUN_EVENTS` gains `sunday: { id: "run-sunday", name: "Sunday worship", color: "#3f6b2e", kind: "department" }`, and every entry gains `kind`. `wednesday` is renamed to `"Grace Notes"`.
  - `DRAFTING_SETTING = "pipeline_drafting_v1"`
  - `migrateDrafting(pool: Pool, today: string): Promise<{ ran: boolean; movedOccurrences: number }>`

- [ ] **Step 1: Write the failing test**

Append to `apps/social-posts/src/pipeline.test.ts`, and add `RUN_EVENTS` to its imports if it isn't there:

```ts
test("the drafting migration seeds run profiles, splits out Sunday worship, and runs once", async () => {
  const { migrateDrafting, DRAFTING_SETTING } = await import("./pipeline/migrate-drafting");
  const { GRACE_NOTES_PROFILE, SUNDAY_PROFILE, SERIES_INSTRUCTIONS } = await import("./pipeline/drafting-seed");
  // Rebuild the pre-migration state: run profiles empty, the Saturday invite under Grace Notes.
  await pool.query("DELETE FROM settings WHERE key IN ($1, 'house_voice')", [DRAFTING_SETTING]);
  await pool.query("UPDATE events SET drafting = '{}', name = 'Grace Notes & Sunday invite' WHERE id = 'run-wednesday'");
  await pool.query("UPDATE events SET drafting = '{}' WHERE id LIKE 'run-%'");
  const sat = (await pool.query("SELECT id FROM recurrences WHERE draft_key = 'saturday'")).rows[0].id;
  await pool.query("UPDATE recurrences SET event_id = 'run-wednesday' WHERE id = $1", [sat]);
  await pool.query("UPDATE content_items SET event_id = 'run-wednesday' WHERE recurrence_id = $1", [sat]);
  const drafted = (await occ(sat))[0];
  await pool.query("UPDATE content_items SET status = 'drafted' WHERE id = $1", [drafted.id]);
  await pool.query(`INSERT INTO series (id, name, context) VALUES ('s-mig', 'Lent', 'Forty days of prayer.') ON CONFLICT DO NOTHING`);
  const lent = await pool.query(`INSERT INTO events (name, kind, series_id, notes) VALUES ('Lent', 'series', 's-mig', 'Ashes to Easter.') RETURNING id`);

  const r = await migrateDrafting(pool, REF);
  assert.equal(r.ran, true);
  const gn = (await pool.query("SELECT name, drafting FROM events WHERE id = 'run-wednesday'")).rows[0];
  assert.equal(gn.name, "Grace Notes");
  assert.deepEqual(gn.drafting, GRACE_NOTES_PROFILE);
  assert.deepEqual((await pool.query("SELECT drafting FROM events WHERE id = 'run-sunday'")).rows[0].drafting, SUNDAY_PROFILE);
  assert.equal((await pool.query("SELECT event_id FROM recurrences WHERE id = $1", [sat])).rows[0].event_id, "run-sunday");
  const after = await occ(sat);
  assert.equal(after.find((x) => x.id === drafted.id)!.event_id, "run-wednesday", "a drafted Saturday post stays put");
  assert.ok(after.filter((x) => x.id !== drafted.id).every((x) => x.event_id === "run-sunday"), "untouched ones move");
  const lentNow = (await pool.query("SELECT notes, drafting FROM events WHERE id = $1", [lent.rows[0].id])).rows[0];
  assert.equal(lentNow.notes, "Ashes to Easter.\n\nForty days of prayer.");
  assert.equal(lentNow.drafting.instructions, SERIES_INSTRUCTIONS);
  assert.ok((await pool.query("SELECT value FROM settings WHERE key = 'house_voice'")).rows[0].value.startsWith("GRMC voice rules"));

  assert.equal((await migrateDrafting(pool, REF)).ran, false, "once only");
});
```

In the existing test `"weekly runs become recurrences and fill their own slots"`, the Saturday seed now lands under `run-sunday`. Task 7 rewrites that test; for now, add this line at its end: `assert.equal((await pool.query("SELECT event_id FROM recurrences WHERE draft_key = 'saturday'")).rows[0].event_id, "run-sunday");`

- [ ] **Step 2: Run it to verify it fails**

Run: `npx tsc -p .`
Expected: FAIL. `Cannot find module './pipeline/migrate-drafting'`.

- [ ] **Step 3: Add Sunday worship to the run events**

In `apps/social-posts/src/pipeline/config.ts`, replace `RUN_EVENTS`:

```ts
// The standing events the weekly runs became. Fixed ids so code can find them;
// names and profiles are editable like any other event.
export const RUN_EVENTS: Record<string, { id: string; name: string; color: string; kind: "series" | "department" }> = {
  wednesday: { id: "run-wednesday", name: "Grace Notes", color: "#534AB7", kind: "series" },
  sunday: { id: "run-sunday", name: "Sunday worship", color: "#3f6b2e", kind: "department" },
  friday: { id: "run-friday", name: "Weekly blog", color: "#0F6C6C", kind: "series" },
  podcast: { id: "run-podcast", name: "Podcast", color: "#7A2E86", kind: "series" },
};
```

In `apps/social-posts/src/pipeline/sync.ts`, `ensureRunEvents` inserts the kind:

```ts
export async function ensureRunEvents(db: Db): Promise<void> {
  for (const run of Object.values(RUN_EVENTS)) {
    await db.query(
      `INSERT INTO events (id, name, kind, color) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING`,
      [run.id, run.name, run.kind, run.color],
    );
  }
}
```

In `apps/social-posts/src/pipeline/recurring.ts`, change the Saturday entry in `seedRunRecurrences` to `{ run: "sunday", key: "saturday", title: "Sunday invite & preview", weekday: 6 }`.

- [ ] **Step 4: Create the migration**

Create `apps/social-posts/src/pipeline/migrate-drafting.ts`:

```ts
// Once per database: the weekly runs become drafting profiles carrying their
// prompts word for word, the Saturday invite moves to its own Sunday worship
// event, and each series' Claude context joins its event's notes. Touches no
// post's date, status or caption.
import { Pool } from "pg";
import { RUN_EVENTS } from "./config";
import { ensureRunEvents } from "./sync";
import {
  BLOG_PROFILE, DEFAULT_VOICE, GRACE_NOTES_PROFILE, PODCAST_PROFILE, SERIES_INSTRUCTIONS, SUNDAY_PROFILE,
} from "./drafting-seed";

export const DRAFTING_SETTING = "pipeline_drafting_v1";

export async function migrateDrafting(pool: Pool, today: string): Promise<{ ran: boolean; movedOccurrences: number }> {
  const done = await pool.query("SELECT 1 FROM settings WHERE key = $1", [DRAFTING_SETTING]);
  if (done.rowCount) return { ran: false, movedOccurrences: 0 };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO settings (key, value) VALUES ('house_voice', $1) ON CONFLICT (key) DO NOTHING", [DEFAULT_VOICE]);
    await ensureRunEvents(client);
    await client.query(
      "UPDATE events SET name = 'Grace Notes' WHERE id = $1 AND name = 'Grace Notes & Sunday invite'", [RUN_EVENTS.wednesday.id]);
    const seeds: Array<[string, object]> = [
      [RUN_EVENTS.wednesday.id, GRACE_NOTES_PROFILE], [RUN_EVENTS.sunday.id, SUNDAY_PROFILE],
      [RUN_EVENTS.friday.id, BLOG_PROFILE], [RUN_EVENTS.podcast.id, PODCAST_PROFILE],
    ];
    for (const [id, profile] of seeds) {
      await client.query("UPDATE events SET drafting = $2 WHERE id = $1 AND drafting = '{}'::jsonb", [id, profile]);
    }

    // The Saturday invite, and its upcoming posts nobody has started on.
    let moved = 0;
    const sat = await client.query(
      "UPDATE recurrences SET event_id = $1 WHERE draft_key = 'saturday' AND event_id = $2 RETURNING id",
      [RUN_EVENTS.sunday.id, RUN_EVENTS.wednesday.id]);
    for (const r of sat.rows) {
      const m = await client.query(
        `UPDATE content_items SET event_id = $1
          WHERE recurrence_id = $2 AND occurrence_date >= $3 AND NOT detached AND status IN ('idea','planned')`,
        [RUN_EVENTS.sunday.id, r.id, today]);
      moved += m.rowCount || 0;
    }

    // Series context joins the event's notes; series get the series instructions.
    const series = await client.query(
      "SELECT e.id, e.notes, e.drafting, s.context FROM events e JOIN series s ON s.id = e.series_id");
    for (const row of series.rows) {
      const context = (row.context || "").trim();
      const notes = context && !(row.notes || "").includes(context)
        ? [row.notes, context].filter((x: string) => x && x.trim()).join("\n\n") : row.notes;
      const drafting = row.drafting?.instructions ? row.drafting : { ...(row.drafting || {}), instructions: SERIES_INSTRUCTIONS };
      await client.query("UPDATE events SET notes = $2, drafting = $3 WHERE id = $1", [row.id, notes || "", drafting]);
    }

    await client.query("INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now())", [DRAFTING_SETTING, new Date().toISOString()]);
    await client.query("COMMIT");
    return { ran: true, movedOccurrences: moved };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
```

- [ ] **Step 5: Run it on boot**

In `apps/social-posts/src/index.ts`, add `import { migrateDrafting } from "./pipeline/migrate-drafting";`, and after the `IMAGE_RULE_SETTING` block add:

```ts
  const drafting = await migrateDrafting(pool, await referenceDate(pool));
  if (drafting.ran) app.log.info(drafting, "weekly runs set up as drafting profiles");
```

- [ ] **Step 6: Run the suite**

Run: `npx tsc -p . && TEST_DATABASE_URL=postgres://postgres:test@localhost:55432/socialposts npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/social-posts/src/pipeline/migrate-drafting.ts apps/social-posts/src/pipeline/config.ts apps/social-posts/src/pipeline/sync.ts apps/social-posts/src/pipeline/recurring.ts apps/social-posts/src/index.ts apps/social-posts/src/pipeline.test.ts
git commit -m "feat(pipeline): migrate the weekly runs into drafting profiles"
```

---

### Task 7: Remove the old page, the runs and the series code (server side)

**Files:**
- Delete: `apps/social-posts/src/runs.ts`, `runs.test.ts`, `series.ts`, `series.test.ts`, `voice.ts`, `podcast-angles.ts`, `podcast-angles.test.ts`, `schedule.test.ts`, `drafts.ts`, `routes/drafts.ts`, `routes/series.ts`, `routes/mailchimp.ts`
- Modify: `src/index.ts`, `src/routes/podcast.ts`, `src/routes/pipeline.ts`, `src/schedule.ts`, `src/mailchimp.ts`, `src/dates.ts`, `src/dates.test.ts`, `src/pipeline/sync.ts`, `src/pipeline/repo.ts`, `src/pipeline/rules.ts`, `src/pipeline-rules.test.ts`, `src/pipeline.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - Removed (do not reference after this task): `draftWedPosts`, `draftFridayPost`, `draftPodcastPosts`, every export of `series.ts`, `VOICE`, `ANGLES`, `selectAngles`, `savePostDrafts`, `getRecentDrafts`, `scheduleDatesFor`, `podcastScheduleDates`, `draftScheduleDate`, `getLatestGraceNotes`, `getLatestBlog`, `CampaignContent`, `writeBackToSeries`, `pipelineStatusToSeries`, `syncSeriesMeta`, `applySeriesField`, `recordRunDrafts`.
  - `GET /pipeline` now answers with a 301 to `/`.

- [ ] **Step 1: Rewrite the tests that used removed code**

In `apps/social-posts/src/pipeline.test.ts`:

1. Delete these tests:
   - `"the Series tab reads from, and writes through to, the content item"`
   - `"a new series lands in the pipeline straight away"`
   - `"automated runs land as Drafted items and re-runs refresh instead of duplicating"`
2. Replace `"weekly runs become recurrences and fill their own slots"` with:

```ts
test("weekly runs are recurring posts in their own events", async () => {
  // This test seeds them; later tests (the image rule, the migration) rely on it.
  assert.equal(await seedRunRecurrences(pool, REF), 3);
  assert.equal(await seedRunRecurrences(pool, REF), 0, "seeded once");
  const recs = (await pool.query("SELECT draft_key, event_id FROM recurrences WHERE draft_key <> '' ORDER BY draft_key")).rows;
  assert.deepEqual(recs, [
    { draft_key: "friday", event_id: "run-friday" },
    { draft_key: "saturday", event_id: "run-sunday" },
    { draft_key: "wednesday", event_id: "run-wednesday" },
  ]);
});

test("a Metricool send marks the post Scheduled at the booked time", async () => {
  const p = await createContent(pool, { title: "Send me", publishDate: "2026-11-04", platforms: ["facebook"] }, "me@x.org");
  assert.ok(p.ok);
  await markSentToMetricool(pool, p.value.id, "2026-11-04T10:30:00");
  const after = await getContent(pool, p.value.id);
  assert.ok(after.ok);
  assert.equal(after.value.item.status, "scheduled");
  assert.equal(after.value.item.publishTime, "10:30");
});
```

3. Fix the imports. Remove `savePostDrafts` and the whole `./series` import, and remove `recordRunDrafts` from the `./pipeline/sync` import (`BACKFILL_SETTING`, `backfillOnce` and `markSentToMetricool` stay). The backfill test is unchanged: it writes `series` and `series_posts` with SQL and only calls `backfillOnce`.

In `apps/social-posts/src/pipeline-rules.test.ts`, replace the `"legacy series statuses map both ways"` test with:

```ts
test("legacy series statuses map onto pipeline statuses", () => {
  assert.equal(seriesStatusToPipeline("pending"), "idea");
  assert.equal(seriesStatusToPipeline("drafted"), "drafted");
  assert.equal(seriesStatusToPipeline("posted"), "published");
  assert.equal(seriesStatusToPipeline("weird"), "idea");
});
```

Then remove `pipelineStatusToSeries` from its import list.

In `apps/social-posts/src/dates.test.ts`, delete the test `"draftScheduleDate falls back to the stored post date for non-weekday keys"` and remove `draftScheduleDate` from the import.

- [ ] **Step 2: Delete the files**

```bash
cd apps/social-posts/src
git rm runs.ts runs.test.ts series.ts series.test.ts voice.ts podcast-angles.ts podcast-angles.test.ts schedule.test.ts drafts.ts routes/drafts.ts routes/series.ts routes/mailchimp.ts
```

- [ ] **Step 3: Remove the dead code from the files that stay**

- `src/schedule.ts`: delete `scheduleDatesFor` and `podcastScheduleDates`, plus the now-unused imports (`addDays`, `isWeekday`, `suggestDate`). Keep `referenceDate`.
- `src/dates.ts`: delete `draftScheduleDate` and the comment above it.
- `src/mailchimp.ts`: delete `getLatestCampaign`, `getLatestGraceNotes`, `getLatestBlog` and the `CampaignContent` interface. `listCampaigns`, `getCampaignText` and the pure helpers stay.
- `src/routes/podcast.ts`: delete the `/api/podcast/angles` and `/api/draft/podcast` routes and their imports (`ANGLES`, `draftPodcastPosts`, `getIdentity`). Keep `/api/podcast/podcasts` and `/api/podcast/episodes`.
- `src/routes/pipeline.ts`: delete the line `app.get("/pipeline", async (_req, reply) => reply.sendFile("pipeline.html"));`.
- `src/pipeline/sync.ts`: delete `syncSeriesMeta`, `applySeriesField`, `OPEN_FOR_REDRAFT` and `recordRunDrafts`. In `markSentToMetricool`, delete the last two lines (`const item = …` and the `writeBackToSeries` call). Trim the imports to what's still used: `getSetting`, `suggestDate`, `DEFAULT_PLATFORMS`, `RUN_EVENTS`, `nextEventColor` and `seriesStatusToPipeline`.
- `src/pipeline/repo.ts`: delete `writeBackToSeries` and its call in `updateContent`, and remove `pipelineStatusToSeries` from the `./rules` import.
- `src/pipeline/rules.ts`: delete `pipelineStatusToSeries`.

- [ ] **Step 4: Unregister the old routes and redirect `/pipeline`**

In `apps/social-posts/src/index.ts`:
1. Delete the imports and `app.register` lines for `mailchimpRoutes`, `seriesRoutes` and `draftsRoutes`.
2. After `app.register(pipelineRoutes);`, add:

```ts
// The pipeline is the app now; old bookmarks to /pipeline land on it.
app.get("/pipeline", async (_req, reply) => reply.redirect("/", 301));
```

- [ ] **Step 5: Run the suite and check nothing references removed code**

Run: `npx tsc -p . && TEST_DATABASE_URL=postgres://postgres:test@localhost:55432/socialposts npm test`
Expected: PASS.

Run: `grep -rnE "runs\"|series\"|from \"\./voice|podcast-angles|savePostDrafts|getRecentDrafts|draftScheduleDate|getLatestGraceNotes|getLatestBlog|writeBackToSeries|pipelineStatusToSeries|recordRunDrafts" apps/social-posts/src`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add -A apps/social-posts/src
git commit -m "refactor(social-posts): remove the run, series and drafts code the pipeline replaces"
```

---
### Task 8: The pipeline is the page; Settings moves in (with the house voice)

**Files:**
- Delete: `apps/social-posts/src/public/index.html` (the old page), `public/app.js`, `public/app.css`
- Rename: `apps/social-posts/src/public/pipeline.html` to `public/index.html`
- Modify: `apps/social-posts/src/public/pipeline.js`, `public/pipeline.css`, `src/settings.ts`, `src/routes/settings.ts`
- Test: `apps/social-posts/src/settings.test.ts` (append), plus a browser check (Step 7)

**Interfaces:**
- Consumes: `GET`/`POST /api/settings`, `GET /api/metricool/brands`, `GET /api/podcast/podcasts`; `DEFAULT_VOICE` (Task 2).
- Produces:
  - `SettingsView.houseVoice: string`
  - `POST /api/settings` accepts `houseVoice`
  - Client: the `#settings` view, `renderSettings(main)`, and the `data-form="settings"` submit handler.

- [ ] **Step 1: Write the failing settings test**

Append to `apps/social-posts/src/settings.test.ts`:

```ts
test("the house voice has a default and can be replaced", async () => {
  const p = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  try {
    await p.query("DELETE FROM settings WHERE key = 'house_voice'");
    assert.match((await getSettingsView(p)).houseVoice, /^GRMC voice rules/, "the original rules until someone edits them");
    await setSetting(p, "house_voice", "Be brief.");
    assert.equal((await getSettingsView(p)).houseVoice, "Be brief.");
  } finally {
    await p.query("DELETE FROM settings WHERE key = 'house_voice'");
    await p.end();
  }
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/social-posts && npx tsc -p .`
Expected: FAIL. `Property 'houseVoice' does not exist on type 'SettingsView'`.

- [ ] **Step 3: Add the house voice to settings**

In `apps/social-posts/src/settings.ts`:
1. Add `import { DEFAULT_VOICE } from "./pipeline/drafting-seed";`
2. Add `houseVoice: string;` to `SettingsView`.
3. In `getSettingsView`'s returned object, add `houseVoice: (await getSetting(pool, "house_voice")) || DEFAULT_VOICE,`.

In `apps/social-posts/src/routes/settings.ts`:
1. Add `houseVoice?: string;` to `SaveBody`.
2. In the POST handler, before `return { ok: true };`, add:

```ts
      if (s.houseVoice && s.houseVoice.trim())
        await setSetting(pool, "house_voice", s.houseVoice.trim());
```

Run: `npx tsc -p . && TEST_DATABASE_URL=postgres://postgres:test@localhost:55432/socialposts npm test`
Expected: PASS.

- [ ] **Step 4: Make the pipeline the page**

```bash
cd apps/social-posts/src/public
git rm index.html app.js app.css
git mv pipeline.html index.html
```

In the new `index.html`:
1. Change `<title>` to `GRMC Social Posts` and the header `<h1>` to `Social Posts`.
2. Delete the `<a class="btn-hdr" href="/">Social Posts</a>` line, since the page is the app now.
3. After the `#mine` tab, add `<a class="tab" href="#settings" data-view="settings">Settings</a>`.

- [ ] **Step 5: Add the Settings view**

In `apps/social-posts/src/public/pipeline.js`, add `settings: renderSettings` to the `views` object in `render()`. Then add these functions before `// ── One delegated handler`:

```js
// ── Settings ─────────────────────────────────────────────────────────────────
// Keys never come back from the server: a blank key box means "keep the saved one".
function renderSettings(main) {
  return api('GET', '/api/settings').then(function(s){
    var keyHint = function(has, what){ return '<div class="hint">' + (has ? esc(what) + ' is set. Leave blank to keep it.' : 'Not set yet.') + '</div>'; };
    main.innerHTML = '<form class="pl-settings" data-form="settings">'
      + '<section class="card"><h3 class="ct">Drafting</h3>'
      +   '<div class="field"><label for="st-voice">House voice</label><textarea id="st-voice" name="houseVoice" class="pl-voice">'+esc(s.houseVoice)+'</textarea>'
      +   '<div class="hint">Every draft follows these rules, whatever the event.</div></div>'
      +   '<div class="field"><label for="st-ak">Anthropic API key</label><input id="st-ak" type="text" name="anthropicKey" autocomplete="off" placeholder="sk-ant-…">'
      +   '<div class="hint">'+(s.hasAnthropicKey ? 'Current: '+esc(s.anthropicKeyHint)+'. Leave blank to keep it.' : 'Not set yet. Draft with Claude needs it.')+'</div></div></section>'
      + '<section class="card"><h3 class="ct">Mailchimp</h3><div class="row2">'
      +   '<div class="field"><label for="st-mk">API key</label><input id="st-mk" type="text" name="mailchimpKey" autocomplete="off" placeholder="xxxxxxxx-us21">'+keyHint(s.hasMailchimp, 'A key')+'</div>'
      +   '<div class="field"><label for="st-ms">Server prefix</label><input id="st-ms" type="text" name="mailchimpServer" value="'+esc(s.mailchimpServer)+'" placeholder="us21"></div></div></section>'
      + '<section class="card"><h3 class="ct">Podcast (Buzzsprout)</h3>'
      +   '<div class="field"><label for="st-bz">API token</label><input id="st-bz" type="text" name="buzzsproutToken" autocomplete="off" placeholder="From Profile → API in Buzzsprout">'
      +   '<div class="hint">'+(s.hasBuzzsprout ? 'Connected' + (s.buzzsproutPodcastName ? ' to '+esc(s.buzzsproutPodcastName) : '') + '.' : 'Not connected.')+'</div></div>'
      +   '<div class="field"><label for="st-bzp">Podcast</label><div class="pl-copyrow"><input id="st-bzp" type="text" name="buzzsproutPodcastId" value="'+esc(s.buzzsproutPodcastId)+'" placeholder="Podcast ID">'
      +   '<input type="hidden" name="buzzsproutPodcastName" value="'+esc(s.buzzsproutPodcastName)+'">'
      +   '<button class="btn-sm" type="button" data-act="load-podcasts">Load podcasts</button></div><select id="st-bz-list" hidden></select>'
      +   '<div class="hint">Save the token first, then load the podcasts on the account.</div></div></section>'
      + '<section class="card"><h3 class="ct">Metricool</h3>'
      +   '<div class="field"><label for="st-mc">API token</label><input id="st-mc" type="text" name="metricoolToken" autocomplete="off">'+keyHint(s.hasMetricool, 'A token')+'</div>'
      +   '<div class="row2"><div class="field"><label for="st-mcu">User ID</label><input id="st-mcu" type="text" name="metricoolUserId" value="'+esc(s.metricoolUserId)+'"></div>'
      +   '<div class="field"><label for="st-mcb">Brand</label><div class="pl-copyrow"><input id="st-mcb" type="text" name="metricoolBlogId" value="'+esc(s.metricoolBlogId)+'" placeholder="Blog / brand ID">'
      +   '<button class="btn-sm" type="button" data-act="load-brands">Load brands</button></div><select id="st-mc-list" hidden></select></div></div>'
      +   '<div class="row2"><div class="field"><label for="st-time">Default post time</label><input id="st-time" type="time" name="defaultPostTime" value="'+esc(s.defaultPostTime)+'"></div>'
      +   '<div class="field"><label for="st-tz">Timezone</label><input id="st-tz" type="text" name="defaultTimezone" value="'+esc(s.defaultTimezone)+'" placeholder="America/New_York"></div></div></section>'
      + '<section class="card"><h3 class="ct">Image hosting (R2)</h3>'
      +   '<div class="hint pl-under">'+(s.hasR2 ? 'Configured. Fill a box only to change it.' : 'Needed to send uploaded or approved images to Metricool.')+'</div>'
      +   '<div class="row2"><div class="field"><label for="st-r2a">Account ID</label><input id="st-r2a" type="text" name="r2AccountId" autocomplete="off"></div>'
      +   '<div class="field"><label for="st-r2k">Access key ID</label><input id="st-r2k" type="text" name="r2AccessKeyId" autocomplete="off"></div></div>'
      +   '<div class="row2"><div class="field"><label for="st-r2s">Secret access key</label><input id="st-r2s" type="text" name="r2SecretAccessKey" autocomplete="off"></div>'
      +   '<div class="field"><label for="st-r2b">Bucket</label><input id="st-r2b" type="text" name="r2Bucket" placeholder="grmc-media"></div></div>'
      +   '<div class="field"><label for="st-r2u">Public base URL</label><input id="st-r2u" type="text" name="r2PublicBaseUrl" placeholder="https://media.grmc.app"></div></section>'
      + '<div class="pl-form-msg" id="st-msg"></div>'
      + '<div class="btn-row"><button class="btn btn-primary" type="submit">Save settings</button></div></form>';
  });
}

function saveSettings(form) {
  var body = {}, btn = form.querySelector('[type=submit]');
  new FormData(form).forEach(function(v, k){ body[k] = String(v).trim(); });
  btn.disabled = true;
  api('POST', '/api/settings', body).then(function(){
    toast('Settings saved.', 'ok');
    // Approved images and defaults may have changed; refetch next time they're used.
    approvedCache = null; window._mcDefaults = null;
    return render();
  }).catch(function(e){ btn.disabled = false; $('st-msg').innerHTML = '<div class="alert alert-err">'+esc(e.message)+'</div>'; });
}

function loadPicker(path, listKey, selectId, inputName, toOption) {
  var sel = $(selectId);
  api('GET', path).then(function(d){
    var rows = d[listKey] || [];
    if (!rows.length) { toast('Nothing came back. Check the saved token.', 'warn'); return; }
    sel.innerHTML = rows.map(function(r){ var o = toOption(r); return '<option value="'+esc(o.value)+'">'+esc(o.label)+'</option>'; }).join('');
    sel.hidden = false;
    sel.onchange = function(){
      var form = sel.closest('form');
      form.querySelector('[name='+inputName+']').value = sel.value;
      var name = form.querySelector('[name=buzzsproutPodcastName]');
      if (inputName === 'buzzsproutPodcastId' && name) name.value = sel.options[sel.selectedIndex].textContent;
    };
    sel.onchange();
  }).catch(function(e){ toast(e.message, 'err'); });
}
```

Add these cases to the click `switch`:

```js
    case 'load-podcasts':
      loadPicker('/api/podcast/podcasts', 'podcasts', 'st-bz-list', 'buzzsproutPodcastId', function(p){ return { value: p.id, label: p.title }; });
      break;
    case 'load-brands':
      loadPicker('/api/metricool/brands', 'brands', 'st-mc-list', 'metricoolBlogId', function(b){ return { value: b.id, label: b.label }; });
      break;
```

In the `submit` handler, add `if (kind === 'settings') return saveSettings(form);`.

Append to `pipeline.css`:

```css
/* ---- Settings ---- */
.pl-settings{max-width:760px}
.pl-voice{min-height:120px}
```

`/api/metricool/brands` answers `{ ok, brands: [{ id, label }] }`, and `/api/podcast/podcasts` answers `{ ok, podcasts: [{ id, title }] }`. Both are unchanged.

- [ ] **Step 6: Build and run the image against a database copy**

```bash
cd /path/to/GRMCApps
docker network create grmc-pl-test 2>/dev/null; docker network connect --alias postgres grmc-pl-test grmc-pipeline-test
docker build -q -f apps/social-posts/Dockerfile -t grmc-social-posts:pipeline-test .
docker run -d --name grmc-pl-app --network grmc-pl-test -p 3999:3000 \
  -e SOCIALPOSTS_DB_USER=postgres -e SOCIALPOSTS_DB_PASSWORD=test -e SOCIALPOSTS_DB_NAME=socialposts grmc-social-posts:pipeline-test
curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" localhost:3999/pipeline
curl -s localhost:3999/ | grep -c "pipeline.js"
```

Expected: `301 http://localhost:3999/`, then `1`.

- [ ] **Step 7: Verify Settings in a browser**

Save this as a scratch file outside the repo, e.g. `$SCRATCH/settings-check.js`. Run it with `NODE_PATH=<any local node_modules that has playwright> node settings-check.js`.

```js
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch(); const errors = [];
  const p = await b.newPage({ extraHTTPHeaders: { 'x-auth-email': 'me@grmc.org' } });
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto('http://localhost:3999/#settings'); await p.waitForSelector('#st-voice');
  console.log('voice starts with rules:', (await p.inputValue('#st-voice')).startsWith('GRMC voice rules'));
  await p.fill('#st-voice', 'Be warm. Be brief.'); await p.click('form[data-form=settings] [type=submit]'); await p.waitForTimeout(600);
  await p.reload(); await p.waitForSelector('#st-voice');
  console.log('voice saved:', await p.inputValue('#st-voice'));
  console.log('key not echoed:', await p.inputValue('#st-ak') === '');
  console.log('errors:', errors); await b.close();
})();
```

Expected: `voice starts with rules: true`, `voice saved: Be warm. Be brief.`, `key not echoed: true`, `errors: []`.

- [ ] **Step 8: Commit**

```bash
git add -A apps/social-posts/src
git commit -m "feat(social-posts): the pipeline is the app, with Settings and the house voice"
```

---

### Task 9: Edit a drafting profile on an event, and an override on a recurring post

**Files:**
- Modify: `apps/social-posts/src/public/pipeline.js`, `public/pipeline.css`
- Test: browser check (Step 5)

**Interfaces:**
- Consumes: `PATCH /api/pipeline/events/:id` with `{ drafting }` (Task 1); `EventRow.drafting`; `RecurrenceRow.drafting`; `POST`/`PATCH /api/pipeline/recurrences` accepting `drafting` (Task 1).
- Produces: `draftingCardHtml(e)`, `angleRowHtml(a)`, `readDraftingForm(form)`, the `data-form="drafting"` submit handler, and the actions `dr-kind`, `add-angle`, `remove-angle`.

- [ ] **Step 1: Add the drafting card to the event page**

In `apps/social-posts/src/public/pipeline.js`, in `renderEvent`, change the line that adds the stats strip so the card follows it:

```js
      + '<div class="pl-stats"><span><strong>'+live.length+'</strong> posts</span><span><strong>'+done+' of '+d.media.length+'</strong> media collected</span></div>'
      + draftingCardHtml(e);
```

Then add these functions before `// ── Editor drawer`:

```js
// ── Drafting profile (on an event) ───────────────────────────────────────────
var CUTOFF_LABELS = {
  latest: 'The newest issue',
  postDate: 'The newest issue on or before the post’s date',
  followingSunday: 'The newest issue by the Sunday after the post (Grace Notes)',
};

function angleRowHtml(a) {
  return '<div class="pl-angle-row">'
    + '<input type="text" data-angle="label" value="'+esc(a.label)+'" placeholder="Angle name" aria-label="Angle name">'
    + '<label class="pl-inline"><input type="number" data-angle="offsetDays" value="'+esc(a.offsetDays)+'" min="-30" max="60" aria-label="Days after the episode"> days after</label>'
    + '<button class="pl-x" type="button" data-act="remove-angle" aria-label="Remove angle">×</button>'
    + '<input type="hidden" data-angle="key" value="'+esc(a.key)+'">'
    + '<textarea data-angle="instructions" placeholder="What a post from this angle does" aria-label="Instructions">'+esc(a.instructions)+'</textarea></div>';
}

function draftingCardHtml(e) {
  var d = e.drafting || {}, src = d.source || { kind: 'none' };
  var opt = function(v, t, cur){ return '<option value="'+v+'"'+(v === cur ? ' selected' : '')+'>'+t+'</option>'; };
  return '<form class="card pl-drafting" data-form="drafting" data-id="'+esc(e.id)+'">'
    + '<h3 class="ct">Drafting</h3>'
    + '<p class="hint pl-under">How Draft with Claude writes this event’s posts. A recurring post or a single post can override the instructions.'
    + ' Background comes from the event’s notes'+(e.notes ? '' : ' (empty: <button class="pl-link" type="button" data-act="edit-event" data-id="'+esc(e.id)+'">add some</button>)')+'.</p>'
    + '<div class="row2"><div class="field"><label for="dr-kind">Source</label><select id="dr-kind" name="kind" data-act="dr-kind">'
    +   opt('none', 'None', src.kind) + opt('mailchimp', 'A Mailchimp newsletter', src.kind) + opt('buzzsprout', 'A podcast episode (Buzzsprout)', src.kind) + '</select></div>'
    + '<div class="field" data-dr="mailchimp"><label for="dr-subject">Campaigns whose subject contains</label>'
    +   '<input id="dr-subject" type="text" name="subjectContains" value="'+esc(src.subjectContains || '')+'" placeholder="grace notes"></div></div>'
    + '<div class="field" data-dr="mailchimp"><label for="dr-cutoff">Which issue</label><select id="dr-cutoff" name="cutoff">'
    +   ['latest', 'postDate', 'followingSunday'].map(function(c){ return opt(c, CUTOFF_LABELS[c], src.cutoff || 'latest'); }).join('') + '</select></div>'
    + '<div class="field"><label for="dr-instr">Instructions for each post</label>'
    +   '<textarea id="dr-instr" name="instructions" class="pl-instr" placeholder="What each post should do, e.g. Warm summary of what’s inside this week’s issue. End with the link.">'+esc(d.instructions || '')+'</textarea></div>'
    + '<div class="field" data-dr="buzzsprout"><span class="lbl">Angles</span><div id="dr-angles">'+(d.angles || []).map(angleRowHtml).join('')+'</div>'
    +   '<button class="btn-sm" type="button" data-act="add-angle">Add an angle</button>'
    +   '<div class="hint">Each angle becomes its own post when you plan posts from an episode.</div></div>'
    + '<div class="pl-form-msg"></div>'
    + '<div class="btn-row"><button class="btn btn-primary" type="submit">Save drafting</button></div></form>';
}

function showDraftingFields(form) {
  var kind = form.querySelector('[name=kind]').value;
  form.querySelectorAll('[data-dr]').forEach(function(el){ el.hidden = el.getAttribute('data-dr') !== kind; });
}

function readDraftingForm(form) {
  var fd = new FormData(form), kind = fd.get('kind');
  var source = kind === 'mailchimp' ? { kind: kind, subjectContains: String(fd.get('subjectContains') || '').trim(), cutoff: fd.get('cutoff') } : { kind: kind };
  var angles = Array.prototype.map.call(form.querySelectorAll('.pl-angle-row'), function(row, i){
    var g = function(k){ return row.querySelector('[data-angle='+k+']').value; };
    var label = g('label').trim();
    // New angles get a key from their name; existing ones keep theirs.
    var key = g('key') || label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || ('angle-' + (i + 1));
    return { key: /^[a-z]/.test(key) ? key : 'a-' + key, label: label, offsetDays: Number(g('offsetDays') || 0), instructions: g('instructions').trim() };
  });
  return { source: source, instructions: String(fd.get('instructions') || '').trim(), angles: kind === 'buzzsprout' ? angles : [] };
}
```

- [ ] **Step 2: Wire the card's actions**

In the click `switch`, add:

```js
    case 'add-angle':
      $('dr-angles').insertAdjacentHTML('beforeend', angleRowHtml({ key: '', label: '', offsetDays: 0, instructions: '' }));
      $('dr-angles').lastElementChild.querySelector('input').focus();
      break;
    case 'remove-angle': el.closest('.pl-angle-row').remove(); break;
```

In the `change` handler, before the `data-mfield` check, add `if (act === 'dr-kind') return showDraftingFields(el.closest('form'));`.

In the `submit` handler, add:

```js
  if (kind === 'drafting') {
    var dmsg = form.querySelector('.pl-form-msg');
    api('PATCH', '/api/pipeline/events/' + encodeURIComponent(form.getAttribute('data-id')), { drafting: readDraftingForm(form) })
      .then(function(){ toast('Drafting saved. New drafts for this event use it.', 'ok'); return refreshEvents().then(render); })
      .catch(function(err){ dmsg.innerHTML = '<div class="alert alert-err">'+esc(err.message)+'</div>'; });
    return;
  }
```

At the end of `renderEvent`, after `main.innerHTML = html;`, add:

```js
    var dform = main.querySelector('form[data-form=drafting]');
    if (dform) showDraftingFields(dform);
```

In `eventForm`, change the notes label text from `Notes and key messages` to `Notes, key messages and background for drafting`.

- [ ] **Step 3: Add the override to the recurring-post form**

In `recurrenceFormHtml`, after the Brief field, add:

```js
    + '<div class="field"><label for="rf-instr">Drafting instructions for each post</label>'
    +   '<textarea id="rf-instr" name="draftInstructions" class="pl-instr" placeholder="Leave empty to use the event’s">'+esc((r && r.drafting && r.drafting.instructions) || (pre.drafting && pre.drafting.instructions) || '')+'</textarea>'
    +   '<div class="hint">For posts that need different drafting from the rest of their event, like the Saturday invite.</div></div>'
```

In `saveRecurrence`, add to `body`: `drafting: { instructions: (fd.get('draftInstructions') || '').trim() },`.

Append to `pipeline.css`:

```css
/* ---- Drafting profiles ---- */
.pl-instr{min-height:96px}
.pl-angle-row{display:grid;grid-template-columns:1fr auto auto;gap:6px;align-items:center;border:1px solid var(--rule);border-radius:var(--r);padding:8px;margin-bottom:8px;background:var(--field-bg)}
.pl-angle-row textarea{grid-column:1 / -1;min-height:60px;font-size:12.5px}
.pl-angle-row input[type=number]{width:60px;border:1px solid var(--rule);border-radius:var(--r);padding:6px}
```

- [ ] **Step 4: Rebuild and rerun the image**

Run the Step 6 commands from Task 8 again (`docker rm -f grmc-pl-app` first).

- [ ] **Step 5: Verify in a browser**

Scratch script `drafting-check.js`:

```js
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch(); const errors = [];
  const p = await b.newPage({ extraHTTPHeaders: { 'x-auth-email': 'me@grmc.org' } });
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto('http://localhost:3999/#event/run-wednesday'); await p.waitForSelector('form[data-form=drafting]');
  console.log('source:', await p.inputValue('#dr-kind'), '| subject:', await p.inputValue('#dr-subject'), '| cutoff:', await p.inputValue('#dr-cutoff'));
  console.log('instructions are the Wednesday run\'s:', (await p.inputValue('#dr-instr')).startsWith('Warm summary of what is inside this week Grace Notes.'));
  await p.goto('http://localhost:3999/#event/run-podcast'); await p.waitForSelector('#dr-angles');
  console.log('angles:', await p.locator('.pl-angle-row').count());
  await p.click('[data-act=add-angle]'); await p.locator('.pl-angle-row').last().locator('[data-angle=label]').fill('Behind the mic');
  await p.locator('.pl-angle-row').last().locator('[data-angle=instructions]').fill('How the episode got made.');
  await p.click('form[data-form=drafting] [type=submit]'); await p.waitForTimeout(700);
  const ev = await (await fetch('http://localhost:3999/api/pipeline/events/run-podcast')).json();
  console.log('saved angle keys:', ev.event.drafting.angles.map((a) => a.key).join(','));
  console.log('errors:', errors); await b.close();
})();
```

Expected:
- `source: mailchimp | subject: grace notes | cutoff: followingSunday`
- `instructions are the Wednesday run's: true`
- `angles: 5`
- `saved angle keys: announcement,question,quote,guest,invite,behind-the-mic`
- `errors: []`

- [ ] **Step 6: Commit**

```bash
git add apps/social-posts/src/public/pipeline.js apps/social-posts/src/public/pipeline.css
git commit -m "feat(pipeline): edit an event's drafting profile and a recurring post's instructions"
```

---

### Task 10: The editor's source panel, per-post override and earlier drafts

**Files:**
- Modify: `apps/social-posts/src/public/pipeline.js`, `public/pipeline.css`
- Test: browser check with stand-ins (Step 6)

**Interfaces:**
- Consumes:
  - `POST /api/pipeline/source/preview`: `{ effective: { source, instructions, from } | null, source: SourcePreview | null, error? }`
  - `GET /api/pipeline/sources/campaigns?subject=`, `GET /api/pipeline/sources/episodes`
  - `POST /api/pipeline/draft-caption` (now taking `contentItemId`, `drafting`, `sourceRef`, `phase`)
  - `GET /api/pipeline/content/:id/drafts`
  - `ContentRow.drafting / sourceRef / phase`
- Produces:
  - Client state `drawer.sourceRef: SourceRef | null`.
  - `readForm(form)` now also returns `drafting`, `sourceRef` and `phase`.
  - Functions `loadSourcePanel()`, `sourcePanelHtml(res)`, `loadHistory()`.
  - Actions `src-change`, `src-pick`, `src-paste`, `src-use-paste`, `src-reset`, `restore-draft`.

- [ ] **Step 1: Keep the source ref in drawer state**

In `pipeline.js`:
1. Add `sourceRef: null` to the `drawer` object literal.
2. In `newPost`, add `drawer.sourceRef = null;`.
3. In `openPost`, after `drawer.recurrence = d.recurrence;`, add `drawer.sourceRef = d.item.sourceRef || null;`.

In `readForm`, before `return out;`, add:

```js
  var instr = (fd.get('draftInstructions') || '').trim(), noSource = fd.get('draftNoSource') === 'on';
  out.drafting = {};
  if (instr) out.drafting.instructions = instr;
  if (noSource) out.drafting.source = { kind: 'none' };
  out.sourceRef = drawer.sourceRef;
  out.phase = drawer.item ? drawer.item.phase || '' : '';
```

`sameValue` already compares objects with `JSON.stringify`, so `drafting` and `sourceRef` are only sent when they change.

- [ ] **Step 2: Add the panel, the override and the history to `editorHtml`**

In `editorHtml`, insert this block immediately before `+ '<div class="field pl-caption-block">`:

```js
    + (i.phase ? '<p class="hint">Phase: '+esc(i.phase)+'</p>' : '')
    + '<section class="pl-source-panel" id="pf-source" aria-live="polite"><p class="hint">Checking where this post drafts from…</p></section>'
    + '<details class="pl-override"'+((i.drafting && (i.drafting.instructions || i.drafting.source)) ? ' open' : '')+'><summary>Drafting for this post</summary>'
    +   '<div class="field"><label for="pf-instr">Instructions</label><textarea id="pf-instr" name="draftInstructions" class="pl-instr" placeholder="Leave empty to use the event’s">'+esc((i.drafting && i.drafting.instructions) || '')+'</textarea></div>'
    +   '<label class="check"><input type="checkbox" name="draftNoSource" data-act="src-toggle"'+(i.drafting && i.drafting.source && i.drafting.source.kind === 'none' ? ' checked' : '')+'> Don’t use the event’s source for this post</label>'
    + '</details>'
```

Insert this immediately after the closing `</form>` of the post form, before `+ mediaSectionHtml(i);`:

```js
    + (drawer.id ? '<details class="pl-history" data-act="history"><summary>Earlier drafts</summary><div id="pf-history"><p class="hint">Loading…</p></div></details>' : '')
```

In `sourceHtml`, drop the links to the removed tabs:

```js
function sourceHtml(src) {
  if (!src) return '';
  if (src.kind === 'series') return '<p class="pl-source">Post '+src.postNumber+' of the “'+esc(src.seriesName)+'” series.</p>';
  var runs = { wednesday: 'Wednesday run', friday: 'Friday run', podcast: 'Podcast run' };
  return '<p class="pl-source">First drafted by the '+esc(runs[src.run] || src.run)+' on '+esc(String(src.draftedAt).slice(0, 10))+'.</p>';
}
```

- [ ] **Step 3: Add the panel's functions**

Add before `function draftCaption`:

```js
// ── Source panel: what Draft with Claude will work from ──
var sourceTimer;
function loadSourcePanel() {
  clearTimeout(sourceTimer);
  sourceTimer = setTimeout(function(){
    var form = document.querySelector('form[data-form=content]'), panel = $('pf-source');
    if (!form || !panel) return;
    var body = readForm(form); body.contentItemId = drawer.id;
    api('POST', '/api/pipeline/source/preview', body).then(function(res){
      drawer.preview = res;
      panel.innerHTML = sourcePanelHtml(res);
      panel.hidden = !panel.innerHTML;
    }).catch(function(e){ panel.innerHTML = '<div class="alert alert-err">'+esc(e.message)+'</div>'; });
  }, 250);
}

function sourcePanelHtml(res) {
  var eff = res.effective, s = res.source, ref = drawer.sourceRef;
  var paste = '<button class="btn-sm" type="button" data-act="src-paste">Paste content instead</button>';
  var reset = ref ? ' <button class="pl-link" type="button" data-act="src-reset">Use the event’s choice</button>' : '';
  if (res.error) {
    return '<div class="alert alert-warn">Couldn’t reach the source: '+esc(res.error)+' <a href="#settings">Settings</a></div>' + paste;
  }
  var kind = ref ? ref.kind : (eff ? eff.source.kind : 'none');
  if (kind === 'none') return '';
  var head = '<div class="pl-label-row"><span class="lbl">Drafts from</span>'
    + '<span>'+(kind !== 'manual' ? '<button class="btn-sm" type="button" data-act="src-change" data-kind="'+kind+'">Change</button> ' : '')+paste+'</span></div>';
  if (kind === 'buzzsprout' && !s) return head + '<p class="pl-gaptext">Pick the episode this post is about.</p><div id="pf-src-list"></div>';
  if (!s) return head + '<p class="hint">Nothing found to draft from.</p>' + reset;
  var marks = (s.isDraft ? ' <span class="pl-status pl-s-drafted">Not sent yet</span>' : '')
    + (s.notYetPublic ? ' <span class="pl-status pl-s-drafted">Not out yet</span>' : '');
  return head
    + '<p class="pl-src-title"><strong>'+esc(s.title)+'</strong>'+marks+'</p>'
    + (s.dateLine ? '<p class="hint">'+esc(s.dateLine)+'</p>' : '')
    + (s.url ? '<p class="hint"><a href="'+esc(s.url)+'" target="_blank" rel="noopener">'+esc(s.url)+'</a></p>' : '')
    + (s.excerpt ? '<p class="pl-src-excerpt">'+esc(s.excerpt)+'…</p>' : '')
    + (ref ? '<p class="hint">Picked for this post.'+reset+'</p>' : '')
    + '<div id="pf-src-list"></div>';
}

function showSourceChoices(kind) {
  var list = $('pf-src-list');
  list.innerHTML = '<p class="hint">Loading…</p>';
  var eff = drawer.preview && drawer.preview.effective;
  var req = kind === 'buzzsprout'
    ? api('GET', '/api/pipeline/sources/episodes').then(function(d){
        return d.episodes.map(function(ep){
          return { ref: { kind: 'buzzsprout', id: String(ep.id), title: ep.title, url: ep.listenUrl, date: ep.publishDate },
                   label: ep.label + (ep.isPublished ? '' : ' (not out yet)') };
        });
      })
    : api('GET', '/api/pipeline/sources/campaigns?subject=' + encodeURIComponent(eff.source.subjectContains || '')).then(function(d){
        return d.campaigns.map(function(c){
          return { ref: { kind: 'mailchimp', id: c.id, title: c.subject, url: c.archiveUrl, date: c.issueDate },
                   label: c.subject + (c.isDraft ? ' (not sent)' : '') + (c.dateLine ? ' — ' + c.dateLine : '') };
        });
      });
  req.then(function(rows){
    drawer.sourceChoices = rows;
    list.innerHTML = rows.length
      ? '<ul class="pl-src-choices">' + rows.map(function(r, i){
          return '<li><button type="button" class="pl-link" data-act="src-pick" data-i="'+i+'">'+esc(r.label)+'</button></li>';
        }).join('') + '</ul>'
      : '<p class="hint">Nothing to choose from.</p>';
  }).catch(function(e){ list.innerHTML = '<p class="pl-gaptext">'+esc(e.message)+'</p>'; });
}

function loadHistory() {
  var box = $('pf-history');
  api('GET', '/api/pipeline/content/' + encodeURIComponent(drawer.id) + '/drafts').then(function(d){
    drawer.history = d.drafts;
    box.innerHTML = d.drafts.length
      ? '<ul class="pl-history-list">' + d.drafts.map(function(h, i){
          var first = (h.captionMode === 'separate' ? (h.captions.instagram || h.captions.facebook || h.captions.x || '') : h.caption).split('\n')[0];
          return '<li><span class="hint">'+esc(new Date(h.at).toLocaleString())+' · '+(h.origin === 'run' ? 'weekly run' : 'Claude')
            + (h.captionMode === 'separate' ? ' · per platform' : '')+'</span><span class="pl-history-text">'+esc(first)+'</span>'
            + '<button class="btn-sm" type="button" data-act="restore-draft" data-i="'+i+'">Restore</button></li>';
        }).join('') + '</ul>'
      : '<p class="hint">No earlier drafts yet.</p>';
  }).catch(function(e){ box.innerHTML = '<p class="pl-gaptext">'+esc(e.message)+'</p>'; });
}
```

In `openPost` (after `$('pl-drawer').innerHTML = editorHtml(d.item);`) and in `newPost` (after `openDrawer(...)`), add `loadSourcePanel();`.

- [ ] **Step 4: Send the post's id, override and ref when drafting, and keep the ref it used**

In `draftCaption`, change the request line to:

```js
  var req = readForm(form); req.contentItemId = drawer.id;
  api('POST', '/api/pipeline/draft-caption', req).then(function(res){
```

Delete the `var cur = readForm(form);` line above it. Inside the success branch, after `refreshCaptionUi();`, add:

```js
    if (res.source && res.source.kind !== 'manual') {
      drawer.sourceRef = { kind: res.source.kind, id: res.source.id, title: res.source.title, url: res.source.url, date: res.source.date };
    }
    if ($('pf-history') && $('pf-history').closest('details').open) loadHistory();
```

- [ ] **Step 5: Wire the actions**

In the click `switch`, add:

```js
    case 'src-change': showSourceChoices(el.getAttribute('data-kind')); break;
    case 'src-pick':
      drawer.sourceRef = drawer.sourceChoices[Number(el.getAttribute('data-i'))].ref; loadSourcePanel(); break;
    case 'src-reset': drawer.sourceRef = null; loadSourcePanel(); break;
    case 'src-paste':
      $('pf-source').insertAdjacentHTML('beforeend', '<div class="pl-paste"><textarea id="pf-paste" placeholder="Paste the newsletter or show notes text">'
        + esc(drawer.sourceRef && drawer.sourceRef.kind === 'manual' ? drawer.sourceRef.content : '')
        + '</textarea><input type="url" id="pf-paste-url" placeholder="Link to it (optional)" value="'
        + esc(drawer.sourceRef && drawer.sourceRef.kind === 'manual' ? drawer.sourceRef.url || '' : '')
        + '"><button class="btn-sm btn-sm-gold" type="button" data-act="src-use-paste">Use this</button></div>');
      $('pf-paste').focus();
      break;
    case 'src-use-paste':
      if (!$('pf-paste').value.trim()) { toast('Paste the content first.', 'err'); return; }
      drawer.sourceRef = { kind: 'manual', content: $('pf-paste').value.trim(), url: $('pf-paste-url').value.trim(), title: 'Pasted content' };
      loadSourcePanel(); break;
    case 'restore-draft':
      var h = drawer.history[Number(el.getAttribute('data-i'))], cf = document.querySelector('form[data-form=content]');
      setCaptionMode(h.captionMode);
      if (h.captionMode === 'separate') Object.keys(h.captions).forEach(function(k){ var box = cf.querySelector('[name="caption-'+k+'"]'); if (box) box.value = h.captions[k]; });
      else cf.querySelector('[name=caption]').value = h.caption;
      refreshCaptionUi(); toast('Restored. Save to keep it.', 'ok');
      break;
```

The history `<details>` loads when opened. Add this listener next to the other `document.addEventListener` calls:

```js
document.addEventListener('toggle', function(e){
  if (e.target.matches && e.target.matches('details.pl-history') && e.target.open) loadHistory();
}, true);
```

In the `change` handler, add: `if (act === 'src-toggle' || ((el.name === 'publishDate' || el.name === 'eventId') && el.closest('form[data-form=content]'))) loadSourcePanel();`

Append to `pipeline.css`:

```css
/* ---- Source panel and history ---- */
.pl-source-panel{border:1px solid var(--rule);border-radius:var(--r);background:var(--paper);padding:10px 12px;margin-bottom:14px}
.pl-source-panel:empty{display:none}
.pl-src-title{margin:4px 0 2px;font-size:13px}
.pl-src-excerpt{font-size:12px;color:var(--ink-soft);margin-top:6px;max-height:5.6em;overflow:hidden}
.pl-src-choices{list-style:none;margin-top:8px;max-height:220px;overflow-y:auto}
.pl-src-choices li{padding:4px 0;border-bottom:1px solid var(--rule);font-size:12.5px}
.pl-paste{display:grid;gap:6px;margin-top:8px}
.pl-paste textarea{min-height:110px}
.pl-override,.pl-history{margin:0 0 14px}
.pl-override summary,.pl-history summary{cursor:pointer;font-size:12.5px;font-weight:600;color:var(--navy);margin-bottom:8px}
.pl-history{padding:0 22px}
.pl-history-list{list-style:none}
.pl-history-list li{display:grid;grid-template-columns:1fr auto;gap:2px 8px;align-items:center;padding:6px 0;border-bottom:1px solid var(--rule)}
.pl-history-text{grid-column:1;font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pl-history-list .btn-sm{grid-row:1 / span 2;grid-column:2}
```

- [ ] **Step 6: Verify with stand-ins for Mailchimp and Claude**

Create a scratch preload outside the repo, `$SCRATCH/fake-upstreams/fake.js`. It answers the app's outbound requests so the real server code runs end to end:

```js
// Test-only: answers Mailchimp, Buzzsprout and Anthropic requests with canned data.
const real = globalThis.fetch;
const json = (b) => ({ ok: true, status: 200, json: async () => b, text: async () => JSON.stringify(b) });
const CAMPAIGNS = { campaigns: [
  { id: 'c25', status: 'save', settings: { subject_line: 'Grace Notes - October 25, 2026' }, archive_url: 'https://mc.example/c25', send_time: '', create_time: '2026-10-23T14:00:00Z' },
  { id: 'c18', status: 'sent', settings: { subject_line: 'Grace Notes - October 18, 2026' }, archive_url: 'https://mc.example/c18', send_time: '2026-10-16T14:00:00Z', create_time: '2026-10-16T13:00:00Z' },
] };
const EP = (id, at) => ({ id, title: 'Too small or too big?', description: '<p>Show notes</p>', custom_url: null, published_at: at, duration: 1920, episode_number: 4, season_number: 1, private: false });
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (/api\.mailchimp\.com\/3\.0\/campaigns\?/.test(u)) return json(CAMPAIGNS);
  const m = /campaigns\/(\w+)\/content/.exec(u); if (m) return json({ plain_text: 'This week in Grace Notes (' + m[1] + '): the harvest supper.' });
  if (/buzzsprout\.com\/api\/\d+\/episodes\.json/.test(u)) return json([EP(9, '2026-11-01T10:00:00Z')]);
  if (/buzzsprout\.com\/api\/\d+\/episodes\/\d+\.json/.test(u)) return json(EP(9, '2026-11-01T10:00:00Z'));
  if (/api\.anthropic\.com/.test(u)) {
    const prompt = JSON.parse(init.body).messages[0].content, sys = JSON.parse(init.body).system;
    const keys = (/Keys: (.*?), each/.exec(sys) || [, '"post"'])[1].match(/"(\w+)"/g).map((k) => k.slice(1, -1));
    if (/Generate a post schedule/.test(prompt)) return json({ content: [{ text: JSON.stringify([{ date: '2026-11-29', phase: 'Waiting', title: 'Hope', sub: 'First candle.' }, { date: '2026-12-06', phase: '', title: 'Peace', sub: 'Second candle.' }]) }] });
    const src = (/SOURCE: (.*)/.exec(prompt) || /EPISODE TITLE: (.*)/.exec(prompt) || [, 'no source'])[1];
    const out = {}; keys.forEach((k) => { out[k] = 'Drafted for ' + k + ' from ' + src; });
    return json({ content: [{ text: JSON.stringify(out) }] });
  }
  return real(url, init);
};
```

Run the app with it, after saving dummy keys so the code paths pass their "configured?" checks:

```bash
docker rm -f grmc-pl-app; docker build -q -f apps/social-posts/Dockerfile -t grmc-social-posts:pipeline-test .
docker run -d --name grmc-pl-app --network grmc-pl-test -p 3999:3000 -v "$SCRATCH/fake-upstreams:/fake:ro" -e NODE_OPTIONS="--require /fake/fake.js" \
  -e SOCIALPOSTS_DB_USER=postgres -e SOCIALPOSTS_DB_PASSWORD=test -e SOCIALPOSTS_DB_NAME=socialposts grmc-social-posts:pipeline-test
sleep 3; curl -s -X POST localhost:3999/api/settings -H 'content-type: application/json' \
  -d '{"anthropicKey":"x","mailchimpKey":"k-us1","mailchimpServer":"us1","buzzsproutToken":"t","buzzsproutPodcastId":"77"}'
```

Scratch script `editor-source-check.js`:

```js
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch(); const errors = [];
  const p = await b.newPage({ extraHTTPHeaders: { 'x-auth-email': 'me@grmc.org' }, viewport: { width: 1300, height: 1200 } });
  p.on('pageerror', (e) => errors.push(e.message)); p.on('dialog', (d) => d.accept());
  await p.goto('http://localhost:3999/#calendar'); await p.waitForSelector('.pl-card');
  await p.click('[data-act=new-post]'); await p.waitForSelector('#pf-source');
  await p.fill('#pf-title', 'Grace Notes'); await p.selectOption('#pf-event', 'run-wednesday');
  await p.fill('#pf-date', '2026-10-14'); await p.dispatchEvent('#pf-date', 'change'); await p.waitForTimeout(900);
  console.log('panel shows that week\'s issue:', (await p.locator('#pf-source').innerText()).includes('Grace Notes - October 18, 2026'));
  await p.click('[data-act=draft-caption]'); await p.waitForTimeout(900);
  console.log('caption:', await p.inputValue('#pf-caption'));
  // Drafts are logged against saved posts: save, draft again, then look at the history.
  await p.click('form[data-form=content] [type=submit]'); await p.waitForSelector('details.pl-history'); await p.waitForTimeout(600);
  await p.click('[data-act=draft-caption]'); await p.waitForTimeout(900);
  await p.click('details.pl-history summary'); await p.waitForTimeout(600);
  console.log('history rows:', await p.locator('.pl-history-list li').count());
  await p.click('[data-act=src-change]'); await p.waitForSelector('[data-act=src-pick]');
  await p.locator('[data-act=src-pick]').first().click(); await p.waitForTimeout(700);
  console.log('after change:', (await p.locator('#pf-source').innerText()).includes('October 25'));
  await p.click('[data-act=src-paste]'); await p.fill('#pf-paste', 'Pasted text'); await p.click('[data-act=src-use-paste]'); await p.waitForTimeout(700);
  console.log('pasted:', (await p.locator('#pf-source').innerText()).includes('Pasted content'));
  console.log('errors:', errors); await b.close();
})();
```

Expected:
- `panel shows that week's issue: true`
- `caption: Drafted for post from Grace Notes - October 18, 2026`
- `history rows: 1`
- `after change: true`
- `pasted: true`
- `errors: []`

- [ ] **Step 7: Commit**

```bash
git add apps/social-posts/src/public/pipeline.js apps/social-posts/src/public/pipeline.css
git commit -m "feat(pipeline): source panel, per-post drafting override and earlier drafts in the editor"
```

---

### Task 11: Planning from the event page

**Files:**
- Modify: `apps/social-posts/src/public/pipeline.js`, `public/pipeline.css`
- Test: browser check with stand-ins (Step 4)

**Interfaces:**
- Consumes:
  - `POST /api/pipeline/events/:id/plan-episode`: `{ items }`
  - `POST /api/pipeline/events/:id/plan-series/propose`: `{ posts: [{ date, phase, title, sub }] }`
  - `POST /api/pipeline/events/:id/plan-series`: `{ items }`
  - `POST /api/pipeline/draft-all`: `{ results: [{ id, ok, error? }] }`
  - `GET /api/pipeline/sources/episodes`
- Produces: `episodePlanForm(e)`, `seriesPlanForm(e)`, `planRowHtml(p)`, `draftAllFor(ids, btn)`, and the actions `plan-episode`, `plan-series`, `add-plan-row`, `remove-plan-row`, `draft-all`, with the forms `data-form="plan-episode"`, `data-form="plan-series-propose"` and `data-form="plan-series"`.

- [ ] **Step 1: Add the buttons to the event header**

In `renderEvent`, after the Duplicate button, add:

```js
      + (e.drafting && e.drafting.source && e.drafting.source.kind === 'buzzsprout'
          ? '<button class="btn-sm btn-sm-gold" type="button" data-act="plan-episode" data-id="'+esc(e.id)+'">Plan posts from an episode</button>' : '')
      + (e.kind === 'series' ? '<button class="btn-sm btn-sm-gold" type="button" data-act="plan-series" data-id="'+esc(e.id)+'">Plan posts with Claude</button>' : '')
```

- [ ] **Step 2: Add the planning functions**

Add before `// ── Editor drawer`:

```js
// ── Planning several posts at once ───────────────────────────────────────────
function episodePlanForm(e) {
  var angles = (e.drafting && e.drafting.angles) || [];
  return '<form class="card pl-form" data-form="plan-episode" data-id="'+esc(e.id)+'">'
    + '<h3 class="ct">Plan posts from an episode</h3>'
    + '<div class="field"><label for="pe-ep">Episode</label><select id="pe-ep" name="episodeId"><option value="">Loading episodes…</option></select></div>'
    + '<fieldset class="field"><legend class="lbl">One post for each angle you tick</legend>'
    + (angles.length ? angles.map(function(a){
        return '<label class="check"><input type="checkbox" name="angles" value="'+esc(a.key)+'"'+(a.key === 'announcement' ? ' checked' : '')+'> '
          + esc(a.label)+' <span class="muted">('+(a.offsetDays ? (a.offsetDays > 0 ? '+' : '')+a.offsetDays+' days' : 'episode day')+')</span></label>';
      }).join('') : '<p class="hint">This event has no angles. Add them in its Drafting section.</p>')
    + '</fieldset><div class="pl-form-msg"></div>'
    + '<div class="btn-row"><button class="btn btn-primary" type="submit">Create posts</button>'
    + '<button class="btn btn-secondary" type="button" data-act="cancel-event-form">Cancel</button></div></form>';
}

function planRowHtml(p) {
  return '<div class="pl-plan-row">'
    + '<input type="date" data-plan="date" value="'+esc(p.date || '')+'" aria-label="Date">'
    + '<input type="text" data-plan="phase" value="'+esc(p.phase || '')+'" placeholder="Phase (optional)" aria-label="Phase">'
    + '<input type="text" data-plan="title" value="'+esc(p.title || '')+'" placeholder="Title" aria-label="Title">'
    + '<button class="pl-x" type="button" data-act="remove-plan-row" aria-label="Remove">×</button>'
    + '<input type="text" data-plan="sub" value="'+esc(p.sub || '')+'" placeholder="Angle for this post" aria-label="Angle"></div>';
}

function seriesPlanForm(e) {
  return '<form class="card pl-form" data-form="plan-series-propose" data-id="'+esc(e.id)+'">'
    + '<h3 class="ct">Plan posts with Claude</h3>'
    + '<p class="hint pl-under">Claude proposes titles and angles from this series’ notes. You edit the list before anything is saved.</p>'
    + '<div class="row3"><div class="field"><label for="ps-count">Number of posts</label><input id="ps-count" type="number" name="count" min="1" max="52" value="6"></div>'
    + '<div class="field"><label for="ps-cad">Cadence</label><select id="ps-cad" name="cadence"><option value="weekly">Weekly</option><option value="biweekly">Every other week</option><option value="monthly">Monthly</option></select></div>'
    + '<div class="field"><label for="ps-start">First post</label><input id="ps-start" type="date" name="startDate" value="'+esc(S.meta.today)+'"></div></div>'
    + '<div class="pl-form-msg"></div><div class="btn-row"><button class="btn btn-primary" type="submit">Propose a plan</button>'
    + '<button class="btn btn-secondary" type="button" data-act="cancel-event-form">Cancel</button></div></form>';
}

function showPlanRows(eventId, posts) {
  $('pl-event-form').innerHTML = '<form class="card pl-form" data-form="plan-series" data-id="'+esc(eventId)+'">'
    + '<h3 class="ct">Check the plan</h3><div id="ps-rows">'+posts.map(planRowHtml).join('')+'</div>'
    + '<button class="btn-sm" type="button" data-act="add-plan-row">Add a post</button>'
    + '<div class="pl-form-msg"></div><div class="btn-row"><button class="btn btn-primary" type="submit">Save these posts</button>'
    + '<button class="btn btn-secondary" type="button" data-act="cancel-event-form">Cancel</button></div></form>';
}

function offerDraftAll(items) {
  $('pl-event-form').innerHTML = '<div class="card"><h3 class="ct">'+items.length+' post'+(items.length === 1 ? '' : 's')+' created</h3>'
    + '<p class="hint pl-under">Draft them all now, or open each one and draft it there.</p>'
    + '<div class="btn-row"><button class="btn btn-gold" type="button" data-act="draft-all" data-ids="'+esc(items.map(function(i){ return i.id; }).join(','))+'">Draft all with Claude</button>'
    + '<button class="btn btn-secondary" type="button" data-act="cancel-event-form">Done</button></div><div id="pl-draft-all-msg"></div></div>';
}

function draftAllFor(ids, btn) {
  btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Drafting '+ids.length+'…';
  api('POST', '/api/pipeline/draft-all', { ids: ids }).then(function(d){
    var failed = d.results.filter(function(r){ return !r.ok; });
    btn.textContent = 'Drafted';
    $('pl-draft-all-msg').innerHTML = failed.length
      ? '<div class="alert alert-warn">'+(ids.length - failed.length)+' drafted. '+failed.length+' didn’t: '
        + esc(failed.map(function(r){ return r.error; }).join(' ')) + ' Open those posts to try again.</div>'
      : '<div class="alert alert-ok">All '+ids.length+' drafted.</div>';
    toast(failed.length ? (ids.length - failed.length) + ' drafted, ' + failed.length + ' need another try.' : 'All ' + ids.length + ' drafted.', failed.length ? 'warn' : 'ok');
  }).catch(function(e){ btn.disabled = false; btn.textContent = 'Draft all with Claude'; toast(e.message, 'err'); });
}
```

`draftAllFor` deliberately doesn't call `render()`: that would redraw the event page and clear the result message. The timeline refreshes when the person clicks **Done** (the `cancel-event-form` action), or on the next navigation.

- [ ] **Step 3: Wire the actions**

In the click `switch`, add:

```js
    case 'plan-episode':
      var pe = eventById(el.getAttribute('data-id'));
      $('pl-event-form').innerHTML = episodePlanForm(pe);
      api('GET', '/api/pipeline/sources/episodes').then(function(d){
        $('pe-ep').innerHTML = d.episodes.length
          ? d.episodes.map(function(ep){ return '<option value="'+esc(ep.id)+'">'+esc(ep.label)+(ep.isPublished ? '' : ' (not out yet)')+'</option>'; }).join('')
          : '<option value="">No episodes found</option>';
      }).catch(function(err){ $('pe-ep').innerHTML = '<option value="">'+esc(err.message)+'</option>'; });
      break;
    case 'plan-series':
      $('pl-event-form').innerHTML = seriesPlanForm(eventById(el.getAttribute('data-id'))); break;
    case 'add-plan-row':
      $('ps-rows').insertAdjacentHTML('beforeend', planRowHtml({})); break;
    case 'remove-plan-row': el.closest('.pl-plan-row').remove(); break;
    case 'draft-all': draftAllFor(el.getAttribute('data-ids').split(','), el); break;
```

In the `submit` handler, add:

```js
  if (kind === 'plan-episode') {
    var pfd = new FormData(form);
    api('POST', '/api/pipeline/events/' + encodeURIComponent(form.getAttribute('data-id')) + '/plan-episode',
      { episodeId: pfd.get('episodeId'), angles: pfd.getAll('angles') })
      .then(function(d){ return refreshEvents().then(function(){ return render(); }).then(function(){ offerDraftAll(d.items); }); })
      .catch(function(err){ form.querySelector('.pl-form-msg').innerHTML = '<div class="alert alert-err">'+esc(err.message)+'</div>'; });
    return;
  }
  if (kind === 'plan-series-propose') {
    var sfd = new FormData(form), sbtn = form.querySelector('[type=submit]');
    sbtn.disabled = true; sbtn.innerHTML = '<span class="spin"></span> Planning…';
    api('POST', '/api/pipeline/events/' + encodeURIComponent(form.getAttribute('data-id')) + '/plan-series/propose',
      { count: Number(sfd.get('count')), cadence: sfd.get('cadence'), startDate: sfd.get('startDate') })
      .then(function(d){ showPlanRows(form.getAttribute('data-id'), d.posts); })
      .catch(function(err){ sbtn.disabled = false; sbtn.textContent = 'Propose a plan'; form.querySelector('.pl-form-msg').innerHTML = '<div class="alert alert-err">'+esc(err.message)+'</div>'; });
    return;
  }
  if (kind === 'plan-series') {
    var posts = Array.prototype.map.call(form.querySelectorAll('.pl-plan-row'), function(row){
      var g = function(k){ return row.querySelector('[data-plan='+k+']').value.trim(); };
      return { date: g('date'), phase: g('phase'), title: g('title'), sub: g('sub') };
    });
    api('POST', '/api/pipeline/events/' + encodeURIComponent(form.getAttribute('data-id')) + '/plan-series', { posts: posts })
      .then(function(d){ return refreshEvents().then(function(){ return render(); }).then(function(){ offerDraftAll(d.items); }); })
      .catch(function(err){ form.querySelector('.pl-form-msg').innerHTML = '<div class="alert alert-err">'+esc(err.message)+'</div>'; });
    return;
  }
```

Both branches re-render first, so the new posts appear in the timeline, and then show the "Draft all" card in the cleared `#pl-event-form`.

The existing `cancel-event-form` action only clears the form. Make **Done** also refresh the timeline by changing that case to: `case 'cancel-event-form': $('pl-event-form').innerHTML = ''; render(); break;`

Append to `pipeline.css`:

```css
/* ---- Planning ---- */
.pl-plan-row{display:grid;grid-template-columns:150px 1fr 2fr auto;gap:6px;align-items:center;margin-bottom:6px}
.pl-plan-row [data-plan=sub]{grid-column:1 / -1;font-size:12px;color:var(--ink-soft)}
.pl-plan-row input[type=date]{border:1px solid var(--rule);border-radius:var(--r);padding:7px 8px;font-family:var(--font-ui);font-size:12.5px;background:var(--field-bg)}
@media (max-width:700px){ .pl-plan-row{grid-template-columns:1fr 1fr} .pl-plan-row [data-plan=title]{grid-column:1 / -1} }
```

- [ ] **Step 4: Verify with the stand-ins**

With the Task 10 container running, use scratch script `planning-check.js`:

```js
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch(); const errors = [];
  const p = await b.newPage({ extraHTTPHeaders: { 'x-auth-email': 'me@grmc.org' } });
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto('http://localhost:3999/#event/run-podcast'); await p.waitForSelector('[data-act=plan-episode]');
  await p.click('[data-act=plan-episode]'); await p.waitForFunction(() => document.querySelector('#pe-ep option[value="9"]'));
  await p.check('[name=angles][value=quote]');
  await p.click('form[data-form=plan-episode] [type=submit]'); await p.waitForSelector('[data-act=draft-all]');
  await p.click('[data-act=draft-all]'); await p.waitForSelector('#pl-draft-all-msg .alert, .pl-toast.show', { timeout: 10000 });
  const items = (await (await fetch('http://localhost:3999/api/pipeline/content?eventId=run-podcast')).json()).items;
  console.log('podcast posts:', items.map((i) => i.title + ' @ ' + i.publishDate + ' [' + i.status + ']').join('; '));
  await p.goto('http://localhost:3999/#event/' + (await (await fetch('http://localhost:3999/api/pipeline/events?archived=all')).json()).events.find((e) => e.kind === 'series' && e.seriesId).id);
  await p.click('[data-act=plan-series]'); await p.click('form[data-form=plan-series-propose] [type=submit]');
  await p.waitForSelector('.pl-plan-row'); console.log('proposed rows:', await p.locator('.pl-plan-row').count());
  await p.click('form[data-form=plan-series] [type=submit]'); await p.waitForSelector('[data-act=draft-all]');
  console.log('errors:', errors); await b.close();
})();
```

Expected:
- `podcast posts: Announcement: Too small or too big? @ 2026-11-01 [drafted]; Pull quote: Too small or too big? @ 2026-11-05 [drafted]`
- `proposed rows: 2`
- `errors: []`

- [ ] **Step 5: Commit**

```bash
git add apps/social-posts/src/public/pipeline.js apps/social-posts/src/public/pipeline.css
git commit -m "feat(pipeline): plan posts from an episode or with Claude, then draft them all"
```

---
### Task 12: Docs, full regression pass, rollout notes

**Files:**
- Modify: `README.md`, `docs/content-pipeline-how-to.md`, `docs/superpowers/specs/2026-10-20-pipeline-as-main-app-design.md` (status line)
- Test: full suite; a browser regression pass at desktop and phone widths with the stand-ins from Task 10

**Interfaces:**
- Consumes: everything above.
- Produces: user-facing docs that match the app.

- [ ] **Step 1: Rewrite the README's Social Posts entry**

In `README.md`, replace the whole **Social Posts** bullet (from `- **Social Posts** (`social.grmc.app`)` through the end of its **Content pipeline** paragraph) with:

```markdown
- **Social Posts** (`social.grmc.app`) — the church's content pipeline: what
  publishes when, for which event or department, and what media has to be
  collected first. A dashboard of gaps, publish and capture calendars (drag to
  reschedule), a status board, recurring posts, and a page per event.
  **Draft with Claude** writes each post from its event's *drafting profile*:
  a source (a Mailchimp newsletter such as Grace Notes or the weekly blog, or a
  Buzzsprout podcast episode), instructions, and the event's notes, in the
  house voice set in Settings. Captions can be the same everywhere or
  different per platform (X kept to 280). Posts go to Metricool from the
  editor; media can be ticked off as collected or linked to a signed-off file
  from Approvals. Podcast events can plan one post per angle from an episode;
  series events can plan their posts with Claude. Keys for Anthropic,
  Mailchimp, Buzzsprout, Metricool and R2 are in its Settings tab (stored in
  the `socialposts` database). Staff guide: `docs/content-pipeline-how-to.md`.
```

- [ ] **Step 2: Update the staff how-to**

In `docs/content-pipeline-how-to.md`:

1. Change the **Where** line to: `**Where:** social.grmc.app`
2. Add this section before **## Every week**:

```markdown
## Where drafts come from

Each event, department and series has a **Drafting** section on its page:

- **Source:** where material comes from. None; a Mailchimp newsletter (say
  which by text in its subject, such as "grace notes", and which issue to
  use); or a podcast episode from Buzzsprout.
- **Instructions:** what each post should do.
- **Background:** the event's notes, which Claude reads too.

**Draft with Claude** on any post uses its event's drafting. The editor shows
which issue or episode it will use. Click **Change** to pick another, or
**Paste content instead** if Mailchimp or Buzzsprout isn't reachable. A post
remembers the issue it was drafted from.

A post, or a recurring post, can have its own instructions under **Drafting
for this post**. The Saturday invite works this way: its instructions write an
invite, and each week's brief holds that Sunday's service details.

**Earlier drafts** in the editor lists every draft of a post. **Restore**
brings one back.

The weekly posts are set up like this already:

- **Grace Notes:** the newsletter issue for that week.
- **Sunday worship:** the Saturday invite, from the brief.
- **Weekly blog:** the latest blog email.
- **Podcast:** episodes.

## Planning several posts at once

- **Podcast:** on its event page, **Plan posts from an episode**. Pick the
  episode, tick the angles, and you get one post per angle on its day. Then
  **Draft all with Claude**.
- **Series:** on its event page, **Plan posts with Claude**. Claude proposes
  titles and angles; you edit them, save, and draft.

## Settings

Keys for Anthropic, Mailchimp, Buzzsprout, Metricool and image hosting, the
default post time, and the **house voice** (the rules every draft follows)
are in the **Settings** tab.
```

- [ ] **Step 3: Mark the spec implemented**

In `docs/superpowers/specs/2026-10-20-pipeline-as-main-app-design.md`, change the status line to `Date: 2026-10-20 · Status: implemented`.

- [ ] **Step 4: Full suite**

Run: `cd apps/social-posts && npx tsc -p . && TEST_DATABASE_URL=postgres://postgres:test@localhost:55432/socialposts npm test`
Expected: PASS, with 0 failures.

- [ ] **Step 5: Upgrade check against a pre-change database**

Build a database in the shape the host has today (iteration 3), then boot the new image on it:

```bash
docker exec grmc-pipeline-test psql -U postgres -qc "DROP DATABASE IF EXISTS hostcopy" -c "CREATE DATABASE hostcopy"
git stash -u   # only if the working tree is dirty; otherwise skip
git checkout HEAD~11 -- apps/social-posts   # the commit before Task 1 of this plan
docker build -q -f apps/social-posts/Dockerfile -t grmc-social-posts:before .
git checkout HEAD -- apps/social-posts
docker run -d --name grmc-before --network grmc-pl-test -e SOCIALPOSTS_DB_USER=postgres -e SOCIALPOSTS_DB_PASSWORD=test -e SOCIALPOSTS_DB_NAME=hostcopy grmc-social-posts:before
sleep 5; docker rm -f grmc-before
docker rm -f grmc-pl-app; docker build -q -f apps/social-posts/Dockerfile -t grmc-social-posts:pipeline-test .
docker run -d --name grmc-pl-app --network grmc-pl-test -p 3999:3000 -e SOCIALPOSTS_DB_USER=postgres -e SOCIALPOSTS_DB_PASSWORD=test -e SOCIALPOSTS_DB_NAME=hostcopy grmc-social-posts:pipeline-test
sleep 4; docker logs grmc-pl-app 2>&1 | grep -E "drafting profiles|rror"
curl -s localhost:3999/api/pipeline/events/run-sunday | grep -o '"name":"Sunday worship"'
```

Expected:
- The log shows `weekly runs set up as drafting profiles` with `"ran":true`, and no errors.
- The curl prints `"name":"Sunday worship"`.

If `HEAD~11` doesn't land on the pre-plan commit (count this plan's commits with `git log --oneline`), use that commit's hash instead.

- [ ] **Step 6: Browser regression pass**

With the Task 10 stand-ins mounted (rebuild and rerun as in Task 10 Step 6), run each check script from Tasks 8–11 again, plus this phone-width pass in `phone-check.js`:

```js
const { chromium, devices } = require('playwright');
(async () => {
  const b = await chromium.launch(); const errors = [];
  const ctx = await b.newContext({ ...devices['iPhone 13'], extraHTTPHeaders: { 'x-auth-email': 'me@grmc.org' } });
  const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(e.message));
  for (const v of ['dashboard', 'calendar', 'board', 'events', 'recurring', 'mine', 'settings', 'event/run-wednesday', 'event/run-podcast']) {
    await p.goto('http://localhost:3999/#' + v); await p.waitForTimeout(900);
    console.log(v.padEnd(20), 'overflow', await p.evaluate(() => document.documentElement.scrollWidth - innerWidth));
  }
  console.log('errors:', errors); await b.close();
})();
```

Expected: every view prints `overflow 0`, then `errors: []`.

- [ ] **Step 7: Clean up the throwaway containers**

```bash
docker rm -f grmc-pl-app grmc-pipeline-test; docker network rm grmc-pl-test
docker rmi grmc-social-posts:pipeline-test grmc-social-posts:before
docker pull -q node:20-alpine   # deleting test images can orphan BuildKit's cached base layer
```

- [ ] **Step 8: Commit**

```bash
git add README.md docs/content-pipeline-how-to.md docs/superpowers/specs/2026-10-20-pipeline-as-main-app-design.md
git commit -m "docs: Social Posts is the content pipeline; drafting profiles and planning"
```

**Rollout (for the person shipping it, not a code step):** back up the host database before `docker compose push`. Boot runs the drafting migration, and the old page no longer exists. Command: `docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -Fc socialposts' > ~/socialposts-before-drafting-$(date +%F).dump`.
