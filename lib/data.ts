import type { AccountView, StatusChip, Ticket } from "./types";
import { SEED_ACCOUNTS } from "./seed";

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
      "subject, status_chip, created_date, last_modified, closed_date, case_updates(cleaned_update, safety_flag)"
    )
    .eq("account_id", account.id);
  if (caseErr) throw caseErr;

  const tickets: Ticket[] = (rows ?? []).map((r) => {
    const upd = Array.isArray(r.case_updates) ? r.case_updates[0] : r.case_updates;
    return {
      subject: r.subject as string,
      chip: r.status_chip as StatusChip,
      openedISO: r.created_date as string,
      lastActivityISO: r.last_modified as string,
      resolvedDateISO: (r.closed_date as string | null) ?? undefined,
      latestUpdate: cleanedOrFallback(upd),
    };
  });

  return {
    name: account.name as string,
    lastUpdatedISO: account.updated_at as string,
    tickets,
  };
}

const SAFE_FALLBACK =
  "Our team posted an update on this ticket — check your email thread for details.";

function cleanedOrFallback(
  upd: { cleaned_update?: string | null; safety_flag?: boolean | null } | null | undefined
): string {
  if (!upd || upd.safety_flag || !upd.cleaned_update) return SAFE_FALLBACK;
  return upd.cleaned_update;
}
