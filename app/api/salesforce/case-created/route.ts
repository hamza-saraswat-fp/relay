import { type NextRequest, NextResponse, after } from "next/server";
import { getServiceClient } from "@/lib/supabase";
import { runSync } from "@/lib/sync";
import { onboardingSyncDecision, type SyncRunRow } from "@/lib/health";

/**
 * Salesforce case-create → link endpoint (IAI-237).
 *
 * The onboarding-app pattern: a Salesforce automation fires when a case is created and
 * POSTs the account id here (bearer-authenticated). We upsert the account, mint a
 * permanent token if it's new (idempotent — same account always returns the same link),
 * and return the tracker URL; the SF automation writes it to `Relay_Tracker_Link__c`.
 *
 * We then pull that account's tickets in the background (IAI-474). Without it the link is
 * live but empty: cases only arrived on the 2-hourly cron, so a customer opening the link
 * their rep just sent was told "you are all caught up" about the ticket they had just filed.
 *
 * Scope: NEW cases going forward only — no backfill of existing accounts.
 */
export const maxDuration = 300;

/** Recent runs, newest first — same shape/limit as the Refresh endpoint's gate query. */
async function recentRuns(): Promise<SyncRunRow[]> {
  const supabase = getServiceClient();
  const { data } = await supabase
    .from("sync_runs")
    .select("started_at, finished_at, status, cases_upserted, error, scope")
    .order("started_at", { ascending: false })
    .limit(80);
  return (data ?? []) as SyncRunRow[];
}

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
    .select("id, token")
    .single();

  if (error || !data?.token) {
    console.error("[relay] case-created upsert failed:", error);
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }

  // NOTE: `accountId` above is the SALESFORCE id. `runSync` scopes on the Supabase accounts.id
  // uuid — passing the wrong one yields a silent no-op run, so keep the two names distinct.
  const relayAccountId = data.id as string;

  // Pull this account's tickets now rather than waiting for the cron (IAI-474). Runs after the
  // response is sent, so Salesforce sees the same latency and the same { trackerUrl } body.
  const decision = onboardingSyncDecision(await recentRuns(), relayAccountId);
  if (decision === "sync") {
    after(async () => {
      try {
        await runSync({ accountId: relayAccountId });
      } catch (err) {
        // runSync already records + alerts on failure; never let this reject unhandled.
        console.error("[relay] case-created background sync failed:", err);
      }
    });
  } else {
    console.log(`[relay] case-created: skipping sync (${decision})`);
  }

  const origin = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/+$/, "") ?? new URL(req.url).origin;
  return NextResponse.json({ trackerUrl: `${origin}/t/${data.token}` }, { status: 200 });
}
