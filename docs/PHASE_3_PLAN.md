# PHASE_3_PLAN.md

The plan for migrating Time Sheet from a personal browser-storage app to a
real multi-tenant SaaS with Supabase backend and email/password auth.

This is a multi-session build. Each session picks up where the last left off.
**Update the "Status" line of each step as you complete it.**

## Goal

Public SaaS at `https://raviknight.github.io/Timesheet/` where:

- Anyone can sign up with email + password
- Email verification required before first login
- Each user gets a personal workspace (one company per user by default)
- Users can only see their own data (enforced at database level via RLS)
- Demo data shown to logged-out visitors (so app looks alive)
- Architecture supports multi-tenant employer expansion later (Phase 4+)

## Decisions locked in this session

| Decision | Choice |
| --- | --- |
| Backend | Supabase (Postgres + Auth + RLS). Confirmed over Turso/D1: minimum code, single service, project already provisioned |
| Auth provider | Supabase Auth, email + password |
| Signup | Open to anyone |
| Email verification | Required |
| Workspace model | Companies table from day 1, one per user initially |
| Demo data | Fake seed shown to logged-out visitors only |
| Deploy | GitHub Actions building to GitHub Pages |
| Real personal data | Imported via one-time JSON import on each device |
| Inactivity handling | GitHub Action pings Supabase every 3 days (Step 10) |
| Scope | Personal-use-first: SaaS scaffolding stays in code, demo seed + polish deferred |

## High-level architecture

```
┌────────────────────────────────────────────────────────────┐
│              raviknight.github.io/Timesheet                │
│  (static site, built via GitHub Actions)                   │
│                                                            │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  Logged out: demo data, login/signup forms           │  │
│  └──────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  Logged in: real app, data from Supabase             │  │
│  └──────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────┘
                              ↕  (HTTPS, JWT-authenticated)
┌────────────────────────────────────────────────────────────┐
│                       Supabase                             │
│  ┌────────────────────┐  ┌────────────────────────────┐    │
│  │  auth.users        │  │  Postgres + RLS policies   │    │
│  │  (managed by SB)   │  │  profiles, companies,      │    │
│  │                    │  │  entries, pays, settings,  │    │
│  │                    │  │  time_off_types            │    │
│  └────────────────────┘  └────────────────────────────┘    │
└────────────────────────────────────────────────────────────┘
```

## Database schema

```sql
-- Profiles: 1-to-1 with auth.users
create table profiles (
  user_id uuid primary key references auth.users on delete cascade,
  name text,
  role text default 'owner' check (role in ('owner','employee','supervisor','admin')),
  active_company_id uuid references companies(id),
  created_at timestamptz default now()
);

-- Companies: each user gets one default company on signup
create table companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner_user_id uuid references auth.users not null,
  created_at timestamptz default now()
);

-- Company members: future-proof for multi-tenant
create table company_members (
  company_id uuid references companies(id) on delete cascade,
  user_id uuid references auth.users on delete cascade,
  role text default 'owner' check (role in ('owner','admin','supervisor','employee')),
  joined_at timestamptz default now(),
  primary key (company_id, user_id)
);

-- Settings: 1-to-1 with user (per-user settings, not per-company yet)
create table settings (
  user_id uuid primary key references auth.users on delete cascade,
  data jsonb not null default '{}',
  updated_at timestamptz default now()
);

-- Time-off types: scoped per company (so different companies can have
-- different PTO rules; today, each user has one company)
create table time_off_types (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references companies(id) on delete cascade,
  code text not null,
  label text not null,
  pool_days numeric default 0,
  hours_per_day numeric default 8,
  counts_against_pool boolean default false,
  shared_pool_with text,
  unpaid boolean default false,
  unique (company_id, code)
);

-- Entries: time entries, scoped per user
create table entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users on delete cascade,
  company_id uuid references companies(id) on delete cascade,
  date date not null,
  segments jsonb not null default '[]',
  time_off text,
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (user_id, company_id, date)
);

-- Pays: paychecks, scoped per user
create table pays (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users on delete cascade,
  company_id uuid references companies(id) on delete cascade,
  date date not null,
  gross numeric default 0,
  take_home numeric default 0,
  hours numeric default 0,
  company_name text,
  created_at timestamptz default now()
);
```

## Row-Level Security (RLS) policies

The key principle: every table has RLS enabled, and every query implicitly
filters by the authenticated user. We do this once correctly and never worry
about data leaks at the application layer.

