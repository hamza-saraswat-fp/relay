import { type NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";

/**
 * Salesforce case-create → link endpoint (IAI-237).
 *
 * The onboarding-app pattern: a Salesforce automation fires when a case is created and
 * POSTs the account id here (bearer-authenticated). We upsert the account, mint a
 * permanent token if it's new (idempotent — same account always returns the same link),
 * and return the tracker URL; the SF automation writes it to `Relay_Tracker_Link__c`.
 *
 * Scope: NEW cases going forward only — no backfill of existing accounts.
 */
export async function POST(req: NextRequest) {
  const key = process.env.SALESFORCE_INTEGRATION_KEY;
  if (!key || req.headers.get("authorization") !== `Bearer ${key}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { accountId?: string; accountName?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const accountId = body.accountId?.trim();
  if (!accountId) {
    return NextResponse.json({ error: "accountId is required" }, { status: 400 });
  }

  const supabase = getServiceClient();

  // Idempotent: upsert on sf_account_id. New rows get a token from the DB default
  // (gen_random_uuid()); existing rows keep their token (we don't set it here).
  const { data, error } = await supabase
    .from("accounts")
    .upsert(
      {
        sf_account_id: accountId,
        name: body.accountName?.trim() || "(unknown)",
        updated_at: new Date().toISOString(),
      },
      { onConflict: "sf_account_id" },
    )
    .select("token")
    .single();

  if (error || !data?.token) {
    console.error("[relay] case-created upsert failed:", error);
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }

  const origin = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/+$/, "") ?? new URL(req.url).origin;
  return NextResponse.json({ trackerUrl: `${origin}/t/${data.token}` }, { status: 200 });
}
