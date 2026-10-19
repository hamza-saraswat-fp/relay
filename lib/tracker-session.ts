/**
 * Tracker session cookie — pure helpers (no Next imports, so scripts/test-lib.ts can exercise them).
 *
 * The permanent customer link `/t/{token}` is the only credential. It is now an ENTRY POINT only:
 * `app/t/[token]/route.ts` validates the token, stores it in this httpOnly cookie, and redirects to
 * `/tracker`, which renders from the cookie. The token therefore never sits in the address bar,
 * browser history, client-side JavaScript, or any analytics payload (the reason this exists: a
 * third-party analytics script uploads `location.href`).
 *
 * The cookie value is the token itself — never `accounts.id`. That id is handed to analytics as a
 * join key, so it must not be able to mint access.
 */

export const TRACKER_COOKIE = "relay_tracker";

/** One year. Re-issued on every pass through `/t/{token}`, so an active customer never expires. */
export const TRACKER_COOKIE_MAX_AGE_S = 60 * 60 * 24 * 365;

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(s: unknown): s is string {
  return typeof s === "string" && UUID_RE.test(s);
}

/** Cookie value → normalized (lowercase) token, or null for missing/garbage. No trimming leniency. */
export function parseTrackerCookie(raw: string | undefined | null): string | null {
  return isUuid(raw) ? raw.toLowerCase() : null;
}

export interface TrackerCookieAttrs {
  name: string;
  value: string;
  httpOnly: true;
  secure: boolean;
  sameSite: "lax";
  path: "/";
  maxAge: number;
}

/**
 * Set-Cookie attributes for a valid token.
 * - `httpOnly`: the browser's JS never sees it (the Refresh button sends it implicitly).
 * - `sameSite: "lax"`: the customer arrives by a cross-site click (email client → `/t/{token}`),
 *   and Lax still sends the cookie on the follow-up top-level GET to `/tracker`. `strict` would not.
 * - `secure` only in production: `next dev` runs over plain http.
 */
export function trackerCookieAttrs(token: string, opts: { production: boolean }): TrackerCookieAttrs {
  return {
    name: TRACKER_COOKIE,
    value: token,
    httpOnly: true,
    secure: opts.production,
    sameSite: "lax",
    path: "/",
    maxAge: TRACKER_COOKIE_MAX_AGE_S,
  };
}

/** Same name/path with an empty value and maxAge 0 — clears a stale cookie from an earlier link. */
export function trackerCookieClearAttrs(opts: { production: boolean }): TrackerCookieAttrs {
  return { ...trackerCookieAttrs("", opts), value: "", maxAge: 0 };
}
