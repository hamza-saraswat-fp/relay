/**
 * Microsoft Clarity usage analytics for the customer tracker page.
 *
 * The project id is public by nature (it ships in the HTML of every site that uses Clarity), so it
 * is a constant here rather than an env var. Whether Clarity LOADS at all is decided server-side in
 * `app/tracker/page.tsx`: only when `VERCEL_ENV === "production"`, so previews and local dev never
 * send anything. Dashboard: https://clarity.microsoft.com/projects/view/z07u6fm8le
 *
 * Privacy posture: the page URL carries no credential (see `lib/tracker-session.ts`), sessions are
 * tagged with Supabase `accounts.id` (not the token), and customer content (account name, ticket
 * subjects, update text) is masked with `data-clarity-mask` so recordings show behavior, not content.
 */
export const CLARITY_PROJECT_ID = "z07u6fm8le";

declare global {
  interface Window {
    clarity?: (...args: unknown[]) => void;
  }
}

/** Where the visitor came from, from `document.referrer`. Drives the "Customers" segment. */
export function entrySource(referrer: string): "salesforce" | "webmail" | "direct" | "other" {
  if (!referrer) return "direct";
  if (/\.(force|salesforce)\.com/i.test(referrer)) return "salesforce";
  if (/mail\.google\.com|outlook\.(live|office)\.com|mail\.yahoo\.com|mail\.proton\.me/i.test(referrer)) {
    return "webmail";
  }
  return "other";
}

/** Coarse open-ticket count so the tag has a handful of filterable values, not a number per page. */
export function bucket(n: number): "0" | "1-2" | "3-5" | "6+" {
  return n === 0 ? "0" : n <= 2 ? "1-2" : n <= 5 ? "3-5" : "6+";
}

/** Fire a named Clarity event. No-op when Clarity isn't loaded (preview, dev, blocked, or errored). */
export function track(event: string): void {
  try {
    if (typeof window !== "undefined" && typeof window.clarity === "function") {
      window.clarity("event", event);
    }
  } catch {
    // Analytics must never affect the page.
  }
}