```sql
-- Enable RLS on all tables
alter table profiles enable row level security;
alter table companies enable row level security;
alter table company_members enable row level security;
alter table settings enable row level security;
alter table time_off_types enable row level security;
alter table entries enable row level security;
alter table pays enable row level security;

-- Profiles: users can only see and edit their own profile
create policy "Users can view own profile"   on profiles for select using (auth.uid() = user_id);
create policy "Users can update own profile" on profiles for update using (auth.uid() = user_id);
create policy "Users can insert own profile" on profiles for insert with check (auth.uid() = user_id);

-- Companies: users see companies they're a member of
create policy "Members can view companies" on companies for select
  using (id in (select company_id from company_members where user_id = auth.uid()));
create policy "Owners can update companies" on companies for update
  using (owner_user_id = auth.uid());
create policy "Anyone authenticated can create companies" on companies for insert
  with check (auth.uid() = owner_user_id);

-- company_members: members see their own memberships
create policy "Users see own memberships" on company_members for select
  using (user_id = auth.uid());
create policy "Owners manage memberships" on company_members for all
  using (company_id in (select id from companies where owner_user_id = auth.uid()));

-- Settings, entries, pays, time_off_types: all scoped to user
create policy "Users access own settings" on settings for all using (auth.uid() = user_id);
create policy "Users access own entries"  on entries  for all using (auth.uid() = user_id);
create policy "Users access own pays"     on pays     for all using (auth.uid() = user_id);
create policy "Members access company time-off types" on time_off_types for all
  using (company_id in (select company_id from company_members where user_id = auth.uid()));
```

## Step-by-step execution plan

### STEP 1 — Supabase account and project setup
**Status:** Complete (project provisioned: kijumyxoiacvqlqqwqon)
**Est:** 15 min, you do this manually
**Where:** browser (supabase.com), no code changes

1. Sign up at https://supabase.com (use GitHub login)
2. Click "New project"
3. Name: `timesheet-prod`
4. Database password: generate a strong one, save it to a password manager
5. Region: closest to you (Probably US East for New Jersey)
6. Wait 2-3 minutes for provisioning
7. Once ready, go to Settings → API. Copy and save:
   - **Project URL** (looks like `https://xxxxx.supabase.co`)
   - **Anon / public key** (starts with `eyJ...`)
   - **Service role key** (KEEP SECRET, you may not need this in code, just for admin scripts)

**Deliverable:** Project URL + anon key, ready to paste into config.

### STEP 2 — Database schema deployment
**Status:** Complete (schema + policies deployed; entries table verified to exist)
**Est:** 10 min, you run a SQL script

