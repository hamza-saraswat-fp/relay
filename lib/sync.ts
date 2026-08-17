import { getServiceClient } from "./supabase";
import { runBulkQuery } from "./salesforce";
import { statusToChip } from "./status";
import { cleanUpdate, SAFE_FALLBACK } from "./update-cleaner";
import { notifySyncFailure } from "./alert";
import type { StatusChip } from "./types";

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
 *
 * Status = 'Merged' is excluded at the source (IAI-566, Tory's steer): a merged case is a
 * duplicate shell whose content lives on in its parent case, so surfacing it as a "Resolved"
 * ticket is noise. The `Merged → resolved` chip mapping stays in lib/status.ts as a safe default
 * for any row that slips through.
 *
 * Exported for the SOQL-content tests in scripts/test-lib.ts.
 */
export function caseSoql(accountIds: string[]): string {
  const ids = accountIds.map((id) => `'${id}'`).join(",");
  return (
    `SELECT Id, CaseNumber, Subject, Status, Type, CreatedDate, ClosedDate, LastModifiedDate, ` +
    `IsClosed, Resolution__c, AccountId, Account.Name, Account.ParentId ` +
    `FROM Case WHERE Type IN ${CASE_TYPES} AND AccountId IN (${ids}) ` +
    `AND Status != 'Merged' AND (IsClosed = false OR ClosedDate = LAST_N_DAYS:30)`
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

/** Prior state for one case, as stored by the previous sync. */
export interface PriorUpdate {
  chip?: StatusChip;
  rawBody?: string | null;
  cleanedUpdate?: string | null;
  safetyFlag?: boolean | null;
}

/**
 * Should this case's update be re-cleaned by the LLM? (IAI-396)
 *
 * The sync pulls every tracked case each run, but re-cleaning unchanged tickets burns ~2 model
 * calls apiece for an identical result — untenable once the cron runs every 2h. Re-clean only when
 * the output could actually differ:
 *  - nothing stored yet;
 *  - the source email/resolution text changed;
 *  - the status chip changed (the blurb's framing must follow the chip — see IAI-316);
 *  - it was safety-flagged, or it fell back *despite having source text* — a retry can still heal
 *    those (preserves the pre-existing self-healing behaviour for transient infra failures).
 *
 * A case with no outbound email at all stores the fallback permanently and legitimately, so it is
 * NOT a retry candidate — otherwise those tickets would rewrite their row on every single run.
 */
export function needsReclean(
  prev: PriorUpdate | undefined,
  next: { source: string; chip: StatusChip },
): boolean {
  if (!prev || prev.cleanedUpdate == null) return true;
  if ((prev.rawBody ?? "") !== next.source) return true;
  if (prev.chip !== next.chip) return true;
  if (prev.safetyFlag) return true;
  if (prev.cleanedUpdate === SAFE_FALLBACK && next.source.trim()) return true;
  return false;
}

/** One existing Supabase case row, as considered by reconciliation. */
export interface ReconcileRow {
  id: string;
  sfCaseId: string;
  accountId: string;
}

export interface ReconcileDecision {
  toDeleteIds: string[];
  blocked: boolean;
  reason?: string;
}

/** Deletions of ≤ this many rows are always allowed — covers normal churn and a small account
 *  legitimately going to zero (all its cases aged out), which a fraction cap alone would deadlock. */
export const RECONCILE_SMALL_MAX = 20;
/** Above the small-max, refuse to delete more than this fraction of the covered rows in one run. */
export const RECONCILE_MAX_DELETE_FRACTION = 0.3;
/** Hard per-run ceiling regardless of fraction. */
export const RECONCILE_ABS_MAX = 100;

/**
 * Which stored case rows should this sync remove, and is it safe to? (IAI-565) Pure.
 *
 * The Bulk result IS the authoritative in-scope set for the accounts it covered: a stored case
 * that no longer appears has been deleted, merged, re-typed out of tech support, reassigned, or
 * resolved >30 days ago — all of which previously accumulated forever and rendered on customer
 * pages (34% of accounts showed at least one phantom row when this shipped).
 *
 * Deleting from a query result demands that a truncated-but-"successful" result can never mass-
 * wipe, hence the caps: an empty/half result fails the fraction and absolute caps and deletes
 * NOTHING (the guard working, not a failure — the next run retries); ordinary churn and small
 * accounts clearing out entirely pass via the small-max. Scoped runs have a small covered set, so
 * they're naturally conservative; the full cron, with the whole table as denominator, is the
 * sweeper that picks up anything a blocked scoped run left behind.
 *
 * Only rows in `coveredAccountIds` are ever candidates — a scoped run is structurally incapable
 * of touching other accounts' rows, and accounts skipped from the SOQL for a malformed
 * sf_account_id are never diffed (their absence from the result proves nothing).
 */
export function reconcileDecision(
  existingRows: ReconcileRow[],
  returnedSfIds: Set<string>,
  coveredAccountIds: Set<string>,
): ReconcileDecision {
  const covered = existingRows.filter((r) => coveredAccountIds.has(r.accountId));
  const candidates = covered.filter((r) => !returnedSfIds.has(r.sfCaseId));
  if (candidates.length === 0) return { toDeleteIds: [], blocked: false };

  const allowance = Math.max(
    RECONCILE_SMALL_MAX,
    Math.min(RECONCILE_MAX_DELETE_FRACTION * covered.length, RECONCILE_ABS_MAX),
  );
  if (candidates.length > allowance) {
    return {
      toDeleteIds: [],
      blocked: true,
      reason:
        `would delete ${candidates.length} of ${covered.length} covered rows ` +
        `(allowance ${Math.floor(allowance)}: small=${RECONCILE_SMALL_MAX}, ` +
        `fraction=${RECONCILE_MAX_DELETE_FRACTION}, abs=${RECONCILE_ABS_MAX})`,
    };
  }
  return { toDeleteIds: candidates.map((r) => r.id), blocked: false };
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

/** Optional per-account scoping (IAI-398): a customer Refresh syncs ONLY their account. */
export interface SyncScope {
  /** Supabase accounts.id — recorded as sync_runs.scope. */
  accountId: string;
}

/**
 * Bulk-poll budget for a SCOPED run, shared across both queries (IAI-567).
 *
 * The 2026-08-11 onboarding failure: org-wide Bulk queue congestion held a healthy job in
 * InProgress past the default 90s poll budget, so a brand-new account's page stayed empty.
 * 90s is right for the cron — it runs two queries PLUS cleans hundreds of tickets inside the
 * same 300s maxDuration — but a scoped run cleans at most a handful and typically finishes in
 * ~17s total, so it can afford to out-wait congestion. 200s SHARED across both sequential
 * queries (an absolute deadline, not per-query — two 200s budgets could total 400s and recreate
 * the exact hard-kill this avoids) leaves ~100s for cleaning and upserts.
 */
export const SCOPED_POLL_BUDGET_MS = 200 * 1000;

export async function runSync(scope?: SyncScope): Promise<SyncResult> {
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
  // Scoped run (customer Refresh): narrow to that one already-tracked account. An unknown id
  // just yields an empty set → clean no-op "ok" run below.
  const scopedAccts = scope
    ? (knownAccts ?? []).filter((a) => a.id === scope.accountId)
    : (knownAccts ?? []);
  const acctIdBySf = new Map(scopedAccts.map((a) => [a.sf_account_id as string, a.id as string]));
  const knownSf = [...acctIdBySf.keys()].filter(isSalesforceId);
  const skipped = acctIdBySf.size - knownSf.length;
  if (skipped) console.warn(`[relay] sync: skipping ${skipped} account(s) with malformed sf_account_id`);

  const { data: run } = await supabase
    .from("sync_runs")
    .insert({ status: "running", scope: scope?.accountId ?? "full" })
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
    // Scoped runs get one shared, longer poll deadline across both Bulk queries (IAI-567);
    // full cron runs keep the default per-query budget (undefined → 90s inside runBulkQuery).
    const pollDeadline = scope ? Date.now() + SCOPED_POLL_BUDGET_MS : undefined;
    // Snapshot taken BEFORE the bulk query — reconciliation later only considers rows written
    // before this instant, so a case onboarded by a concurrent scoped sync (whose row this run's
    // already-started query can't contain) is never mistaken for stale (IAI-565).
    const syncStartedAt = new Date().toISOString();
    const knownSet = new Set(knownSf);
    const rawCaseRows = await runBulkQuery(caseSoql(knownSf), { deadlineMs: pollDeadline });
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
    const emailRows = caseIds.length
      ? await runBulkQuery(emailSoql(caseIds), { deadlineMs: pollDeadline })
      : [];
    const latestEmail = latestOutboundByCase(emailRows);

    // 3b. Prior state for the skip-unchanged guard. MUST be read BEFORE the upsert below, which
    //     overwrites status_chip — after it, the "previous" chip is gone.
    const { data: priorCases } = caseIds.length
      ? await supabase.from("cases").select("id, sf_case_id, status_chip").in("sf_case_id", caseIds)
      : { data: [] };
    const priorCaseBySf = new Map(
      (priorCases ?? []).map((c) => [c.sf_case_id as string, c as Record<string, unknown>]),
    );
    const priorCaseIds = (priorCases ?? []).map((c) => c.id as string);
    const { data: priorUpdates } = priorCaseIds.length
      ? await supabase
          .from("case_updates")
          .select("case_id, raw_body, cleaned_update, safety_flag")
          .in("case_id", priorCaseIds)
      : { data: [] };
    const priorUpdateByCaseId = new Map(
      (priorUpdates ?? []).map((u) => [u.case_id as string, u as Record<string, unknown>]),
    );

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

    // 5. Clean + store the customer-facing update — but only where it could have changed.
    let recleaned = 0;
    let skipped = 0;
    for (const c of caseRows) {
      const caseId = caseIdBySf.get(c.Id);
      if (!caseId) continue;
      const email = latestEmail.get(c.Id);
      const chip = statusToChip(c.Status);
      const resolved = chip === "resolved";
      const source =
        resolved && c.Resolution__c
          ? stripHtml(c.Resolution__c)
          : email
            ? stripHtml(email.TextBody || email.HtmlBody || "")
            : "";

      // Skip-unchanged guard (IAI-396): identical source + chip → identical blurb, so don't pay
      // for the model calls or rewrite the row.
      const priorCase = priorCaseBySf.get(c.Id);
      const priorUpd = priorCase ? priorUpdateByCaseId.get(priorCase.id as string) : undefined;
      const prev = priorCase
        ? {
            chip: priorCase.status_chip as StatusChip,
            rawBody: (priorUpd?.raw_body as string | null) ?? null,
            cleanedUpdate: (priorUpd?.cleaned_update as string | null) ?? null,
            safetyFlag: (priorUpd?.safety_flag as boolean | null) ?? null,
          }
        : undefined;
      if (!needsReclean(prev, { source, chip })) {
        skipped++;
        continue;
      }

      recleaned++;
      try {
        const cleaned = await cleanUpdate(source, {
          statusChip: chip,
          subject: c.Subject,
          caseType: c.Type,
          emailDate: email?.MessageDate,
        });
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
    console.log(`[relay] sync: ${recleaned} update(s) re-cleaned, ${skipped} unchanged (skipped)`);

    // 6. Reconcile: remove stored cases the query no longer returns (IAI-565) — deleted, merged,
    //    re-typed out of tech support, reassigned, or resolved >30d. Runs LAST, only on a run that
    //    has proven healthy end-to-end (everything above throws into the catch below on failure,
    //    so a broken pull can never feed the diff), and its own failure never fails the run —
    //    reconciliation is idempotent and the next run retries. case_updates rows follow via the
    //    schema's on-delete cascade.
    try {
      let existingQuery = supabase
        .from("cases")
        .select("id, sf_case_id, account_id")
        .lt("updated_at", syncStartedAt);
      if (scope) existingQuery = existingQuery.eq("account_id", scope.accountId);
      const { data: existing, error: existingErr } = await existingQuery;
      if (existingErr) throw existingErr;

      const decision = reconcileDecision(
        (existing ?? []).map((r) => ({
          id: r.id as string,
          sfCaseId: r.sf_case_id as string,
          accountId: r.account_id as string,
        })),
        new Set(caseRows.map((c) => c.Id)),
        new Set(knownSf.map((sf) => acctIdBySf.get(sf)!)),
      );

      if (decision.blocked) {
        console.warn(`[relay] sync: reconcile BLOCKED — ${decision.reason}`);
      } else {
        let deleted = 0;
        for (let i = 0; i < decision.toDeleteIds.length; i += 100) {
          const batch = decision.toDeleteIds.slice(i, i + 100);
          const { data: gone, error: delErr } = await supabase
            .from("cases")
            .delete()
            .in("id", batch)
            .select("id");
          if (delErr) {
            // Partial deletion is fine — the remainder goes next run.
            console.error("[relay] sync: reconcile delete batch failed:", delErr);
            continue;
          }
          deleted += gone?.length ?? 0;
        }
        console.log(`[relay] sync: reconcile deleted ${deleted} stale case(s)`);
      }
    } catch (err) {
      console.error("[relay] sync: reconcile failed:", err);
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
