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
| Backend | Supabase (Postgres + Auth + Row-Level Security) |
| Auth provider | Supabase Auth, email + password |
| Signup | Open to anyone |
| Email verification | Required |
| Workspace model | Companies table from day 1, one per user initially |
| Demo data | Fake seed shown to logged-out visitors only |
| Deploy | GitHub Actions building to GitHub Pages |
| Real personal data | Imported via one-time JSON import on each device |

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
**Status:** Not started
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
**Status:** Not started
**Est:** 10 min, you run a SQL script

1. In Supabase dashboard, click **SQL Editor** in left sidebar
2. Click **New query**
3. Paste the schema SQL (I'll write a `supabase/schema.sql` file)
4. Click Run. Should see "Success. No rows returned."
5. Click **New query** again, paste the RLS policy SQL
6. Click Run. Verify by clicking **Table Editor** in sidebar — all tables should appear with a green RLS shield icon.

**Deliverable:** All tables and policies created in Supabase.

### STEP 3 — Frontend Supabase client integration
**Status:** Not started
**Est:** 1-2 hours, code changes

We add the Supabase JS library and create a new storage backend.

Tasks:
- [ ] Add `@supabase/supabase-js` to package.json
- [ ] Create `src/data/supabase.js` with the client setup
- [ ] Create `src/data/remote.js` with API functions: `getEntries`, `saveEntry`, `deleteEntry`, etc.
- [ ] Add config via env vars + GitHub Secrets (so anon key isn't hardcoded)
- [ ] Build script reads env vars and injects them at build time

**Deliverable:** Client connected, can read from Supabase in dev console.

### STEP 4 — Auth flow UI
**Status:** Not started
**Est:** 2-3 hours, code changes

Tasks:
- [ ] Create `src/ui/auth.js` with login/signup screen
- [ ] Show auth screen when no session, app when session exists
- [ ] Email verification flow (Supabase sends the email, we show "Check your email" screen)
- [ ] Password reset flow
- [ ] Sign out button in top bar

**Deliverable:** Users can sign up, verify email, log in, log out.

### STEP 5 — Storage layer migration
**Status:** Not started
**Est:** 2-3 hours, code changes

Replace `src/data/storage.js` (currently calls `window.storage`/localStorage)
with a version that calls Supabase. The abstraction layer makes this clean.

Tasks:
- [ ] New `Store` implementation backed by Supabase tables
- [ ] Handle loading states (data now arrives async)
- [ ] Offline handling: if network fails, fall back to localStorage cache + retry
- [ ] First-login: create profile, default company, default time-off types

**Deliverable:** All app data flows through Supabase. Test by signing up two
test accounts; each should see only their own data.

### STEP 6 — Demo seed for logged-out visitors
**Status:** Not started
**Est:** 1 hour, code + data

Tasks:
- [ ] Replace `src/data/seed.js` with FAKE demo data (3 weeks of entries, 5 paychecks)
- [ ] Show demo data only when not logged in (read-only view)
- [ ] Add prominent "Sign up to start tracking your own time" CTA

**Deliverable:** Logged-out URL shows a demo, not Ravi's real data.

### STEP 7 — Migrate Ravi's real data
**Status:** Not started
**Est:** 30 min

Tasks:
- [ ] Export real data from current localStorage version
- [ ] Sign up for `ravi@...` account in production Supabase
- [ ] One-time import script via Settings → Import JSON (this UI already exists)
- [ ] Verify all 128 entries and 88 pays loaded correctly

**Deliverable:** Ravi's data lives in his personal Supabase account, behind
his password.

### STEP 8 — GitHub Actions deploy with secrets
**Status:** Not started
**Est:** 30 min

Tasks:
- [ ] Add Supabase URL and anon key as GitHub repo secrets
- [ ] Add `.github/workflows/deploy.yml` (the one I shared earlier, plus env var injection)
- [ ] Switch Pages source to "GitHub Actions"
- [ ] Push and confirm site rebuilds + deploys automatically

**Deliverable:** `git push` → site live in 60 seconds with full Supabase backend.

### STEP 9 — Polish + testing
**Status:** Not started
**Est:** 1-2 hours

Tasks:
- [ ] Test full flow with a fresh account in incognito browser
- [ ] Loading spinners while data loads
- [ ] Error toasts for network failures
- [ ] "Forgot password" link in login screen
- [ ] Email templates customization in Supabase (welcome email, password reset)
- [ ] Update CLAUDE.md, CONTEXT.md, DECISIONS.md with Phase 3 outcome

**Deliverable:** Ready to share with first beta user.

## Total estimate

8-12 hours of focused work across ~5-8 sessions. Each step is small enough to
complete in one session.

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