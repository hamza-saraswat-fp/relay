import { type NextRequest, NextResponse, after } from "next/server";
import { runSync } from "@/lib/sync";
import { getServiceClient } from "@/lib/supabase";
import { refreshGate, scopedRefreshAllowed, type SyncRunRow } from "@/lib/health";

/**
 * Customer-facing "Refresh" endpoint (IAI-396, per-account scoping IAI-398).
 *
 * Auth is the page token itself — the unguessable UUID is the capability credential, exactly like
 * the page it's clicked from. (The internal manual refresh, `POST /api/sync`, authenticates with
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function notFound() {
  // Deliberately generic: never confirm whether a token exists, never log the token itself.
  return NextResponse.json({ error: "not found" }, { status: 404 });
}

/** Resolve a page token to the tracked account's id, or null for anything unrecognized. */
async function accountIdForToken(token: unknown): Promise<string | null> {
  if (typeof token !== "string" || !UUID_RE.test(token)) return null;
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("accounts")
    .select("id")
    .eq("token", token)
    .maybeSingle();
  if (error || !data) return null;
  return data.id as string;
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
  let token: unknown;
  try {
    token = (await req.json())?.token;
  } catch {
    return notFound();
  }
  const accountId = await accountIdForToken(token);
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
  const accountId = await accountIdForToken(req.nextUrl.searchParams.get("token"));
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
