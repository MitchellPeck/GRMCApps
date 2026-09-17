# User Management — Design

**Date:** 2026-09-17
**Status:** Approved for implementation
**Scope:** Hub only. No app container changes.

## Problem

Anyone with a Google account can sign in to GRMC Apps and reach every app.
Two lines cause it:

- `hub/src/auth/routes.ts` — the OIDC callback does
  `INSERT INTO users ... ON CONFLICT (google_sub) DO UPDATE`, creating an
  account for whoever shows up (just-in-time provisioning).
- `hub/src/auth/routes.ts` — `/auth/verify` carries the comment
  `v1: any authenticated user may access any enabled app` and emits a
  hardcoded `X-Auth-Roles: "user"`.

We want the inverse: accounts exist only because an administrator created
them, each account is granted named apps, and some accounts may administer
other accounts.

## Decisions

| Question | Decision |
|---|---|
| Existing accounts in the live DB | Grandfathered: every current row keeps access to every current app; only the bootstrap address gets `is_admin` |
| What `is_admin` grants | User management **only**. An admin's own app access is granted row-by-row like anyone else's |
| Admin over other admins | Full: create, promote, demote, delete — with a last-active-admin guard rail |
| Bootstrap account | `mitchell.peck@graceresurrection.org`, hardcoded in the repo (not an env var) |
| Bootstrap app access | All apps enabled at seed time |
| Creating a user | Email (required) + display name (optional) |
| Removing access | Both **disable** (reversible lockout, grants preserved) and **delete** (row removed) |
| Access model | Direct grants via a `user_app_access` join table |
| Schema delivery | Idempotent boot DDL in the hub, matching the pattern every app already uses |

### Rejected alternatives

- **Roles/groups** (`roles` → `role_apps` → `user_roles`). Three tables and a
  second management screen to express what, at this org's size, you would
  assign per person anyway. `user_app_access` remains the effective-permission
  table if groups ever become real, so this stays cheap to add later.
- **A boolean column per app on `users`.** Every new app would become a schema
  migration — precisely the friction the README's "Adding an app" flow avoids.
- **Admin implies all apps.** Rejected so that appointing an account manager
  does not hand over Approvals and Meeting Minutes data, and so new apps are
  never silently granted to anyone on creation.

## Data model

Hub database. All DDL is idempotent and runs on hub boot.

### `users` (existing table, altered)

```sql
ALTER TABLE users ALTER COLUMN google_sub DROP NOT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin   boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS active     boolean NOT NULL DEFAULT true;
ALTER TABLE users ADD COLUMN IF NOT EXISTS invited_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE users ADD COLUMN IF NOT EXISTS invited_by uuid REFERENCES users(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx ON users (lower(email));
```

`google_sub` becomes nullable because an invited account has no Google identity
until its first sign-in. Its `UNIQUE` constraint is retained and remains
correct — Postgres treats NULLs as distinct, so any number of pending invites
coexist.

`lower(email)` becomes the invite key and must be unique. **Pre-flight risk:**
if the live `users` table already holds two rows whose emails differ only by
case, this index fails and the hub refuses to start with a clear error. One
Google account has one `sub` and one email, so duplicates are not expected;
the failure is loud rather than silent because an ambiguous invite target is
worse than a failed boot.

### `user_app_access` (new)

```sql
CREATE TABLE user_app_access (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app_id     uuid NOT NULL REFERENCES apps(id)  ON DELETE CASCADE,
  granted_at timestamptz NOT NULL DEFAULT now(),
  granted_by uuid REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (user_id, app_id)
);
```

A row means access. Absence means denial. Both cascades are deliberate:
deleting a user drops their grants, and retiring an app drops grants naming it.

## Migration and bootstrap

Four steps run on every hub boot, in this order. Only step 3 is one-time.

**1. Probe, before any DDL.** Read `to_regclass('user_app_access')` and record
whether it was `NULL`. This must happen *first* — step 2 creates the table, so
probing afterwards would always report "already present" and the backfill would
never run.

