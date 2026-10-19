import { type NextRequest, NextResponse, after } from "next/server";
import { runSync } from "@/lib/sync";
import { accountIdForToken } from "@/lib/data";
import { getServiceClient } from "@/lib/supabase";
import { refreshGate, scopedRefreshAllowed, type SyncRunRow } from "@/lib/health";
import { TRACKER_COOKIE, parseTrackerCookie } from "@/lib/tracker-session";

/**
 * Customer-facing "Refresh" endpoint (IAI-396, per-account scoping IAI-398).
 *
 * Auth is the httpOnly tracker cookie minted by `/t/[token]` — the page token never reaches
 * browser JS, so the request carries no body and no query string; same-origin `fetch` sends the
 * cookie implicitly. (The internal manual refresh, `POST /api/sync`, authenticates with
 * RELAY_SYNC_KEY, a secret that must never reach a browser.)
 *
 * A click syncs ONLY that account (Salesforce → Supabase), then the client polls GET until the
 * run it triggered has finished. Unrelated pages are fully independent: the 10-min cooldown is
 * per account (a recent FULL cron run also counts — it covered this account too), and one page's
 * click never consumes another's budget. A global safety valve caps scoped refreshes org-wide so
 * worst-case Bulk API load stays bounded no matter how many accounts exist.
 *
 * Accepted race: two simultaneous POSTs can both pass the gate and start overlapping syncs. That's
 * benign — every write in `runSync` is an idempotent upsert — so it isn't worth a lock.
 */
export const maxDuration = 300;

function notFound() {
  // Deliberately generic: never confirm whether a token exists, never log the token itself.
  return NextResponse.json({ error: "not found" }, { status: 404 });
}

/** Resolve the caller's account from the httpOnly tracker cookie, or null for anything else. */
async function accountIdFromRequest(req: NextRequest): Promise<string | null> {
  const token = parseTrackerCookie(req.cookies.get(TRACKER_COOKIE)?.value);
  return token ? accountIdForToken(token) : null;
}

/** Recent runs, newest first — enough rows to cover the 1-hour safety-valve window. */
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
  // The body is deliberately ignored: a tab rendered before this deploy may still POST `{token}`,
  // and keeping a body-token path would keep the credential in the client contract.
  const accountId = await accountIdFromRequest(req);
  if (!accountId) return notFound();

  const runs = await recentRuns();

  // Global safety valve first: org-wide ceiling on scoped syncs, regardless of account.
  if (!scopedRefreshAllowed(runs)) {
    return NextResponse.json({ state: "busy" }, { status: 200 });
  }

  const decision = refreshGate(runs, accountId);
  if (decision.state === "running") {
    return NextResponse.json({ state: "refreshing" }, { status: 200 });
  }
  if (decision.state === "cooldown") {
    return NextResponse.json(
      { state: "fresh", retryAfterSeconds: decision.retryAfterSeconds },
      { status: 200 },
    );
  }

  // Respond immediately; the scoped sync runs after the response is sent (bounded by maxDuration).
  after(async () => {
    try {
      await runSync({ accountId });
    } catch (err) {
      // runSync already records + alerts on failure; never let this reject unhandled.
      console.error("[relay] background refresh sync failed:", err);
    }
  });
  return NextResponse.json({ state: "started" }, { status: 202 });
}

/** Poll target for the button: the newest run COVERING this account (its own scoped refreshes or
 *  a full sync), so the client reloads on ITS refresh — never on some other account's. */
export async function GET(req: NextRequest) {
  const accountId = await accountIdFromRequest(req);
  if (!accountId) return notFound();

  const covering = (await recentRuns()).filter(
    (r) => (r.scope ?? "full") === "full" || r.scope === accountId,
  );
  const [latest] = covering;
  return NextResponse.json(
    latest
      ? { startedAt: latest.started_at, finishedAt: latest.finished_at, status: latest.status }
      : { startedAt: null, finishedAt: null, status: null },
    { status: 200 },
  );
}
