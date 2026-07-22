/**
 * Sync health classification (IAI-239) — pure, no I/O, so it's unit-testable.
 *
 * Covers both failure modes:
 *  - an explicit `error` run (the sync caught + recorded a failure), and
 *  - a `stuck` run: the Vercel function was hard-killed at maxDuration (300s), leaving the row
 *    'running' forever — no catch ran, so no Slack alert fired; only staleness reveals it.
 *  plus plain `stale` (the last good run is too old).
 */

export interface SyncRunRow {
  started_at: string;
  finished_at: string | null;
  status: string; // 'running' | 'ok' | 'error'
  cases_upserted: number | null;
  error: string | null;
}

export type SyncState = "ok" | "stale" | "stuck" | "error" | "never_run";

export interface SyncHealth {
  state: SyncState;
  healthy: boolean; // true only for 'ok' — drives the endpoint's 200 vs 503
  ageMinutes: number | null; // since the newest run's started_at
  lastRun: {
    startedAt: string;
    finishedAt: string | null;
    status: string;
    casesUpserted: number | null;
    error: string | null;
  } | null;
}

// A row stuck 'running' longer than this = the function was almost certainly killed (maxDuration 300s).
const STUCK_MINUTES = 15;
// Cron runs every 2h (IAI-396); if the last successful run finished longer ago than this, data is
// stale. 5h ≈ two missed cycles plus margin — keeps the health signal meaningful at this cadence.
const STALE_MINUTES = 5 * 60;

/** Minimum spacing between manually-triggered syncs — shared by the internal manual refresh
 *  (`POST /api/sync`) and the customer-facing Refresh button (`POST /api/refresh`). */
export const MANUAL_COOLDOWN_MS = 10 * 60 * 1000;

export function syncHealth(rows: SyncRunRow[], nowMs: number = Date.now()): SyncHealth {
  if (!rows.length) {
    return { state: "never_run", healthy: false, ageMinutes: null, lastRun: null };
  }

  const latest = [...rows].sort((a, b) => b.started_at.localeCompare(a.started_at))[0];
  const ageMinutes = Math.round((nowMs - new Date(latest.started_at).getTime()) / 60000);
  const lastRun = {
    startedAt: latest.started_at,
    finishedAt: latest.finished_at,
    status: latest.status,
    casesUpserted: latest.cases_upserted,
    error: latest.error,
  };

  let state: SyncState;
  if (latest.status === "error") {
    state = "error";
  } else if (latest.status === "running") {
    // A fresh running row is a sync in progress (healthy); an old one is a killed/timed-out function.
    state = ageMinutes > STUCK_MINUTES ? "stuck" : "ok";
  } else {
    // Latest run is ok → healthy unless the last good result is too old.
    const ref = latest.finished_at ?? latest.started_at;
    const okAgeMin = Math.round((nowMs - new Date(ref).getTime()) / 60000);
    state = okAgeMin > STALE_MINUTES ? "stale" : "ok";
  }

  return { state, healthy: state === "ok", ageMinutes, lastRun };
}

export type RefreshState = "running" | "cooldown" | "allowed";

export interface RefreshDecision {
  state: RefreshState;
  retryAfterSeconds?: number; // only on 'cooldown'
}

/**
 * Should a manual refresh actually kick off a sync? (IAI-396) Pure, like `syncHealth`.
 *
 * A sync refreshes every account, so the gate is deliberately GLOBAL: if anyone's sync ran
 * recently, everyone's data is already fresh. Neither non-'allowed' state is an error — the
 * customer is told their data is current / already updating.
 *
 * A 'running' row older than STUCK_MINUTES is a killed function, not a live sync, so it must not
 * block forever; it falls through (and is past the cooldown window by definition).
 */
export function refreshGate(rows: SyncRunRow[], nowMs: number = Date.now()): RefreshDecision {
  if (!rows.length) return { state: "allowed" };

  const latest = [...rows].sort((a, b) => b.started_at.localeCompare(a.started_at))[0];
  const ageMs = nowMs - new Date(latest.started_at).getTime();

  if (latest.status === "running" && ageMs <= STUCK_MINUTES * 60000) {
    return { state: "running" };
  }
  if (ageMs < MANUAL_COOLDOWN_MS) {
    return { state: "cooldown", retryAfterSeconds: Math.ceil((MANUAL_COOLDOWN_MS - ageMs) / 1000) };
  }
  return { state: "allowed" };
}