**2. Base DDL** — the `ALTER`/`CREATE INDEX` statements above, plus
`CREATE TABLE IF NOT EXISTS user_app_access`. Safe on every boot.

**3. Grandfather backfill — structurally once-only.** Runs only when step 1
found the table absent, meaning the hub is meeting this database for the first
time. It:

- inserts `users CROSS JOIN apps` into the new table, and
- sets `is_admin = true` on the row whose `lower(email)` matches the bootstrap
  address.

Re-running this on every boot would be a live bug, not just waste: an account
you had deliberately stripped of an app would silently regain it on the next
`docker compose up`. Tying the backfill to the table's creation makes a second
run impossible by construction rather than by a flag someone can clear.

**4. Bootstrap admin repair — idempotent, every boot.** If no active admin
exists, the bootstrap address is created (if absent) or promoted (if present),
then granted every enabled app. One routine covers three situations:

- *Fresh database:* `users` is empty, so the account is created as an invited
  admin holding all apps — you can sign in to a new stack and work.
- *Live database, post-grandfather:* step 3 already promoted the account, an
  active admin exists, so this is a no-op.
- *Disaster:* the last admin was deleted outside the guard rails; access is
  restored on restart instead of requiring `psql` on the host.

Because the trigger is "zero active admins" rather than "always assert", an
admin you intentionally demote **stays** demoted as long as another admin
remains.

The bootstrap address is a constant in the hub source rather than in
`db/init/*.sql`. The intent of "hardcoded, not an env var" is preserved — the
address lives in the repo — while keeping one source of truth, since the
`db/init` files cannot reach an already-provisioned volume anyway.

## Login flow

`/auth/callback`, after Google returns verified claims:

1. Look up by `google_sub = claims.sub`.
   - **Found** → refresh `email`, `name`, `last_login`. Continue to step 3.
2. Not found → look up by `lower(email) = lower(claims.email)`.
   - **Found, `google_sub IS NULL`** → first sign-in of an invited account.
     Bind the `sub`, store the Google name, set `last_login`.
   - **Found, `google_sub` set and different** → reject. This email is already
     bound to a different Google identity; log a warning.
   - **Not found** → reject. Not provisioned.
3. `active = false` → reject.
4. Otherwise regenerate the session and set `session.userId`.

Every rejection destroys the session before redirecting, so a denied visitor
never holds one. Rejections redirect to `/?error=no_access`; the login page
renders "Your account isn't set up for GRMC Apps" and shows the address that
was attempted, so the visitor can quote it when asking for access.

The decision is extracted as a pure function over `(existingBySub,
existingByEmail, claims)` returning an allow/deny verdict, so every branch above
is unit-testable without a database or a Google round trip.

## Access enforcement

`/auth/verify` is the single chokepoint — Traefik's `forwardAuth` sends every
request for every app through it before routing. Enforcement goes here and
nowhere else.

The current implementation issues two queries (`getAppBySubdomain`, then
`getUser`). It is replaced by **one** query joining `apps`, `users` and
`user_app_access`, so adding authorization does not add a round trip to the
gateway hot path.

Order of checks, each with a distinct response:

1. No session → redirect to login with the original URL as `redirect` (unchanged).
2. Unknown or disabled app → 403.
3. Unknown or **disabled** user → 403.
4. No `user_app_access` row for this (user, app) → 403.
5. Otherwise 200 with the identity headers.

**Admins do not bypass check 4** — that is what "admin manages users only" means.

Denials return a small styled HTML page (`denied.ejs`) using the shared design
system with a link back to the hub, not the current bare text, since Traefik
returns the hub's response body straight to the browser.

`X-Auth-Roles` becomes `admin` or `user` instead of the hardcoded `user`. No
Traefik change is needed: `traefik/dynamic` already lists all four `X-Auth-*`
headers under `authResponseHeaders`, which is what prevents client spoofing.

## Dashboard and app switcher

`listEnabledApps()` is joined against grants to become "enabled **and** granted
to this user":

