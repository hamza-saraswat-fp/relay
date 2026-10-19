import { type NextRequest, NextResponse } from "next/server";
import { accountIdForToken } from "@/lib/data";
import { isUuid, trackerCookieAttrs, trackerCookieClearAttrs } from "@/lib/tracker-session";

/**
 * Entry point for the permanent customer link `/t/{token}` (the URL Salesforce stores forever).
 *
 * It no longer renders the page. It validates the token, stores it in an httpOnly cookie, and
 * 302-redirects to `/tracker`, which renders from the cookie. Result: the credential never appears
 * in the address bar, browser history, client-side JS, or an analytics payload.
 *
 * - Unknown or malformed token → same redirect, but the cookie is CLEARED, so `/tracker` fails
 *   closed with its branded 404 and a stale cookie from an earlier link can't show another account.
 * - Always 302, never 301/308: browsers cache permanent redirects, which would skip cookie
 *   re-issue for a customer whose cookie has expired.
 * - Relative `Location` + explicit no-store: a cached redirect would also skip the cookie.
 * - Two different links opened in one browser: last one wins (single cookie). Fine for CS agents
 *   clicking from Salesforce, who re-enter through the link every time.
 */
export const dynamic = "force-dynamic";

/**
 * `?internal=1` is the one query flag forwarded through the redirect: our own test visits carry it
 * so analytics can tag them as internal. Nothing else from the entry URL is propagated.
 */
function redirectToTracker(internal: boolean): NextResponse {
  return new NextResponse(null, {
    status: 302,
    headers: {
      Location: internal ? "/tracker?internal=1" : "/tracker",
      "Cache-Control": "private, no-store",
    },
  });
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ token: string }> },
): Promise<NextResponse> {
  const { token } = await ctx.params;
  const production = process.env.NODE_ENV === "production";
  const res = redirectToTracker(req.nextUrl.searchParams.get("internal") === "1");

  let known = false;
  if (isUuid(token)) {
    try {
      known = (await accountIdForToken(token.toLowerCase())) !== null;
    } catch (err) {
      // Fail closed. Never log the token itself.
      console.error("[relay] tracker entry lookup failed:", err);
    }
  }

  res.cookies.set(
    known ? trackerCookieAttrs(token.toLowerCase(), { production }) : trackerCookieClearAttrs({ production }),
  );
  return res;
}
