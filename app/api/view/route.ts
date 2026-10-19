import { type NextRequest, NextResponse, after } from "next/server";
import { accountIdForToken } from "@/lib/data";
import { deviceClass, parseViewBody, recordPageView } from "@/lib/page-views";
import { TRACKER_COOKIE, parseTrackerCookie } from "@/lib/tracker-session";

/**
 * Page-view beacon target (IAI-465, page-views slice). `app/tracker/ViewBeacon.tsx` POSTs here once
 * per page load; scanners that don't run JavaScript never reach it.
 *
 * The account comes ONLY from the httpOnly tracker cookie (same as /api/refresh) — the client never
 * supplies an account id, so nobody can inflate another account's numbers. The body carries just
 * the coarse `entry` class and the `internal` flag, both allowlist-validated. The insert runs after
 * the response, and every failure is swallowed.
 */
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const token = parseTrackerCookie(req.cookies.get(TRACKER_COOKIE)?.value);
  const accountId = token ? await accountIdForToken(token) : null;
  if (!accountId) {
    // Deliberately generic, same as /api/refresh: never confirm whether a token exists.
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  let raw: unknown = null;
  try {
    // sendBeacon may not set a JSON content-type, so parse the text ourselves.
    raw = JSON.parse(await req.text());
  } catch {
    raw = null;
  }
  const body = parseViewBody(raw);
  if (!body) return NextResponse.json({ error: "bad request" }, { status: 400 });

  const device = deviceClass(req.headers.get("user-agent"));
  after(() => recordPageView(accountId, { ...body, device }));
  return new NextResponse(null, { status: 204 });
}