- **Dashboard** (`/`) shows only granted apps, with an empty state ("No apps
  yet — ask an administrator") when there are none. Admins additionally get a
  **Users** link in the header.
- **`/api/apps`** — the cross-app switcher every app header renders — filters
  identically. This matters: an unfiltered switcher would advertise apps that
  answer 403, which reads as a broken system rather than a permissions one.

## Admin UI

Lives on the hub at `/admin/users`, guarded by a `requireAdmin` hook (live
session, `active`, `is_admin`). Non-admins get the same 403 page.

A **users × apps matrix**: one row per user, one checkbox column per enabled
app, plus Admin and Active toggles and a delete action. At this org's scale
(order of ten people, five apps) the entire permission state is legible on one
screen, which a per-user detail page would hide. Each toggle saves immediately
via `fetch` and confirms inline.

Each row also shows status — **Active**, **Disabled**, or **Invited** (created
but never signed in, i.e. `google_sub IS NULL`) — and last login.

### Routes

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/admin/users` | The page |
| `GET` | `/api/admin/users` | Users, apps and grants as JSON |
| `POST` | `/api/admin/users` | Create `{email, name?}` |
| `PATCH` | `/api/admin/users/:id` | `{is_admin?, active?, name?}` |
| `PUT` | `/api/admin/users/:id/apps/:appId` | Grant |
| `DELETE` | `/api/admin/users/:id/apps/:appId` | Revoke |
| `DELETE` | `/api/admin/users/:id` | Delete |

### Guard rails

- **Last active admin.** Demoting, disabling or deleting the final active admin
  returns 409 with an explanatory message. Implemented as a pure function over
  the current admin set and the proposed change, so all three paths share one
  tested rule and it cannot drift between them.
- **Email validation.** Trimmed, shape-checked, and rejected as 409 if
  `lower(email)` already exists.
- **Origin check** on all mutating routes, in addition to the session cookie's
  existing `SameSite=Lax` (which already prevents cross-site POSTs from
  carrying it). Cheap belt-and-braces on the one surface that hands out access.

## Error handling

| Situation | Response |
|---|---|
| Un-provisioned Google account signs in | Session destroyed, redirect to login with `no_access`, page names the attempted address |
| Disabled account signs in | Same path, message distinguishes disabled from unknown |
| Email bound to a different Google `sub` | Rejected, warning logged with both subs |
| Granted user, disabled app | 403 (app-level, unchanged) |
| Authenticated user, no grant | Styled 403 with a link back to the hub |
| Non-admin hits `/admin/*` | Same styled 403 |
| Last-admin change attempted | 409, change refused, nothing written |
| `users_email_lower_idx` cannot be created | Hub fails to start with the conflicting addresses logged |

Revocation is effective immediately: `/auth/verify` reads the database on every
request, so removing a grant or disabling an account locks the user out on
their next page load without waiting for a session to expire.

## Testing

Following the repo's existing pattern (`node --test` over compiled JS, pure
functions extracted and tested hard, no database in tests):

- **Login decision** — invited first sign-in binds the sub; unknown email
  rejected; disabled account rejected; email bound to a different sub rejected;
  returning user refreshed.
- **Access decision** — granted allows; missing grant denies; disabled user
  denies; disabled app denies; admin without a grant still denies.
- **Last-admin guard** — demote/disable/delete of the sole active admin all
  refused; each allowed when a second active admin exists; a *disabled* admin
  does not count toward the quorum.
- **Email normalization/validation** — trimming, case folding, shape.
- **Role header** — `admin` for admins, `user` otherwise.

Existing `host.test.ts`, `hub-urls.test.ts` and `session-store.test.ts` must
keep passing untouched.

## Out of scope

- Invite emails. Nothing in the stack sends mail; creating an account simply
  means that person's next Google sign-in succeeds.
- Unifying per-app rosters (e.g. the Approvals approver roster) with hub users.
  Those are app-domain data, not access control.
- Groups/roles, audit log UI, self-service access requests.
