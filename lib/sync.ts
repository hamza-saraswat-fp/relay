import { getServiceClient } from "./supabase";
import { runBulkQuery } from "./salesforce";
import { statusToChip } from "./status";
import { cleanUpdate } from "./update-cleaner";
import { notifySyncFailure } from "./alert";

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

/** Salesforce record ids are 15 or 18 case-sensitive alphanumeric chars. Guards the SOQL IN() list
 *  against a malformed id (e.g. a leftover seed row) that would otherwise fail the whole Bulk query. */
function isSalesforceId(id: string): boolean {
  return /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/.test(id);
}

/**
 * Cases for accounts we already track. Scope is strict event-only: an account enters Relay only
 * via the case-created endpoint, so the sync reads cases only for known accounts and never
 * introduces new ones. We pull each known account's full current open set (+ closed in the last
 * 30 days) every run rather than a LastModifiedDate delta — the known-account set is small under
 * event-only onboarding, and a delta would miss a newly-added account's older-but-still-open cases.
 */
function caseSoql(accountIds: string[]): string {
  const ids = accountIds.map((id) => `'${id}'`).join(",");
  return (
    `SELECT Id, CaseNumber, Subject, Status, CreatedDate, ClosedDate, LastModifiedDate, ` +
    `IsClosed, Resolution__c, AccountId, Account.Name, Account.ParentId ` +
    `FROM Case WHERE Type IN ${CASE_TYPES} AND AccountId IN (${ids}) ` +
    `AND (IsClosed = false OR ClosedDate = LAST_N_DAYS:30)`
  );
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

  // Strict event-only: the sync operates ONLY on accounts already minted via the case-created
  // endpoint. It never creates accounts (that would be a backfill). If none exist yet, there is
  // nothing to sync.
  const { data: knownAccts, error: knownErr } = await supabase
    .from("accounts")
    .select("id, sf_account_id");
  if (knownErr) {
    await notifySyncFailure({ error: knownErr.message });
    return { status: "error", casesUpserted: 0, accountsUpserted: 0, error: knownErr.message };
  }
  const acctIdBySf = new Map((knownAccts ?? []).map((a) => [a.sf_account_id as string, a.id as string]));
  const knownSf = [...acctIdBySf.keys()].filter(isSalesforceId);
  const skipped = acctIdBySf.size - knownSf.length;
  if (skipped) console.warn(`[relay] sync: skipping ${skipped} account(s) with malformed sf_account_id`);

  const { data: run } = await supabase
    .from("sync_runs")
    .insert({ status: "running" })
    .select("id")
    .single();
  const runId = run?.id as string | undefined;

  try {
    // No tracked accounts yet → nothing to pull. Finish the run cleanly.
    if (knownSf.length === 0) {
      if (runId) {
        await supabase
          .from("sync_runs")
          .update({ finished_at: new Date().toISOString(), cases_upserted: 0, status: "ok" })
          .eq("id", runId);
      }
      return { status: "ok", casesUpserted: 0, accountsUpserted: 0 };
    }

    // 1. Pull cases for known accounts only; guard against any stray non-tracked account.
    const knownSet = new Set(knownSf);
    const rawCaseRows = await runBulkQuery(caseSoql(knownSf));
    const caseRows = rawCaseRows.filter((c) => knownSet.has(c.AccountId));

    // 2. Refresh tracked accounts' name/parent. Update-only: every AccountId here is already known,
    //    so this upsert can never insert a new account. Tokens are DB-minted and never touched here.
    const accountsBySf = new Map<string, Record<string, string>>();
    for (const c of caseRows) accountsBySf.set(c.AccountId, c);
    const accountUpserts = [...accountsBySf.values()].map((c) => ({
      sf_account_id: c.AccountId,
      name: c["Account.Name"] || "(unknown)",
      parent_sf_id: c["Account.ParentId"] || null,
      updated_at: new Date().toISOString(),
    }));
    if (accountUpserts.length) {
      const { error: acctErr } = await supabase
        .from("accounts")
        .upsert(accountUpserts, { onConflict: "sf_account_id" });
      if (acctErr) throw acctErr;
    }

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
    await notifySyncFailure({ error: message, runId });
    return { status: "error", casesUpserted: 0, accountsUpserted: 0, error: message };
  }
}
