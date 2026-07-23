-- IAI-398 (per-account Refresh scoping): tag each sync run with what it covered.
--   'full'         = cron / internal manual sync over every tracked account
--   '<account id>' = a customer-triggered refresh scoped to that one account (uuid)
-- Drives the per-account refresh cooldown, the global scoped-refresh safety valve, and lets
-- /api/health keep watching FULL runs only (a customer refresh must never mask a dead cron).
--
-- DEPLOY ORDERING: apply to the live database BEFORE deploying the code that writes `scope`
-- (an insert naming a missing column errors). Safe early — nothing reads it until the deploy;
-- the default backfills history correctly (every past run was a full sync).
alter table sync_runs add column scope text not null default 'full';
