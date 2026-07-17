import type { AccountView, StatusChip, Ticket } from "./types";
import { SEED_ACCOUNTS } from "./seed";
import { SAFE_FALLBACK, containsSensitive } from "./update-cleaner";

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
  if (!account) return null;

  const { data: rows, error: caseErr } = await supabase
    .from("cases")
    .select(
      "subject, status_chip, created_date, last_modified, closed_date, case_updates(cleaned_update, safety_flag, email_message_at, email_subject)"
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
      lastReplyISO: (upd?.email_message_at as string | null) ?? undefined,
      emailSubject: safeSubject(upd?.email_subject as string | null | undefined),
    };
  });

  return {
    name: account.name as string,
    lastUpdatedISO: account.updated_at as string,
    tickets,
  };
}

/**
 * The email subject is shown verbatim on the PUBLIC page (IAI-318), so it passes the same
 * deterministic scrubber as cleaned updates: if a subject somehow carries a dollar amount, email,
 * or phone number, drop it (the reference line still shows the date). Trims and collapses
 * whitespace; empty → undefined.
 */
export function safeSubject(raw: string | null | undefined): string | undefined {
  const s = raw?.replace(/\s+/g, " ").trim();
  if (!s) return undefined;
  return containsSensitive(s) ? undefined : s;
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
        "Our team is actively working on this ticket — we'll post an update here as soon as there's news." +
        (hasHiddenEmail ? HIDDEN_EMAIL_SUFFIX : "")
      );
    case "waiting_for_you":
      return "We're waiting on a reply from you to keep this moving — check your email thread for our latest message.";
    case "waiting_for_support":
      return (
        "This ticket is in our support queue — we'll post an update here once our team picks it up." +
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
