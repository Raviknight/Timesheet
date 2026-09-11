# DECISIONS.md

Architectural decisions and the reasoning behind them. Append, don't rewrite.
When you reverse a decision, mark the old entry "Superseded by D-N" rather
than deleting it.

## D-1: Hybrid ES modules + bundle for distribution

**Date:** May 18, 2026
**Status:** Active

We develop with ES modules under `src/` for clarity and maintainability. For
distribution we bundle to a single self-contained `dist/timesheet.html` using
esbuild. This gives us:

- Clean separation in dev
- One file to email or drop onto a USB stick for non-technical users
- Works equally well on GitHub Pages (serves the bundled file) or
  double-clicked locally (also serves the bundled file)

**Alternatives considered:**

- Plain `<script>` tags with a global namespace. Rejected: doesn't scale past
  ~10 files, no tree shaking, error-prone refactors.
- ESM-only with `<script type="module">`. Rejected: breaks when users
  double-click the HTML file (file:// blocks module loading in browsers).

## D-2: Vanilla JS, no framework

**Date:** May 18, 2026
**Status:** Active

The current scope (timesheet for one person, scaling to small teams) does not
need React/Vue/Svelte. Hand-rolled state + manual rerendering is plenty.

**Reconsider when:** views start sharing significant state, or when we hit
~5000 lines of UI code, whichever comes first.

## D-3: Storage abstraction layer

**Date:** May 18, 2026
**Status:** Active

All persistence goes through `src/data/storage.js`. Callers never touch
`window.storage` or `localStorage` directly. This lets us swap the backend
(IndexedDB, REST API, Supabase) without rewriting the app.

## D-4: Schema versioning + migrations

**Date:** May 18, 2026
**Status:** Active

`src/data/schema.js` has `SCHEMA_VERSION` and `migrate(data, fromVersion)`.
Every time the data shape changes:

1. Bump `SCHEMA_VERSION`
2. Add a step to `migrate()`
3. Test against existing exports

Already used once: v0 → v1 added `segments[]` array, replacing flat
`clockIn`/`clockOut` fields.

## D-5: Role scaffolding now, enforcement later

**Date:** May 18, 2026
**Status:** Active

`src/auth/roles.js` defines capabilities (`canEditEntries`, `canViewTeam`,
etc.) and the profile already has a `role` field. Today every user is
`owner`. The UI doesn't yet check capabilities, but the structure is in
place so multi-tenant rollout is a matter of wiring, not refactoring.

## D-6: Bi-weekly anchor stored even when system is something else

**Date:** May 18, 2026
**Status:** Active

`settings.biweeklyRef` and `settings.anchorDate` are kept around even when
`settings.system` is `weekly` or `semimonthly`. Cost is trivial (two date
strings), benefit is users can switch systems back without re-entering data.

## D-7: 15-minute time rounding

**Date:** May 18, 2026
**Status:** Active

Clock in/out times are rounded to the nearest 15 minutes before subtraction.
Matches the original Excel `ROUND(t*96,0)/96` logic exactly. This is a
business rule (Ravi's employer rounds to quarter hours), not a display
preference.

## D-8: Per-segment break logic

**Date:** May 18, 2026
**Status:** Active

For multi-segment days, the 30-minute break is deducted **per segment**, only
when that segment exceeds 5 hours, and only on weekdays. So 7-11 (4h) + 13-17
(4h) = 8h total (no deduction). A single 7-14 (7h) = 6.5h.

If a segment includes an explicit break-start/break-end pair, that explicit
break is used instead of the default 30 minutes.

## D-9: GitHub Pages as primary hosting

**Date:** May 18, 2026
**Status:** Active

Free, supports custom domains, deploys on push, no commercial-use restrictions.
README has the deployment guide. Cloudflare Pages is the backup option if we
outgrow GitHub Pages' build/bandwidth limits.

**Reconsider when:** we add a backend (then move frontend to Cloudflare Pages
and put Workers/D1 alongside).

## D-10: Supabase as the backend, RLS as the security boundary

**Date:** September 11, 2026 (recorded at the close of Phase 3)
**Status:** Active

Phase 3 replaced localStorage with Supabase as the source of truth for a
signed-in user. `src/data/storage.js` keeps the D-3 abstraction: `Store`
dispatches to `RemoteStore` when a session exists and `LocalStore` otherwise,
so the rest of the app never learns which one it is talking to.

The anon key ships in the client, hardcoded in `src/data/supabase.js`. That is
deliberate, not an oversight. It is a public identifier; Row-Level Security
policies in the database are the actual boundary. This is why the planned
"add SUPABASE_ANON_KEY as a GitHub secret" tasks in Steps 8 and 10 were both
dropped: a secret would imply a protection it does not provide, and would add
a second place for the value to drift out of sync.

**Reconsider when:** the app takes on a second tenant. Multi-employee data with
supervisor approval needs the RLS policies re-derived from scratch, not
extended. A policy set written for "one user sees their own rows" does not
generalize to "a supervisor sees their reports' rows" by adding clauses.

## D-11: Writes diff against a load-time snapshot

**Date:** September 11, 2026 (recorded at the close of Phase 3)
**Status:** Active

Entries, pays, companies and time_off_types are written by diffing the current
state against a snapshot captured when that key was last read, so a save sends
only what changed instead of replacing the table.

The consequence worth knowing: **a write is only safe if the snapshot is real.**
`RemoteStore.set` refuses outright when there is no load-time cache for the
key, rather than falling back to a full write. Without that guard, a failed
read followed by a save would diff real data against an empty fallback and
push deletions for every row.

This is also why the offline cache (D-12) refuses writes for stale keys. The
two guards cover the same hazard from opposite ends: one catches a missing
snapshot, the other catches a snapshot that exists but no longer reflects the
server.

**Reconsider when:** offline editing becomes a requirement. A write queue would
need real conflict resolution, because replaying a queued diff against a
snapshot the server has moved past is how data gets lost rather than merely
shown stale.

## D-12: Offline reads serve a cache, offline writes are refused

**Date:** September 11, 2026
**Status:** Active

Successful remote reads mirror into localStorage under
`ts:cache:<userId>:<key>`. A read that fails serves that mirror instead of the
empty fallback, and the key is marked stale.

The failure this exists to prevent is specific and already happened. Remote
reads swallow their errors and return the caller's fallback, normally an empty
object, so "the server says nothing" and "the server is unreachable" were the
same value. In July a cold-start burst made several boot reads fail, and the
live site rendered a full account as an empty shell.

Stale keys refuse writes (see D-11), the top bar says "offline, showing saved
copy" rather than "synced", and a warning toast explains the state on load. An
app displaying stale pay figures has to say so.

Deliberately excluded: an offline write queue. Showing stale data is
recoverable; replaying stale writes is not.
