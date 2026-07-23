import { type NextRequest, NextResponse, after } from "next/server";
import { runSync } from "@/lib/sync";
import { getServiceClient } from "@/lib/supabase";
import { refreshGate, type SyncRunRow } from "@/lib/health";

/**
 * Customer-facing "Refresh" endpoint (IAI-396).
 *
 * Auth is the page token itself — the unguessable UUID is the capability credential, exactly like
 * the page it's clicked from. (The internal manual refresh, `POST /api/sync`, authenticates with
 * RELAY_SYNC_KEY, a secret that must never reach a browser.)
 *
 * A sync takes ~4 minutes, far longer than a browser fetch should wait, so the work is handed to
 * `after()` (Next 15) and the client polls GET until the run it triggered has finished.
 *
 * Rate limiting is GLOBAL via `refreshGate` — one sync refreshes every account, so a recent run by
 * anyone means this customer's data is already fresh. Non-'allowed' outcomes are success states,
 * never errors.
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

/** Resolve a page token to a tracked account. Returns false for anything unrecognized. */
async function tokenIsValid(token: unknown): Promise<boolean> {
  if (typeof token !== "string" || !UUID_RE.test(token)) return false;
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("accounts")
    .select("id")
    .eq("token", token)
    .maybeSingle();
  return !error && Boolean(data);
}

async function latestRuns(): Promise<SyncRunRow[]> {
  const supabase = getServiceClient();
  const { data } = await supabase
    .from("sync_runs")
    .select("started_at, finished_at, status, cases_upserted, error")
    .order("started_at", { ascending: false })
    .limit(5);
  return (data ?? []) as SyncRunRow[];
}

export async function POST(req: NextRequest) {
  let token: unknown;
  try {
    token = (await req.json())?.token;
  } catch {
    return notFound();
  }
  if (!(await tokenIsValid(token))) return notFound();

  const decision = refreshGate(await latestRuns());
  if (decision.state === "running") {
    return NextResponse.json({ state: "refreshing" }, { status: 200 });
  }
  if (decision.state === "cooldown") {
    return NextResponse.json(
      { state: "fresh", retryAfterSeconds: decision.retryAfterSeconds },
      { status: 200 },
    );
  }

  // Respond immediately; the sync runs after the response is sent (bounded by maxDuration).
  after(async () => {
    try {
      await runSync();
    } catch (err) {
      // runSync already records + alerts on failure; never let this reject unhandled.
      console.error("[relay] background refresh sync failed:", err);
    }
  });
  return NextResponse.json({ state: "started" }, { status: 202 });
}

/** Poll target for the button: the newest run, so the client knows when its refresh finished. */
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token");
  if (!(await tokenIsValid(token))) return notFound();

  const [latest] = await latestRuns();
  return NextResponse.json(
    latest
      ? { startedAt: latest.started_at, finishedAt: latest.finished_at, status: latest.status }
      : { startedAt: null, finishedAt: null, status: null },
    { status: 200 },
  );
}
