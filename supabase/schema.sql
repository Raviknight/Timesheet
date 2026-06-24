-- schema.sql
--
-- Database schema for Time Sheet on Supabase.
-- Run this ONCE on a fresh `timesheet-prod` project, in the SQL Editor,
-- BEFORE policies.sql.
--
-- This file is the documentation mirror of the LIVE database: the columns,
-- defaults, and constraints below were reconciled to production on
-- 2026-06-17. Row-Level Security policies live in policies.sql, not here.
--
-- Table order is profiles, companies, company_members, settings,
-- time_off_types, entries, pays. profiles is created first, so its
-- active_company_id foreign key to companies is added via ALTER TABLE once
-- companies exists (a forward reference cannot be inline).
--
-- Expected result in the SQL Editor: "Success. No rows returned."

-- Profiles: 1-to-1 with auth.users.
create table profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  name text,
  role text default 'owner' check (role in ('owner','employee','supervisor','admin')),
  active_company_id uuid,                        -- FK added after companies (below)
  created_at timestamptz default now()
);

-- Companies: each user gets one default company on signup (created by the
-- app on first login).
--
-- Pay-period columns: each company owns its own pay-period configuration.
-- Nullable columns are only meaningful for the matching pay_frequency value;
-- other frequencies should leave them null. Per-company break, Standard Day,
-- and the hire date (start_date) drive break deduction, entry prefill, and PTO
-- accrual respectively.
create table companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz default now(),

  pay_frequency text not null default 'biweekly'
    check (pay_frequency in ('weekly','biweekly','semimonthly','monthly','advanced')),
  week_start_dow smallint not null default 1,    -- 0=Sun..6=Sat; 1=Monday
  semi_first_day smallint,                       -- semimonthly only (1..28)
  semi_second_day smallint,                      -- semimonthly only (1..28)
  monthly_start_day smallint,                    -- monthly only (1..28)
  advanced_anchor_date date,                     -- advanced only
  advanced_cycle_days smallint,                  -- advanced only (>=1)
  biweekly_start_parity text                     -- biweekly only: 'odd' | 'even'
    check (biweekly_start_parity in ('odd','even')),
  is_active boolean not null default true,
  ot_threshold numeric not null default 40,
  ot_period text not null default 'weekly'
    check (ot_period in ('weekly','biweekly','semimonthly','monthly')),
  break_minutes integer,                         -- per-company break override
  std_seg1_start text,                           -- per-company Standard Day
  std_seg1_end text,
  std_seg2_start text,
  std_seg2_end text,
  start_date date                                -- hire date: cycle anchor + probation
);

-- profiles.active_company_id references companies(id). Added here because
-- profiles is created before companies (the FK target must already exist).
alter table profiles
  add constraint profiles_active_company_id_fkey
  foreign key (active_company_id) references companies(id) on delete set null;

-- Company members: future-proof for multi-tenant (Phase 4+).
--
-- Per-employee fields (display_name, hire_date, break_minutes, std_seg*) live
-- here now: a membership is the unit an employee's work configuration hangs off.
-- The synthetic id PK is required because a membership with a null user_id
-- (owner-managed, not yet claimed) cannot use the old composite
-- (company_id, user_id) PK. Column order matches live ordinal_position: the new
-- columns were appended by ALTER TABLE, so id sits in position 5, not 1.
create table company_members (
  company_id uuid not null references companies(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  role text default 'owner' check (role in ('owner','admin','supervisor','employee')),
  joined_at timestamptz default now(),
  id uuid not null default gen_random_uuid(),
  display_name text,
  hire_date date,
  break_minutes integer,
  std_seg1_start text,
  std_seg1_end text,
  std_seg2_start text,
  std_seg2_end text,
  primary key (id)
);

-- Partial unique: a user holds at most one claimed membership per company.
-- Owner-managed members (user_id null) are allowed in any number per company.
create unique index company_members_company_user_unique
  on company_members (company_id, user_id)
  where user_id is not null;

-- Settings: 1-to-1 with user (per-user settings, not per-company yet).
create table settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null default '{}',
  updated_at timestamptz default now()
);

-- Time-off types: scoped per company, so different companies can have
-- different PTO rules. pool_by_year is retired (folded into pool_days) but
-- still present; the grant_style/accrual_anchor/anchor_date/waiting_days/
-- carryover_* columns hold the PTO accrual config.
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
  pool_by_year jsonb not null default '{}',
  additive boolean not null default false,
  grant_style text
    check (grant_style in ('upfront','accrued')),
  accrual_anchor text
    check (accrual_anchor in ('calendar','anniversary','fiscal')),
  anchor_date text,
  waiting_days integer,
  carryover_mode text
    check (carryover_mode in ('none','cap','unlimited')),
  carryover_cap numeric,
  unique (company_id, code)
);

-- Entries: time entries. status and booked_at carry the PTO booking model.
create table entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  company_id uuid references companies(id) on delete cascade,
  date date not null,
  segments jsonb not null default '[]',
  time_off text,
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  status text
    check (status in ('approved','pending','denied','cancelled')),
  booked_at timestamptz,
  -- Half-day override (v4): explicit time-off hours for a partial day. Null
  -- means "use the time-off type's per-day default" (legacy behavior). No
  -- backfill: existing rows stay null and read byte-identically to today.
  hours_override numeric(5,2),
  member_id uuid not null references company_members(id) on delete cascade,
  unique (user_id, company_id, date)
);

create index entries_member_id_idx on entries (member_id);

-- Pays: paychecks.
create table pays (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  company_id uuid references companies(id) on delete cascade,
  date date not null,
  gross numeric default 0,
  take_home numeric default 0,
  hours numeric default 0,
  company_name text,
  created_at timestamptz default now(),
  member_id uuid not null references company_members(id) on delete cascade,
  unique (user_id, company_id, date)
);

create index pays_member_id_idx on pays (member_id);

-- Estimator settings (v5): per-user persistence for the paycheck estimator.
-- Hourly rate is NEVER stored here; only structural inputs (state, filing
-- status, locality, deduction template). The deductions jsonb is a list of
-- {name, amountPerPeriod, type} where type is one of:
--   'pre-tax-401k'        reduces federal + state, NOT FICA
--   'pre-tax-section125'  reduces federal + state + FICA (HSA, FSA, premiums)
--   'post-tax'            reduces take-home only
create table estimator_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  state text,                       -- 2-letter state code (PA, NY, ...)
  filing_status text default 'single'
    check (filing_status in ('single','mfj','hoh')),
  pay_periods_per_year integer default 26
    check (pay_periods_per_year in (52,26,24,12)),
  locality jsonb not null default '{}',
  deductions jsonb not null default '[]',
  state_effective_rate numeric,     -- used when state is in user-rate mode
  updated_at timestamptz default now()
);

-- Estimate history (v5): append-only log of completed estimator runs.
-- inputs and result are full JSON snapshots so a row stays meaningful even
-- if the engine constants change later.
create table estimate_history (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  member_id uuid references company_members(id) on delete set null,
  created_at timestamptz default now(),
  inputs jsonb not null,
  result jsonb not null,
  note text
);

create index estimate_history_user_created_idx
  on estimate_history (user_id, created_at desc);
