-- schema.sql
--
-- Database schema for Time Sheet on Supabase.
-- Run this ONCE on a fresh `timesheet-prod` project, in the SQL Editor,
-- BEFORE policies.sql.
--
-- This file is the documentation mirror of the LIVE database: the columns,
-- defaults, and constraints below were reconciled to production on
-- 2026-06-16. Row-Level Security policies live in policies.sql, not here.
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
create table company_members (
  company_id uuid references companies(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  role text default 'owner' check (role in ('owner','admin','supervisor','employee')),
  joined_at timestamptz default now(),
  primary key (company_id, user_id)
);

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
  unique (user_id, company_id, date)
);

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
  unique (user_id, company_id, date)
);
