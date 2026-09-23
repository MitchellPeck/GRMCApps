# GRMCApps

A self-hosted "apps hub": a Traefik reverse proxy gates independent app
containers behind Google-OIDC login handled by a Fastify hub, backed by a
single Postgres with one database per app. It runs on one Docker host and is
reachable from anywhere via a Cloudflare Tunnel (outbound-only; no inbound
ports, no VPN), with real, publicly-trusted HTTPS and no per-device setup.

## Prerequisites

- Docker + Docker Compose
- A dedicated domain on **Cloudflare** (this project uses `grmc.app`)
- A Cloudflare API token scoped to **Zone → DNS → Edit** for that zone
- A Google OAuth 2.0 Web client with redirect URI `https://hub.grmc.app/auth/callback`
- The Docker host on a **static IP / DHCP reservation**

## Setup

1. **DNS (Cloudflare):** the four app hosts (`hub`, `whoami`, `social`,
   `approvals`) are **proxied CNAMEs** to the Cloudflare Tunnel, created by
   `cloudflared tunnel route dns` (see DEPLOY.md → *Cloudflare Tunnel*). This
   replaces the old LAN-only `A  *.grmc.app → <host LAN IP>` record.
2. **Environment:** `cp .env.example .env`, then set `BASE_DOMAIN` (`grmc.app`),
   `ACME_EMAIL` (a real address — Let's Encrypt rejects `example.com`),
   `CF_DNS_API_TOKEN`, the `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`, and the
   password/secret fields.
3. **Run:** `docker compose up -d --build` — Traefik obtains a trusted
   `*.grmc.app` certificate from Let's Encrypt via the Cloudflare DNS-01
   challenge (no inbound internet access required).

> Moving an existing installation to another Mac? See DEPLOY.md → *Moving the
> stack to a new Mac* — it carries the data, secrets and tunnel over instead of
> starting fresh.

Every host below then loads with trusted HTTPS from anywhere through the
Cloudflare Tunnel, with no per-device certificate install.

> The domain is driven entirely by `BASE_DOMAIN`. Hosts are `hub.<BASE_DOMAIN>`
> and `<subdomain>.<BASE_DOMAIN>` per app; changing `BASE_DOMAIN` re-points
> everything with no other edits.

## URLs

- Hub dashboard: https://hub.grmc.app
- whoami app:    https://whoami.grmc.app
- Social Posts:  https://social.grmc.app
- Approvals:     https://approvals.grmc.app
- Meeting Minutes: https://minutes.grmc.app
- Expenses:        https://expenses.grmc.app
- Narthex TV:      https://tv.grmc.app
- Traefik dashboard (host-local only): http://localhost:8080

## Apps

Every app shares one design system (`shared/ui/grmc.css`) and one header:
the wordmark links back to the hub and an **Apps** switcher jumps straight
between apps. Both are served to each app at `/assets/` (see *Shared UI* below).

- **whoami** (`whoami.grmc.app`) — validation app echoing identity headers.
- **Social Posts** (`social.grmc.app`) — drafts GRMC social posts with Claude,
  pulls Grace Notes / blog from Mailchimp, manages multi-week post series. Three
  runs: **Wednesday** (Grace Notes post + Saturday invite), **Friday** (weekly
  blog post) and **Podcast** (below). Configure the Anthropic + Mailchimp keys
  in its Settings tab (stored in the `socialposts` database). Source ported
  from the Apps Script tool in `docs/reference/social-posts/`. Send drafted
  posts straight to Metricool as scheduled drafts on Facebook, Instagram and X
  (Settings → Metricool: API token + User ID + Blog ID via 'Load brands'). A
  post with an associated weekday opens the scheduler on that day of the
  current week, and a podcast post on the episode's own date. You can attach an
  image by **uploading one** or by picking an **approved graphic from the
  Approvals app** — either is published to a public Cloudflare R2 URL so
  Metricool can fetch it (Settings → Image hosting). Requires the Metricool
  Advanced plan.

  **Podcast run.** Promote an episode straight from Buzzsprout (Settings →
  Podcast: paste an API token from Buzzsprout's *Profile → API*, then **Load
  podcasts** and pick the show). The Podcast tab lists recent episodes newest
  first and fills in the title, show notes and listen link — all editable, and
  all paste-able by hand if you would rather not pull from Buzzsprout at all.
  Episodes that **have not dropped yet** are listed too and clearly marked, so
  you can line posts up ahead of a release; Claude is told not to announce an
  unreleased episode as though it is already out. Tick the **angles** you want
  for that episode — announcement, the question it wrestles with, a pull quote,
  a guest or topic spotlight, an invite to Sunday — and each one is drafted as
  its own post. Podcast posts are scheduled from the **episode's publish date**
  rather than the current week, so an episode landing three weeks out gets posts
  three weeks out.
- **Approvals** (`approvals.grmc.app`) — request and grant sign-off on graphics.
  Submitters upload an image and pick an approver from a roster (managed in
  Settings); the approver approves, rejects, or requests changes. Change
  requests bounce back to the submitter, who uploads a new version. Every
  version and decision is kept; data and image bytes live in the `approvals`
  database.
- **Meeting Minutes** (`minutes.grmc.app`) — run a meeting end-to-end and get
  AI minutes. Maintain a reusable **library of people**; create a **meeting**,
  **upload its agenda** (PDF, image, or text) which Claude extracts into an
  ordered list of items, and pick which people are **present**. Then work down
  the agenda: for each item choose the presenter(s), **record** the discussion
  (or upload a recording) — on stop it is transcribed **with speaker
  diarization**, labeling who is speaking; you map each detected voice to an
  attendee (auto-mapped when there's a single speaker and one presenter). Add
  optional typed notes, then **summarize** the item — Claude writes the minutes
  and **infers action items** from natural phrasing ("we need to…", "Bob will
  follow up…"), each with an owner. Finally **generate a report**: full minutes
  with per-item summaries and one consolidated, owner-attributed action-item
  checklist. Transcription runs on a **self-hosted Whisper service** with
  diarization (the `whisper` container) — no API key, no per-minute cost, and
  audio never leaves the host. Add only the Anthropic key (for
  extraction/summaries/report) in Settings; everything is stored in the
  `meetingminutes` database.
  
  Transcription speed is tuned through the `whisper` service in
  `docker-compose.yml`, and every value can be overridden from `.env` without a
  rebuild: `WHISPER_MODEL` (default `small.en`), `WHISPER_THREADS` (default
  `6`, sized for an 8-core host), `WHISPER_BEAM` (default `1`, greedy),
  `WHISPER_COMPUTE_TYPE` (default `int8`), and `WHISPER_DIARIZE_THRESHOLD`
  (default `0.7` — raise it if one person is still split across several
  speakers, lower it if two people are being merged). Changing `WHISPER_MODEL`
  triggers a one-time model download into the `whisperdata` volume, so the
  first transcription after that change is slow.

- **Narthex TV** (`tv.grmc.app`) — what plays on the announcement screen in the
  narthex, and when. Upload **photos, videos and PowerPoints**, group them into
  **playlists**, and put a playlist on the screen. There is no sound anywhere in
  this app by design: the audio track is stripped from every video at upload.

  **Scheduling** has three shapes. *Between two dates and times* plays for that
  window and then gets off the screen. *From a date and time, until something
  else is scheduled* is the standing content — it keeps playing indefinitely,
  and is replaced only when a later open-ended entry starts. *Every week, on
  chosen days, between two times* covers the Sunday-morning slot; it is written
  in the app's timezone and follows the clock through daylight saving, so 08:00
  stays 08:00. A timed entry temporarily borrows the screen from the standing
  content and hands it back when it ends, and `priority` breaks a tie when two
  overlap. When nothing at all applies, a **default playlist** (Settings) plays.
  The **On now** tab says what is showing and why, and will answer the same
  question for any future moment — you can check a Sunday morning before it
  happens.

  **Everything is converted once, at upload.** A PowerPoint (or Keynote export,
  or ODP, or PDF) goes through headless LibreOffice to PDF and then to one
  image per slide, each with its own on-screen duration. A video is probed with
  ffmpeg and re-encoded to H.264/MP4 without audio unless it already is one.
  A HEIC or TIFF becomes a JPEG. The TV therefore only ever shows a picture or
  plays a plain MP4 — it never renders a document and never meets a codec it
  does not know. Conversions run one at a time on a queue that survives a
  restart, and the media grid shows each upload settling from *converting* to
  ready on its own.

  **The player** is one full-screen web page per screen, at
  `tv.grmc.app/player?t=<token>`, opened in the television's own browser. It
  asks the server every ten seconds what to show, keeps playing through a
  network outage, comes back on its own, and reloads itself once a day. It is
  the one surface in the whole stack that sits **outside** the hub's Google
  sign-in — a television cannot complete an OAuth flow — so it is gated on a
  per-screen token instead, created and reissued under **Screens**. That tab
  also shows each display's last check-in, which is the first place to look when
  someone says the TV is stuck. The player deliberately avoids anything newer
  than roughly Chromium 60 on its rendering path, because a TV browser is an old
  Chromium fork.

  **Or straight out of a Blackmagic card.** `scripts/narthex-tv/playout.py`
  drives a DeckLink/UltraStudio from the Mac with no browser and no OBS: one
  long-lived ffmpeg owns the device and a feeder decodes one item at a time
  into it, so the signal is never interrupted (`ffmpeg -f decklink` closes the
  card when its input ends, which is why a process per slide would make the TV
  re-sync between every photo). It reads the same `/api/player/plan`, so there
  is no second copy of the scheduling logic to drift, and a change cuts in
  mid-item rather than waiting for a re-render. See
  `scripts/narthex-tv/README.md` for both paths and the per-set caveats.

  **Announcements without PowerPoint.** Write a slide in the app — headline,
  detail, footer line, one of four colourways drawn from the church's own
  palette — and it is rasterised server-side into the same JPEG an upload
  becomes. Editing one redraws it **in place**, so every playlist already using
  it keeps working. It has to be rendered on the server rather than by the
  player, because the narthex screen is driven through a Blackmagic card by
  `playout.py`, which decodes pictures and video and cannot render HTML.

  **Import from Approvals.** A graphic already signed off in the Approvals app
  can be pulled straight onto the screen over the internal network, with the
  signed-in user's identity forwarded so Approvals applies its own rules — no
  exporting, re-uploading, or reaching into another app's database.

  **Retiring itself.** Each playlist item takes an optional inclusive
  show-from / show-until date, judged in the app's timezone, so a notice comes
  down the day after the event instead of waiting for somebody to remember. The
  editor says what that means today — "expires in 4 days", "last day".

  **Emergency takeover.** One message, on the screen immediately, over
  everything scheduled and over the operating hours — a dark screen is no use
  to somebody being told to evacuate. Drawn by the player as text rather than
  going through the conversion queue, so it cannot be held up by it, and
  clearing it puts the schedule straight back.

  **Operating hours.** The screen does not have to be on all day. Settings takes
  a weekly grid of windows in the app's timezone; outside them the player shows
  true black and tears the media down rather than decoding frames nobody is
  watching. Windows that touch or overlap are one stretch, so the screen never
  blinks off between a morning and an afternoon; an end earlier than its start
  runs past midnight; and an empty grid means "not configured" rather than "stay
  dark". Separately and optionally, a **power action** — a web request or a
  Wake-on-LAN packet — fires at each boundary, so a TV or smart plug that
  answers on the network can actually be switched. Both can be fired by hand
  from Settings with the result shown, and the last attempts are logged.

  **Configurable** without a rebuild: timezone, seconds per photo and per slide
  (app-wide, per playlist, or per item), crossfade or cut, fit-or-fill,
  background colour, an optional clock and footer line, portrait rotation, how
  often the TV checks in, and what to show when nothing is scheduled.
  **Permissions** are per-app on top of the hub's: upload, schedule (implies
  upload), manage (anyone's media, plus screens) and admin (permissions and
  settings only). Data lives in the `narthextv` database; the media bytes live
  on the `narthextvdata` volume.

- **Expenses** (`expenses.grmc.app`) — expense requests, approvals and records.

  **Two dimensions.** Every request says *when* (already purchased, or asking
  approval first) and *how it was paid* (a church card, or your own money to be
  reimbursed). Those are independent, and together they decide what the form
  asks for: a card only for church-card spending, an estimate only before a
  purchase, receipts only after one, and a reimbursement step only when someone
  is owed money.

  **Receipts.** Upload receipt PDFs and Claude reads each one separately (in
  parallel) into line items, vendor, shipping, tax and discounts, then writes a
  short reason and picks a charge code, validated against the taxonomy so an
  invented code never lands on the form. Shipping, tax and discounts are
  combined across receipts into one line each in plain arithmetic, not by the
  model. Receipts that are scans or images work too: each PDF is converted to
  markdown first, and any document whose markdown carries no currency amount is
  re-sent to Claude as the PDF itself — without that, a browser-printed invoice
  like Sweetwater's extracts nothing and fails silently. Uploaded receipts are
  kept and shown to the approver; the generated PDF still carries the clean
  itemized list rather than receipt scans, because that is what prints and files.

  **Approvals.** A request goes to a named approver, who approves, rejects or
  requests changes with a comment. Every action is recorded on a timeline with
  who and when. **Nobody can approve their own request** unless an administrator
  deliberately turns that on in Settings. The **paper path is kept** for the
  transition: someone with approve rights records a paper approval with its
  date, so paper-era and digital requests sit in one log correctly labelled —
  every request that predates the digital workflow was migrated as exactly that.

  **Completion.** An approved pre-purchase request is closed out with the actual
  amount and receipts. If the actual exceeds the estimate by more than the
  greater of the two tolerances in Settings (10% or $25 by default), it goes
  back to the approver with both figures shown. Reimbursements are marked paid,
  with a date and reference, by anyone with manage rights.

  **Permissions** are per-app, on top of who the hub lets in: submit, submit on
  another's behalf, edit own, approve, manage (implies approve; acts on
  anyone's requests and edits charge codes) and admin (permissions, cards and
  settings only — it grants no expense rights of its own). Each person can have
  a default approver. The last administrator cannot be removed, and
  `mitchell.peck@graceresurrection.org` is restored if there is ever none.

  **Cards** hold a nickname, the last four digits (never a full number), a
  primary holder and additional users. *Charged to which card* is a dropdown of
  the cards that person may actually use.

  **Reports** (manage only): spend by charge code over a date range, and a CSV
  export for bookkeeping. Data lives in the `expenses` database.

## Users and access

GRMC Apps is invite-only. A Google sign-in succeeds only if an account already
exists for that address, and each account is granted apps one at a time.

- **Users screen:** https://hub.grmc.app/admin/users (administrators only; the
  **Users** link appears in the hub header).
