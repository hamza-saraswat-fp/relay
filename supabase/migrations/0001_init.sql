-- Relay read-store schema (v1).
-- Source of truth: docs/relay-backend-architecture.md §2 (Relay project folder).
-- Access model: service-role only. RLS is enabled with NO policies so the anon
-- key can read nothing — all rendering happens server-side with the service role.

create type status_chip as enum (
  'waiting_for_you',
  'waiting_for_support',
  'in_progress',
  'resolved'
);

-- One row per Salesforce Account with ≥1 qualifying tech-support case.
create table accounts (
  id                  uuid primary key default gen_random_uuid(),
  sf_account_id       text not null unique,
  name                text not null,
  parent_sf_id        text,                          -- multi-location parent Account (rollup TBD)
  token               uuid not null unique default gen_random_uuid(),  -- public slug: /t/{token}
  sf_field_written_at timestamptz,                   -- when Relay_Tracker_Link__c was PATCHed
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create table cases (
  id            uuid primary key default gen_random_uuid(),
  sf_case_id    text not null unique,
  account_id    uuid not null references accounts (id) on delete cascade,
  case_number   text,
  subject       text not null,
  status_raw    text not null,
  status_chip   status_chip not null,
  created_date  timestamptz not null,
  closed_date   timestamptz,
  last_modified timestamptz not null,
  is_closed     boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index cases_account_id_idx on cases (account_id);
create index cases_last_modified_idx on cases (last_modified);

-- Customer-facing "latest update" per case: newest outbound email (or Resolution__c),
-- cleaned by the Claude clean + safety pass (IAI-214).
create table case_updates (
  case_id          uuid primary key references cases (id) on delete cascade,
  email_message_at timestamptz,
  raw_body         text,
  cleaned_update   text,
  safety_flag      boolean not null default false,   -- true → render fallback line, never raw
  cleaned_at       timestamptz,
  model            text,
  updated_at       timestamptz not null default now()
);

-- One row per sync run (cron or manual) for observability + delta watermarks.
create table sync_runs (
  id             uuid primary key default gen_random_uuid(),
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  cases_upserted integer not null default 0,
  sf_api_calls   integer not null default 0,
  status         text not null default 'running',    -- running | ok | error
  error          text
);

create index sync_runs_started_at_idx on sync_runs (started_at desc);

-- Lock out anon/authenticated roles entirely (no policies = no access);
-- the service role bypasses RLS.
alter table accounts     enable row level security;
alter table cases        enable row level security;
alter table case_updates enable row level security;
alter table sync_runs    enable row level security;
