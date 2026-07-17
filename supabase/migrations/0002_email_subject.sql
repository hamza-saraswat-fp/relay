-- IAI (email-thread reference): store the newest outbound email's Subject so the customer page
-- can show a searchable "Email thread · <subject> · last reply <date>" reference on
-- "Needs your reply" tickets. Additive + nullable → backwards-compatible; existing rows get NULL
-- and backfill on the next sync.
--
-- DEPLOY ORDERING: apply this to the live database BEFORE deploying the sync change that writes
-- email_subject (an upsert naming a missing column errors). Safe to apply early — the column is
-- invisible to the page until the render change ships.
alter table case_updates add column email_subject text;