1. In Supabase dashboard, click **SQL Editor** in left sidebar
2. Click **New query**
3. Paste the schema SQL (I'll write a `supabase/schema.sql` file)
4. Click Run. Should see "Success. No rows returned."
5. Click **New query** again, paste the RLS policy SQL
6. Click Run. Verify by clicking **Table Editor** in sidebar — all tables should appear with a green RLS shield icon.

**Deliverable:** All tables and policies created in Supabase.

### STEP 3 — Frontend Supabase client integration
**Status:** Complete (client created, connection verified via temporary test)
**Est:** 1-2 hours, code changes

We add the Supabase JS library and create a new storage backend.

Tasks:
- [x] Add `@supabase/supabase-js` to package.json
- [x] Create `src/data/supabase.js` with the client setup
- [ ] ~~Create `src/data/remote.js` with API functions: `getEntries`, `saveEntry`, `deleteEntry`, etc.~~ DEFERRED to Step 5 (storage layer migration)
- [ ] ~~Add config via env vars + GitHub Secrets (so anon key isn't hardcoded)~~ DEFERRED to Step 8 (anon key currently hardcoded in `src/data/supabase.js`; public by design, RLS is the guard)
- [ ] ~~Build script reads env vars and injects them at build time~~ DEFERRED to Step 8

**Deliverable:** Client connected, can read from Supabase in dev console.

### STEP 4 — Auth flow UI
**Status:** Complete (shipped weeks ago in commit 11c2129; status line
was never updated at the time).
**Est:** 2-3 hours, code changes

Tasks:
- [x] Create `src/ui/auth.js` with login/signup screen
- [x] Show auth screen when no session, app when session exists
- [x] Email verification flow (Supabase sends the email, we show "Check your email" screen)
- [ ] ~~Password reset flow~~ DEFERRED (Supabase's email-based reset link works without custom UI)
- [x] Sign out button in top bar

**Deliverable:** Users can sign up, verify email, log in, log out.

**Post-5b auth fix — dud-screen-on-refresh / auth callback deadlock:**
After 5b, a hard refresh sometimes left the app on a broken screen
instead of the app or the login view. Root cause: supabase-js holds
an auth lock during onAuthStateChange callbacks; awaiting any
Supabase call inside the callback deadlocks because the awaited call
needs the same lock. Fixed by routing boot through onAuthStateChange
(commit 87cd0f6) and deferring bootApp by one frame so it runs
outside the locked callback (commit 3453c35); diagnostic logs cleaned
up afterward (commit 1ea8e47).

### STEP 5 — Storage layer migration
**Status:** In progress. Substeps:
- **5a Complete** — bootstrap: first-login creates profile, default
  company, membership, and default time-off types in Supabase.
  Landed with RLS policy debt (companies INSERT/SELECT loosened to
  resolve a 42501 rejection; company_members policy rewritten to fix
  infinite recursion). Tracked as Phase 4 tightening.
- **5b Complete (5b.1-5b.4)** — read path: `src/data/storage.js`
  split into LocalStore + RemoteStore + dispatcher; RemoteStore.get
  implemented for profile, settings, companies, time_off_types,
  schemaVersion, entries, pays. Plus a seed-suppression patch so the
  legacy 128-entry/88-pay seed never loads for signed-in users.
- **5c.1 Complete** — write path (profile + settings): RemoteStore.set
  upserts profile and settings by user_id. Verified persisting.
- **5c.2 Complete** — entries write path, shipped in four parts:
  - Part 1: Entries write to Supabase with diff-tracking (commit 31f6eae)
  - Part 2: Toast + revert on save failure in saveAll (commit 0c34a80)
  - Part 3: All modal/settings save paths routed through saveKey (commit 34e0570)
  - Part 4: Mid-session token loss detection, route to auth instead
    of silent local fallback (commit 13694dd)
- **5c.3 / 5c.4 Not started** — pays write, companies +
  time_off_types write. Diff-and-write (Option A) with a
  module-level cache of last-loaded pays.
**Est:** 2-3 hours, code changes

Replace `src/data/storage.js` (currently calls `window.storage`/localStorage)
with a version that calls Supabase. The abstraction layer makes this clean.

Tasks:
- [x] New `Store` implementation backed by Supabase tables (reads +
  profile/settings writes; entries/pays writes pending in 5c.2-5c.4)
- [~] Handle loading states (data now arrives async) — basic syncing
  indicator wired; loading spinners deferred to Step 9
- [x] Offline handling: if network fails, fall back to localStorage cache +
  retry (2026-09-11). Successful remote reads mirror into localStorage under
  `ts:cache:<userId>:<key>`; a failing read retries three times then serves the
  mirror instead of the empty fallback. Keys served from the mirror are marked
  stale and refuse writes, because remote writes diff against a load-time
  snapshot and a stale baseline can push deletions for rows the server still
  holds. The top bar says "offline, showing saved copy" rather than "synced".
  Covered by `scripts/test-offline-cache.mjs` (19 assertions).
  NOT included: an offline write queue. Replaying queued writes against a
  diff-based snapshot is a real conflict-resolution problem, and getting it
  wrong loses data rather than merely showing stale data.
- [x] First-login: create profile, default company, default time-off types

**Deliverable:** All app data flows through Supabase. Test by signing up two
test accounts; each should see only their own data.

### STEP 5.5 — Legacy Excel import (one-off script)
**Status:** COMPLETE (confirmed 2026-09-11). No script was ever needed. Ravi
verified from the live app that the 2022 through early-2025 Phillips paychecks
are present in his Supabase account, so the historical data crossed over during
the earlier cutover. Nothing further to do here.

The analysis below is kept because it corrects two claims that were wrong and
would have caused damage if acted on. Do not delete it just because the step
is closed.
**Est:** 1 hour, one-off script
**Where:** local script, not shipped in the app bundle

One-off script to bulk-load Ravi's 2025 data plus the 128 entries from
`Time_Sheet_2026.xlsx` into the raviknight@outlook.com Supabase workspace.
This supersedes the old Step 7, which assumed a separate in-app import step.

**Correction (2026-09-11): do NOT use the in-app JSON importer for this.**
An earlier draft of this step offered it as the easy option. It is not. The
importer at Settings → Data → Import REPLACES all current data: it confirms
with "This will REPLACE all current data" and then overwrites profile,
settings, timeOffTypes, companies, entries and pays wholesale. Pointing it at
a historical file would destroy everything logged since the cutover. It is an
export/restore tool, not a merge tool. A backfill needs insert-only semantics
that skip dates already present.

**Also note:** the source data is no longer trapped in Excel. The full legacy
set already lives in `src/data/seed.js` as JSON: `SEED_ENTRIES` (128 daily
entries from 2025-12-29) and `SEED_PAYS` (88 pay records, 2022 through 2026).
There is no `.xlsx` file in the repo at all. So the remaining work is not a
spreadsheet parse, it is a careful insert-only sync from seed.js to Supabase.

**Resolved 2026-09-11:** the backfill had already happened. Seed data loads on
first run in LOCAL mode only (remote mode suppresses it, see `src/app.js`),
which made it genuinely unclear whether the history survived the cutover. It
did: Ravi confirmed the 2022 Phillips paychecks are visible in the live app.
The lesson worth keeping is that the check cost one look at the Paychecks view,
while the alternative was writing an untestable script that wrote to
production.

Tasks:
All of the following are MOOT: the data was already in Supabase, so no script
was written and no service_role key was ever handled.

- [~] ~~One-off Node script that reads `Time_Sheet_2026.xlsx` (and the
  2025 legacy data) and writes directly to Supabase~~ NOT NEEDED
- [~] ~~Use the **service_role key** (bypasses RLS; never commit it,
  pass via env var at runtime)~~ NOT NEEDED
- [~] ~~Target the primary account: raviknight@outlook.com~~ NOT NEEDED
- [~] ~~Map Excel rows to the `entries` and `pays` table shapes~~ NOT NEEDED
- [~] ~~Idempotent: safe to re-run (upsert on the natural keys
  `(user_id, company_id, date)`)~~ NOT NEEDED. Worth noting for any future
  backfill: upsert is the WRONG choice here. It would overwrite edits made in
  the app since the original import. An insert-only sync that skips existing
  dates is the safe shape.
- [ ] Verify counts after run (expected ~128 entries + ~88 pays,
  plus the 2025 legacy rows)

**Deliverable:** Ravi's full 2025 + 2026 history lives in his
Supabase account, independent of the in-app importer.

### STEP 6 — Demo seed for logged-out visitors
**Status:** CANCELLED (2026-09-11). Ravi: "We don't need demo seed data."
Do not action this step. If the project ever moves toward outside users, the
underlying concern (a logged-out visitor seeing Ravi's real data) should be
re-examined from scratch rather than by reviving this checklist.
**Est:** 1 hour, code + data

Tasks:
- [ ] Replace `src/data/seed.js` with FAKE demo data (3 weeks of entries, 5 paychecks)
- [ ] Show demo data only when not logged in (read-only view)
- [ ] Add prominent "Sign up to start tracking your own time" CTA

**Deliverable:** Logged-out URL shows a demo, not Ravi's real data.

### STEP 7 — Migrate Ravi's real data
**Status:** Superseded by Step 5.5. The in-app JSON importer already
exists (Settings → Data → Import JSON), so there is no separate
import-UI step to build. The historical backfill of Ravi's 2025 +
2026 data is now tracked solely under Step 5.5; do not action this
step.

### STEP 8 — GitHub Actions deploy with secrets
**Status:** Complete. Brought ahead of Step 5: a deployment-path bug found
during Step 4 live-site testing (Pages was serving the unbundled root
`index.html`, which fails on bare module specifiers like
`@supabase/supabase-js`) made automated build+deploy of `dist/` the priority.
`.github/workflows/deploy.yml` builds on every push to main and publishes
`dist/` to Pages; the Pages source has been switched to "GitHub Actions" and
end-to-end production testing this session (signup → verify → signin →
bootstrap → persist) confirms the deploy path works. Anon key stays hardcoded
in `src/data/supabase.js` (public by design, RLS is the guard), so no GitHub
secrets are needed; the env-var injection sub-tasks remain deferred (not
required for personal-use-first scope).
**Est:** 30 min

Tasks:
- [ ] ~~Add Supabase URL and anon key as GitHub repo secrets~~ DEFERRED (anon key public by design, hardcoded; RLS is the guard)
- [x] Add `.github/workflows/deploy.yml` (builds `dist/` and publishes to Pages)
- [x] Switch Pages source to "GitHub Actions"
- [x] Push and confirm site rebuilds + deploys automatically

**Deliverable:** `git push` → site live in 60 seconds with full Supabase backend.

### STEP 9 — Polish + testing
**Status:** COMPLETE except the fresh-account run through, which needs Ravi
**Est:** 1-2 hours

Tasks:
- [ ] **Test full flow with a fresh account in incognito browser. RAVI MUST DO
  THIS ONE.** It requires creating an account and entering a password, which
  Claude will not do on someone's behalf. Worth actually running: it is the
  only path that exercises `ensureBootstrapped` end to end (profile row,
  default company, four default time-off types), and every other test here
  runs against an account that was bootstrapped months ago. What to check: sign
  up, verify email, land on an empty dashboard rather than an error, confirm a
  default company and the PTO/Sick/Holiday/Unpaid types exist, add one entry,
  reload, confirm it persisted.
- [x] Loading spinners while data loads. Already covered by the boot overlay
  added in 5714240: it holds until the first load finishes, is idempotent, and
  has a fail-open timeout so it can never strand the app. Subsequent loads use
  the top-bar sync indicator ("loading…"), which is the right weight for a
  refresh that is not blocking the whole screen.
- [x] Error toasts for network failures (2026-09-11). The offline cache made
  failures survivable but silent; this makes them legible. `toast()` gained a
  type and duration, because a 2-second confirmation-length toast is not enough
  time to read an explanation of why editing is disabled. Three paths now
  report: boot on cached data warns the data may be out of date, a refused save
  says the change was not stored rather than claiming a reload, and a failed
  revert-reload admits the view may be stale. Colors pair `--danger`/`--warn`
  with their `-bg` variants so they stay readable in dark mode, where those
  foreground values invert to pale shades.
- [ ] ~~"Forgot password" link in login screen~~ DEFERRED (personal-use-first)
- [ ] ~~Email templates customization in Supabase (welcome email, password reset)~~ DEFERRED (personal-use-first)
- [x] Update CLAUDE.md, CONTEXT.md, DECISIONS.md with Phase 3 outcome
  (2026-09-11). CLAUDE.md and AGENTS.md: corrected module map, real test
  commands, and the conda PATH prefix. CONTEXT.md: status reconciled, stale
  "immediate next" entries cleared. DECISIONS.md: added D-10 (Supabase and why
  the anon key is not a secret), D-11 (diff-against-snapshot writes and why a
  missing snapshot must refuse rather than full-write), D-12 (offline cache,
  and why there is no write queue).

**Deliverable:** Ready to share with first beta user.

### STEP 10 — Keep-alive GitHub Action
**Status:** COMPLETE (2026-09-11, commit 33c289b)
**Est:** 10 min

Purpose: Prevent Supabase free-tier 7-day inactivity pause.

Tasks:
- [x] Add `.github/workflows/keep-alive.yml` that pings the Supabase REST
  endpoint on a cron schedule. Runs Mondays and Thursdays, so the largest gap
  is about three days against a seven-day window and one failed run cannot
  cause a pause.
- [ ] ~~Add `SUPABASE_ANON_KEY` as a GitHub repo secret~~ NOT NEEDED. The
  workflow greps the URL and anon key out of `src/data/supabase.js`, which is
  the single source of truth and cannot drift from the app. The anon key is
  public by design (RLS is the guard), consistent with the Step 8 decision.
  The job masks it in logs anyway.
- [x] Confirm the ping succeeds: verified against the live project before
  merge, HTTP 200 with body `[]`.

**Deliverable:** Supabase project stays awake without manual weekly visits.

Notes for whoever touches this next:
- It queries a real table, not the PostgREST root. The root serves a cached
  OpenAPI document and may never touch Postgres, which would make the whole
  workflow a silent no-op.
- Anonymous select on `profiles` is filtered by RLS and returns an empty
  array, but the query still executes against the database, which is what
  registers as activity.
- A non-200 fails the job deliberately, so a keep-alive that quietly stopped
  working emails the repo owner instead of letting the project pause unnoticed.
- This does NOT address first-query cold-start latency. That is handled client
  side by the warm-up-first boot (commit 5714240). Different problem.
- GitHub disables scheduled workflows after 60 days of repository inactivity,
  which would silently stop this too.

## Total estimate

4-6 hours of focused work across 3-4 sessions (personal-use-first scope;
demo seed and most polish deferred). Each step is small enough to complete
in one session.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Free tier pauses after 7 days inactivity | Ravi uses app weekly anyway. Set a calendar reminder otherwise. |
| Supabase URL/key leak | They're public anyway (anon key is meant to be in client). RLS policies are the real security. |
| RLS policy bugs leak data | Test with 2 accounts in incognito browsers after every backend change. |
| Email deliverability | Use Supabase's built-in SMTP for now. Add custom SMTP (Resend, Mailgun) later if needed. |
| Migration loses data | Always export local JSON backup before each session. Don't delete localStorage until production is verified. |

## Done condition for Phase 3

- [ ] Ravi can sign up, verify email, log in on any device
- [ ] Ravi's real data lives in Supabase, password-protected
- [ ] A stranger visiting the URL sees demo data + signup prompt
- [ ] Two different accounts cannot see each other's data (verified)
- [ ] Pushing code to GitHub auto-deploys to Pages
- [ ] Phase 4 (team / supervisor features) can be built without re-architecting