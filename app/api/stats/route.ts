import { type NextRequest, NextResponse } from "next/server";
import { clampDays } from "@/lib/page-views";
import { getServiceClient } from "@/lib/supabase";

/**
 * Usage stats for leadership (IAI-465, page-views slice). Read-only; one call to the
 * `relay_usage_stats(window_days)` SQL function from migration 0004.
 *
 * Auth: `x-relay-sync-key: $RELAY_SYNC_KEY` (same ops key as /api/health and the manual sync).
 * `?days=` clamps to 1..365, default 30. 503 if the function is missing (migration not applied).
 *
 * Headline is `activeAccountsViewed / activeAccounts` (spec OM-4). "Customer" excludes internal
 * test visits, CS click-throughs from Salesforce, and bots. `trackingSince` is when data starts —
 * "ever viewed" means since then, not since launch.
 */
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const key = process.env.RELAY_SYNC_KEY;
  if (!key || req.headers.get("x-relay-sync-key") !== key) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const windowDays = clampDays(req.nextUrl.searchParams.get("days"));
  const { data, error } = await getServiceClient().rpc("relay_usage_stats", { window_days: windowDays });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  return NextResponse.json(data, { status: 200, headers: { "Cache-Control": "no-store" } });
}
