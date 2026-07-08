import { getServiceClient } from "./supabase";
import { runBulkQuery } from "./salesforce";
import { statusToChip } from "./status";
import { cleanUpdate } from "./update-cleaner";

/**
 * Salesforce → Supabase sync (IAI-212). READ-ONLY against Salesforce: pulls cases +
 * their latest outbound email via Bulk API 2.0, maps status, cleans the update text,
 * and upserts into the Supabase read-store. Never writes to Salesforce and never mints
 * tokens (that's the case-create endpoint, IAI-237).
 */

const CASE_TYPES = "('Technical Support','Quickbooks Tech Support')";

export interface SyncResult {
  status: "ok" | "error";
  casesUpserted: number;
  accountsUpserted: number;
  error?: string;
}

function caseSoql(since: string | null): string {
  const base =
    `SELECT Id, CaseNumber, Subject, Status, CreatedDate, ClosedDate, LastModifiedDate, ` +
    `IsClosed, Resolution__c, AccountId, Account.Name, Account.ParentId ` +
    `FROM Case WHERE Type IN ${CASE_TYPES} AND AccountId != null ` +
    `AND (IsClosed = false OR ClosedDate = LAST_N_DAYS:30)`;
  return since ? `${base} AND LastModifiedDate >= ${since}` : base;
}

function emailSoql(caseIds: string[]): string {
  const ids = caseIds.map((id) => `'${id}'`).join(",");
  return (
    `SELECT ParentId, MessageDate, TextBody, HtmlBody FROM EmailMessage ` +
    `WHERE Incoming = false AND ParentId IN (${ids}) ORDER BY MessageDate DESC`
  );
}

/** Newest outbound email per case (rows arrive MessageDate DESC, so first wins). */
function latestOutboundByCase(rows: Record<string, string>[]): Map<string, Record<string, string>> {
  const map = new Map<string, Record<string, string>>();
  for (const r of rows) {
    if (!map.has(r.ParentId)) map.set(r.ParentId, r);
  }
  return map;
}

function stripHtml(s: string): string {
  return s
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

export async function runSync(): Promise<SyncResult> {
  const supabase = getServiceClient();

  const { data: lastRun } = await supabase
    .from("sync_runs")
    .select("finished_at")
    .eq("status", "ok")
    .order("finished_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const since = (lastRun?.finished_at as string | undefined) ?? null;

  const { data: run } = await supabase
    .from("sync_runs")
    .insert({ status: "running" })
    .select("id")
    .single();
  const runId = run?.id as string | undefined;

  try {
    // 1. Pull cases.
    const caseRows = await runBulkQuery(caseSoql(since));

    // 2. Upsert accounts, get back id ↔ sf_account_id (tokens are minted by the DB default; never touched here).
    const accountsBySf = new Map<string, Record<string, string>>();
    for (const c of caseRows) accountsBySf.set(c.AccountId, c);
    const accountUpserts = [...accountsBySf.values()].map((c) => ({
      sf_account_id: c.AccountId,
      name: c["Account.Name"] || "(unknown)",
      parent_sf_id: c["Account.ParentId"] || null,
      updated_at: new Date().toISOString(),
    }));
    const { data: accts, error: acctErr } = await supabase
      .from("accounts")
      .upsert(accountUpserts, { onConflict: "sf_account_id" })
      .select("id, sf_account_id");
    if (acctErr) throw acctErr;
    const acctIdBySf = new Map((accts ?? []).map((a) => [a.sf_account_id as string, a.id as string]));

    // 3. Latest outbound email per changed case (for the "latest update").
    const caseIds = caseRows.map((c) => c.Id);
    const emailRows = caseIds.length ? await runBulkQuery(emailSoql(caseIds)) : [];
    const latestEmail = latestOutboundByCase(emailRows);

    // 4. Upsert cases + case_updates.
    const caseUpserts = caseRows.map((c) => ({
      sf_case_id: c.Id,
      account_id: acctIdBySf.get(c.AccountId),
      case_number: c.CaseNumber || null,
      subject: c.Subject || "(no subject)",
      status_raw: c.Status,
      status_chip: statusToChip(c.Status),
      created_date: c.CreatedDate,
      closed_date: c.ClosedDate || null,
      last_modified: c.LastModifiedDate,
      is_closed: c.IsClosed === "true",
      updated_at: new Date().toISOString(),
    }));
    const { data: cases, error: caseErr } = await supabase
      .from("cases")
      .upsert(caseUpserts, { onConflict: "sf_case_id" })
      .select("id, sf_case_id");
    if (caseErr) throw caseErr;
    const caseIdBySf = new Map((cases ?? []).map((c) => [c.sf_case_id as string, c.id as string]));

    // 5. Clean + store the customer-facing update for each changed case.
    for (const c of caseRows) {
      const caseId = caseIdBySf.get(c.Id);
      if (!caseId) continue;
      const email = latestEmail.get(c.Id);
      const resolved = statusToChip(c.Status) === "resolved";
      const source =
        resolved && c.Resolution__c
          ? stripHtml(c.Resolution__c)
          : email
            ? stripHtml(email.TextBody || email.HtmlBody || "")
            : "";
      try {
        const cleaned = await cleanUpdate(source);
        await supabase.from("case_updates").upsert(
          {
            case_id: caseId,
            email_message_at: email?.MessageDate || null,
            raw_body: source || null,
            cleaned_update: cleaned.cleaned,
            safety_flag: cleaned.safetyFlag,
            cleaned_at: new Date().toISOString(),
            model: cleaned.model,
          },
          { onConflict: "case_id" },
        );
      } catch (err) {
        // One bad update must not fail the whole sync.
        console.error(`[relay] update clean failed for case ${c.Id}:`, err);
      }
    }

    if (runId) {
      await supabase
        .from("sync_runs")
        .update({
          finished_at: new Date().toISOString(),
          cases_upserted: caseUpserts.length,
          status: "ok",
        })
        .eq("id", runId);
    }

    return {
      status: "ok",
      casesUpserted: caseUpserts.length,
      accountsUpserted: accountUpserts.length,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (runId) {
      await supabase
        .from("sync_runs")
        .update({ finished_at: new Date().toISOString(), status: "error", error: message })
        .eq("id", runId);
    }
    return { status: "error", casesUpserted: 0, accountsUpserted: 0, error: message };
  }
}
