import { type NextRequest, NextResponse } from "next/server";
import { runSync } from "@/lib/sync";
import { getServiceClient } from "@/lib/supabase";
import { MANUAL_COOLDOWN_MS } from "@/lib/health";

/**
 * Salesforce → Supabase sync endpoint (IAI-212).
 *  - Vercel Cron:    GET  with `Authorization: Bearer ${CRON_SECRET}`
 *  - Manual refresh: POST with `x-relay-sync-key: ${RELAY_SYNC_KEY}` (rate-limited ≥10 min)
 */
export const maxDuration = 300;

function unauthorized() {
  return NextResponse.json({ error: "unauthorized" }, { status: 401 });
}

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return unauthorized();
  }
  const result = await runSync();
  return NextResponse.json(result, { status: result.status === "ok" ? 200 : 500 });
}

export async function POST(req: NextRequest) {
  const key = process.env.RELAY_SYNC_KEY;
  if (!key || req.headers.get("x-relay-sync-key") !== key) {
    return unauthorized();
  }

  // Rate limit: reject if any run started within the cooldown window.
  const supabase = getServiceClient();
  const { data: recent } = await supabase
    .from("sync_runs")
    .select("started_at")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (recent?.started_at) {
    const age = Date.now() - new Date(recent.started_at as string).getTime();
    if (age < MANUAL_COOLDOWN_MS) {
      const retryAfter = Math.ceil((MANUAL_COOLDOWN_MS - age) / 1000);
      return NextResponse.json(
        { error: "sync ran recently — try again shortly", retryAfterSeconds: retryAfter },
        { status: 429 },
      );
    }
  }

  const result = await runSync();
  return NextResponse.json(result, { status: result.status === "ok" ? 200 : 500 });
}