- **Adding someone:** enter their email and, optionally, a display name. No mail
  is sent — the account simply works the next time they sign in with Google,
  which is also when their real name and Google identity are attached. Until
  then the row shows as **Invited**.
- **Granting apps:** tick the app's column on that person's row. Changes take
  effect on their next page load; nothing waits for a session to expire.
- **Administrator** grants the Users screen **only**. It does not grant any app —
  an administrator still needs each app ticked like anyone else.
- **Disable vs delete:** disabling locks the account out immediately but keeps
  its grants for when you turn it back on. Deleting removes the account and its
  grants; that person would have to be invited again.
- **You cannot remove the last active administrator** — demote, disable and
  delete are all refused with an explanation.
- **First run:** on a fresh database the account
  `mitchell.peck@graceresurrection.org` is created as an administrator holding
  every app, so there is always a way in. If every administrator is ever
  removed, that account is restored on the next hub restart.
- **Existing installs:** the first time the hub starts with user management, every
  account already in the database keeps access to every app that existed at that
  moment, so nobody is locked out by the upgrade. Prune from the Users screen.

The schema is applied by the hub on boot (`hub/src/users/provision.ts`), not by
`db/init/`, because those files only run on a fresh Postgres volume and can
never reach a live database.

## Adding an app

1. Create `apps/<name>/` (its own container listening on port 3000).
2. Add a `<name>` database in `db/init/01-databases.sh`.
3. Add a row to `apps` in `db/init/02-hub-schema.sql` (`slug`, `name`,
   `subdomain` = `<name>`), which the hub serves at `<name>.${BASE_DOMAIN}`.
4. Add a service to `docker-compose.yml` with the Traefik labels —
   ``Host(`<name>.${BASE_DOMAIN}`)``, `tls=true`, and the
   `hub-forward-auth@file` middleware (copy the `whoami` service).
5. Copy the shared UI into the image and load it on the page (see below). The
   app then appears in every other app's switcher automatically.
6. Grant the app to whoever needs it on https://hub.grmc.app/admin/users — a new
   app starts with **no** grants, so it is invisible until someone is ticked
   into it (including you).

## Shared UI

`shared/ui/` is the single source of truth for how the apps look and how you
move between them:

- `grmc.css` — design tokens and the shared component vocabulary (header,
  tabs, cards, forms, buttons, alerts, badges).
- `grmc-nav.js` — links the header wordmark home to the hub and injects the
  **Apps** switcher. It reads the live registry from the hub's `/api/apps`
  (session-authenticated, and readable only from our own subdomains), falling
  back to a built-in list if the hub is unreachable.

Each app's Dockerfile copies both into `src/public/assets/`, and each page
loads `/assets/grmc.css` plus `/assets/grmc-nav.js`. The switcher needs no
per-app configuration: it derives the base domain from the host it is served
from, and marks the current app by matching its subdomain.
