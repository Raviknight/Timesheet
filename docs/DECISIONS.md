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
