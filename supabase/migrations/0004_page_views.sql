-- First-party page views (IAI-465, page-views slice): one row per real customer view of /tracker,
-- keyed by accounts.id, so we can answer "of the accounts with a Relay link, how many were opened,
-- and how many come back" — the number Clarity can't give (it counts browsers, keeps 3 days in its
-- API, and has no denominator).
--
-- Privacy: no IP, no cookie id, no raw user agent, no per-visitor id. `device` is a coarse class
-- computed server-side; `entry` is a coarse referrer class. accounts.id is not a credential.
-- Access model unchanged: RLS on with no policies → service role only.
--
-- DEPLOY ORDERING: apply in the Supabase SQL editor BEFORE (or right after) deploying the code. If the
-- code ships first, the beacon's insert fails and is swallowed, and /api/stats returns 503 — nothing
-- customer-facing breaks. Safe to re-run: every statement is idempotent.

create table if not exists page_views (
  id          bigint generated always as identity primary key,
  account_id  uuid not null references accounts (id) on delete cascade,
  viewed_at   timestamptz not null default now(),
  entry       text not null check (entry in ('salesforce', 'webmail', 'direct', 'other')),
  device      text not null check (device in ('mobile', 'tablet', 'desktop', 'bot', 'unknown')),
  internal    boolean not null default false
);

create index if not exists page_views_account_viewed_idx on page_views (account_id, viewed_at desc);
create index if not exists page_views_viewed_idx on page_views (viewed_at desc);

alter table page_views enable row level security;   -- no policies → anon/authenticated read nothing

-- Every leadership number in one call. "Customer" view = not internal, not CS (entry 'salesforce'),
-- not a bot. Window is clamped to 1..365 days. Distinct-day counting uses UTC calendar days.
create or replace function relay_usage_stats(window_days int default 30)
returns jsonb
language sql
stable
set search_path = public
as $$
  with params as (
    select greatest(1, least(coalesce(window_days, 30), 365)) as d
  ),
  cust as (
    select pv.account_id, pv.viewed_at, pv.device
    from page_views pv
    where not pv.internal and pv.entry <> 'salesforce' and pv.device <> 'bot'
  ),
  cust_win as (
    select c.*
    from cust c, params p
    where c.viewed_at >= now() - make_interval(days => p.d)
  ),
  active as (
    select distinct account_id from cases where is_closed = false
  )
  select jsonb_build_object(
    'windowDays',           (select d from params),
    'generatedAt',          now(),
    'trackingSince',        (select min(viewed_at) from page_views),
    'accountsWithLink',     (select count(*) from accounts),
    'accountsEverViewed',   (select count(distinct account_id) from cust),
    'activeAccounts',       (select count(*) from active),
    'activeAccountsViewed', (select count(distinct w.account_id) from cust_win w join active a using (account_id)),
    'accountsViewed',       (select count(distinct account_id) from cust_win),
    'returningAccounts',    (select count(*) from (
                               select account_id from cust_win
                               group by account_id
                               having count(distinct (viewed_at at time zone 'UTC')::date) >= 2
                             ) r),
    'customerViews',        (select count(*) from cust_win),
    'csViews',              (select count(*) from page_views pv, params p
                             where pv.entry = 'salesforce' and not pv.internal
                               and pv.viewed_at >= now() - make_interval(days => p.d)),
    'internalViews',        (select count(*) from page_views pv, params p
                             where pv.internal and pv.viewed_at >= now() - make_interval(days => p.d)),
    'deviceMix',            (select coalesce(jsonb_object_agg(device, n), '{}'::jsonb)
                             from (select device, count(*) as n from cust_win group by device) dm)
  );
$$;

-- Postgres grants EXECUTE to PUBLIC by default and Supabase adds anon/authenticated; lock it down.
revoke execute on function relay_usage_stats(int) from public, anon, authenticated;
grant execute on function relay_usage_stats(int) to service_role;
