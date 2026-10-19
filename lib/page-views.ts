/**
 * First-party page views (IAI-465, page-views slice). One `page_views` row per real customer view of
 * `/tracker`, keyed by `accounts.id` — the per-account usage number Clarity can't provide.
 *
 * Recorded by a browser beacon (`app/tracker/ViewBeacon.tsx` → `POST /api/view`), not on server
 * render, so email link scanners that follow the link without running JavaScript don't count.
 * Read back through `relay_usage_stats()` (migration 0004) via `GET /api/stats`.
 *
 * Privacy: no IP, cookie id, or raw user agent is stored. `device` is a coarse class computed here,
 * server-side; `entry` is the coarse referrer class the page already computes for Clarity.
 * Everything except `recordPageView` is pure, so scripts/test-lib.ts can cover it.
 */

export type Entry = "salesforce" | "webmail" | "direct" | "other";
export type Device = "mobile" | "tablet" | "desktop" | "bot" | "unknown";

export const ENTRY_VALUES: readonly Entry[] = ["salesforce", "webmail", "direct", "other"];

// Crawlers, link scanners, uptime monitors, headless browsers, and plain HTTP clients.
const BOT_RE =
  /bot\b|bot\/|crawl|spider|slurp|headless|phantomjs|puppeteer|playwright|lighthouse|pingdom|uptime|monitor|scanner|safelinks|proofpoint|mimecast|barracuda|facebookexternalhit|preview|python-requests|python-urllib|curl\/|wget\/|go-http-client|okhttp|java\/|httpclient|node-fetch|axios\//i;

/** Coarse device class from a user-agent string. The raw string is never stored. */
export function deviceClass(ua: string | null | undefined): Device {
  if (!ua || !ua.trim()) return "unknown";
  if (BOT_RE.test(ua)) return "bot";
  // Android without "Mobile" is a tablet by convention. iPadOS 13+ reports as Mac → desktop (accepted).
  if (/ipad|tablet|kindle|silk\//i.test(ua) || (/android/i.test(ua) && !/mobile/i.test(ua))) return "tablet";
  if (/mobi|iphone|ipod|android|windows phone|blackberry|opera mini/i.test(ua)) return "mobile";
  return "desktop";
}

/** Validate the beacon body. Anything unexpected → null (the route answers 400, nothing is written). */
export function parseViewBody(raw: unknown): { entry: Entry; internal: boolean } | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { entry, internal } = raw as Record<string, unknown>;
  if (typeof entry !== "string" || !(ENTRY_VALUES as readonly string[]).includes(entry)) return null;
  if (typeof internal !== "boolean") return null;
  return { entry: entry as Entry, internal };
}

/** `?days=` for /api/stats: integer 1..365, default 30. */
export function clampDays(raw: string | null | undefined): number {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(n)) return 30;
  return Math.min(365, Math.max(1, n));
}

/**
 * Insert one view. Never throws: analytics must never affect the page or the request that carried it.
 * No-op without Supabase (seed/offline mode and the offline test harness).
 */
export async function recordPageView(
  accountId: string,
  view: { entry: Entry; internal: boolean; device: Device },
): Promise<void> {
  if (!process.env.SUPABASE_URL) return;
  try {
    const { getServiceClient } = await import("./supabase");
    const { error } = await getServiceClient().from("page_views").insert({
      account_id: accountId,
      entry: view.entry,
      internal: view.internal,
      device: view.device,
    });
    if (error) console.error("[relay] page view insert failed:", error.message);
  } catch (err) {
    console.error("[relay] page view insert threw:", err);
  }
}
