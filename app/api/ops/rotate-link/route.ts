import { type NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";
import { trackerUrlFor } from "@/lib/tracker-session";

/**
 * Revoke a customer's tracker link and mint its replacement (ops only).
 *
 * Auth: `x-relay-sync-key: $RELAY_SYNC_KEY` (same ops key as /api/stats and the manual sync).
 * Body `{ "sfAccountId": "001…" }` → `{ trackerUrl }` carrying a fresh token. 404 if Relay doesn't
 * track that account.
 *
 * The old link dies immediately: every request resolves its token with its own uncached lookup
 * (`accountIdForToken` for `/t/{token}`, `/api/refresh` and `/api/view`; `getAccountView` for
 * `/tracker`), so the old URL and any browser cookie still holding the old token fall through to
 * the branded 404 on their next request.
 *
 * Also bumps `updated_at`, so the new link opens even if the old one had already expired
 * (`isLinkExpired`).
 *
 * Relay can't write to Salesforce, and Salesforce never overwrites a populated
 * `Relay_Tracker_Link__c`, so the returned URL has to be put on the Account by hand. Runbook:
 * README, "Rotating a customer link".
 */
export const dynamic = "force-dynamic";

/** Salesforce record ids are 15 or 18 case-sensitive alphanumeric chars. */
const SF_ID_RE = /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/;

export async function POST(req: NextRequest) {
  const key = process.env.RELAY_SYNC_KEY;
  if (!key || req.headers.get("x-relay-sync-key") !== key) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { sfAccountId?: unknown } | null;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const sfAccountId = typeof body?.sfAccountId === "string" ? body.sfAccountId.trim() : "";
  if (!SF_ID_RE.test(sfAccountId)) {
    return NextResponse.json(
      { error: "sfAccountId must be a Salesforce Account Id (15 or 18 characters)" },
      { status: 400 },
    );
  }

  const token = crypto.randomUUID();
  try {
    const { data, error } = await getServiceClient()
      .from("accounts")
      .update({ token, updated_at: new Date().toISOString() })
      .eq("sf_account_id", sfAccountId)
      .select("id")
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      return NextResponse.json({ error: "no tracked account with that sfAccountId" }, { status: 404 });
    }
    // Never log the token itself.
    console.log(`[relay] rotate-link: replaced the link for account ${data.id as string}`);
  } catch (err) {
    console.error("[relay] rotate-link update failed:", err);
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }

  return NextResponse.json(
    { trackerUrl: trackerUrlFor(token, req.url) },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
}
