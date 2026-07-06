import { type NextRequest, NextResponse } from "next/server";

/**
 * Salesforce → Supabase sync endpoint (scaffold — real sync lands with IAI-212).
 *
 * Two triggers, two auth schemes:
 *  - Vercel Cron:      GET  with `Authorization: Bearer ${CRON_SECRET}` (Vercel sends this
 *                      automatically when the CRON_SECRET env var is set)
 *  - Manual refresh:   POST with `x-relay-sync-key: ${RELAY_SYNC_KEY}` (rate limiting
 *                      arrives with IAI-212)
 */
export const maxDuration = 300;

function unauthorized() {
  return NextResponse.json({ error: "unauthorized" }, { status: 401 });
}

function notImplemented() {
  return NextResponse.json(
    { error: "sync not implemented yet — see IAI-212" },
    { status: 501 }
  );
}

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return unauthorized();
  }
  return notImplemented();
}

export async function POST(req: NextRequest) {
  const key = process.env.RELAY_SYNC_KEY;
  if (!key || req.headers.get("x-relay-sync-key") !== key) {
    return unauthorized();
  }
  return notImplemented();
}
