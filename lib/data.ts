import type { AccountView, StatusChip, Ticket } from "./types";
import { SEED_ACCOUNTS } from "./seed";
import { UUID_RE, isLinkExpired } from "./tracker-session";
import { SAFE_FALLBACK } from "./update-cleaner";

/**
 * Single data-access seam for the customer page. Reads live Supabase when
 * `SUPABASE_URL` is configured; otherwise serves seed fixtures so the page is
 * buildable and viewable with no external services (comp-intel pattern).
 *
 * The page imports ONLY this — never the Supabase client directly.
 */
export async function getAccountView(token: string): Promise<AccountView | null> {
  if (process.env.SUPABASE_URL) {
    return getAccountViewFromSupabase(token);
  }
  return SEED_ACCOUNTS[token] ?? null;
}

/**
 * Resolve a page token to the tracked account's id, or null for anything unrecognized or expired
 * (`isLinkExpired`). Shared by the `/t/[token]` entry route, `/api/refresh` and `/api/view`.
 * Seed-aware like `getAccountView`; seed links never expire.
 */
export async function accountIdForToken(token: string): Promise<string | null> {
  if (!UUID_RE.test(token)) return null;
  if (!process.env.SUPABASE_URL) return SEED_ACCOUNTS[token]?.accountId ?? null;
  const { getServiceClient } = await import("./supabase");
  const { data, error } = await getServiceClient()
    .from("accounts")
    .select("id, updated_at")
    .eq("token", token)
    .maybeSingle();
  if (error || !data) return null;
  if (isLinkExpired(data.updated_at as string)) return null;
  return data.id as string;
}

async function getAccountViewFromSupabase(
  token: string
): Promise<AccountView | null> {
  const { getServiceClient } = await import("./supabase");
  const supabase = getServiceClient();

  const { data: account, error } = await supabase
    .from("accounts")
    .select("id, name, updated_at")
    .eq("token", token)
    .maybeSingle();
  if (error) throw error;
  // Expired renders exactly like unknown: the page's branded 404, never a hint the token existed.
  if (!account || isLinkExpired(account.updated_at as string)) return null;

  const { data: rows, error: caseErr } = await supabase
    .from("cases")
    .select(
      "subject, status_chip, created_date, last_modified, closed_date, case_updates(cleaned_update, safety_flag, email_message_at)"
    )
    .eq("account_id", account.id);
  if (caseErr) throw caseErr;

  const tickets: Ticket[] = (rows ?? []).map((r) => {
    const upd = Array.isArray(r.case_updates) ? r.case_updates[0] : r.case_updates;
    const chip = r.status_chip as StatusChip;
    return {
      subject: r.subject as string,
      chip,
      openedISO: r.created_date as string,
      lastActivityISO: r.last_modified as string,
      resolvedDateISO: (r.closed_date as string | null) ?? undefined,
      latestUpdate: cleanedOrFallback(upd, chip),
    };
  });

  return {
    accountId: account.id as string,
    name: account.name as string,
    lastUpdatedISO: account.updated_at as string,
    tickets,
  };
}

/** A hidden email exists (flagged/suppressed) — the thread has real content worth pointing at. */
const HIDDEN_EMAIL_SUFFIX = " The full details are in your email thread.";

/**
 * Status-aware fallback copy (IAI-316). Shown when there is no publishable cleaned update —
 * either no outbound email exists yet, or the cleaner failed closed. Must never contradict the
 * status chip rendered next to it (the pilot's "check your email" on an "Our team is on it"
 * ticket problem).
 */
export function fallbackFor(chip: StatusChip, hasHiddenEmail: boolean): string {
  switch (chip) {
    case "in_progress":
      return (
        "Our team is actively working on this ticket. We'll post an update here as soon as there's news." +
        (hasHiddenEmail ? HIDDEN_EMAIL_SUFFIX : "")
      );
    case "waiting_for_you":
      return "We're waiting on a reply from you to keep this moving. Check your email thread for our latest message.";
    case "waiting_for_support":
      return (
        "This ticket is in our support queue. We'll post an update here once our team picks it up." +
        (hasHiddenEmail ? HIDDEN_EMAIL_SUFFIX : "")
      );
    case "resolved":
      return "This ticket has been resolved. If anything still looks off, just reply to your email thread.";
  }
}

export function cleanedOrFallback(
  upd:
    | {
        cleaned_update?: string | null;
        safety_flag?: boolean | null;
        email_message_at?: string | null;
      }
    | null
    | undefined,
  chip: StatusChip
): string {
  const noRealBlurb =
    !upd || upd.safety_flag || !upd.cleaned_update || upd.cleaned_update === SAFE_FALLBACK;
  if (noRealBlurb) return fallbackFor(chip, Boolean(upd?.email_message_at));
  return upd.cleaned_update as string;
}
