import { type NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";
import { syncHealth, type SyncRunRow } from "@/lib/health";

/**
 * Sync health check (IAI-239). Read-only view over `sync_runs`.
 *
 * Returns 200 when healthy, **503 when stuck/stale/error/never_run** — so an uptime monitor pointed
 * here (sending the ops key header) auto-alerts. This is the backstop for silent timeouts, which the
 * Slack alert can't catch (a killed function runs no code).
 *
 * Auth: `x-relay-sync-key: $RELAY_SYNC_KEY` (the same ops key as the manual sync).
 */
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const key = process.env.RELAY_SYNC_KEY;
  if (!key || req.headers.get("x-relay-sync-key") !== key) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const supabase = getServiceClient();
  // Full runs only (IAI-398): health watches the CRON. Filtering here (not just in the
  // classifier) also keeps customer scoped refreshes from crowding full runs out of the window.
  const { data, error } = await supabase
    .from("sync_runs")
    .select("started_at, finished_at, status, cases_upserted, error, scope")
    .eq("scope", "full")
    .order("started_at", { ascending: false })
    .limit(20);
  if (error) {
    return NextResponse.json({ state: "error", healthy: false, error: error.message }, { status: 503 });
  }

  const health = syncHealth((data ?? []) as SyncRunRow[]);
  return NextResponse.json(health, { status: health.healthy ? 200 : 503 });
}
