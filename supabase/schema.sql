-- schema.sql
--
-- Phase 3, Step 2: database schema for Time Sheet on Supabase.
-- Run this ONCE on a fresh `timesheet-prod` project, in the SQL Editor,
-- BEFORE policies.sql.
--
-- Source of truth: docs/PHASE_3_PLAN.md ("Database schema"). The only change
-- from the plan is table ordering: `companies` is created before `profiles`
-- because `profiles.active_company_id` references `companies(id)`. The plan
-- listed profiles first, which would fail on a clean run.
--
-- Expected result in the SQL Editor: "Success. No rows returned."

-- Companies: each user gets one default company on signup (created by the
-- app on first login, see PHASE_3_PLAN.md Step 5).
--
-- Pay-period columns added in Step 3e.1: each company now owns its own
-- pay-period configuration. Nullable columns are only meaningful for the
-- matching pay_frequency value; other frequencies should leave them null.
create table companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner_user_id uuid references auth.users not null,
  created_at timestamptz default now(),

  pay_frequency text not null default 'biweekly'
    check (pay_frequency in ('weekly','biweekly','semimonthly','monthly','advanced')),
  week_start_dow smallint not null default 1,   -- 0=Sun..6=Sat; 1=Monday
  biweekly_start_parity text                    -- biweekly only: 'odd' | 'even'
    check (biweekly_start_parity in ('odd','even')),
  semi_first_day smallint,                      -- semimonthly only (1..28)
  semi_second_day smallint,                     -- semimonthly only (1..28)
  monthly_start_day smallint,                   -- monthly only (1..28)
  advanced_anchor_date date,                    -- advanced only
  advanced_cycle_days smallint                  -- advanced only (>=1)
);

-- Profiles: 1-to-1 with auth.users.
create table profiles (
  user_id uuid primary key references auth.users on delete cascade,
  name text,
  role text default 'owner' check (role in ('owner','employee','supervisor','admin')),
  active_company_id uuid references companies(id),
  created_at timestamptz default now()
);

-- Company members: future-proof for multi-tenant (Phase 4+).
create table company_members (
  company_id uuid references companies(id) on delete cascade,
  user_id uuid references auth.users on delete cascade,
  role text default 'owner' check (role in ('owner','admin','supervisor','employee')),
  joined_at timestamptz default now(),
  primary key (company_id, user_id)
);

-- Settings: 1-to-1 with user (per-user settings, not per-company yet).
create table settings (
  user_id uuid primary key references auth.users on delete cascade,
  data jsonb not null default '{}',
  updated_at timestamptz default now()
);

-- Time-off types: scoped per company, so different companies can have
-- different PTO rules. Today each user has exactly one company.
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

-- Entries: time entries, scoped per user.
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

-- Pays: paychecks, scoped per user.
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
