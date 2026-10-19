/**
 * Relay UAT test harness (docs/relay-test-plan.md).
 *
 * Self-logging + diagnose-don't-fix: each test is isolated; a failure is recorded with a
 * diagnosis and the run continues. NOTHING is fixed here — outputs are a raw JSONL log and a
 * human-readable markdown report. Fixes happen in a separate pass after the run.
 *
 * Run:  set -a; . ./.env.local; set +a; npx tsx scripts/uat-test-run.ts
 * Targets: deployed prod app (points at UAT SF) for HTTP/page tests; direct lib calls for sync/cleaner.
 */
import fs from "node:fs";
import path from "node:path";
import { runSync } from "../lib/sync";
import { cleanUpdate, SAFE_FALLBACK } from "../lib/update-cleaner";
import { statusToChip } from "../lib/status";
import { getServiceClient } from "../lib/supabase";
import { EMAIL_FIXTURES } from "../lib/fixtures/emails";

const BASE = "https://mytickets.fieldpulse.com";
const KNOWN = { ivan: "001Ec000022j96ZIAQ", ricks: "001U100000c1eVNIAY" };

const sb = getServiceClient();
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const day = new Date().toISOString().slice(0, 10);
const outDir = path.join(process.cwd(), "..", "docs");
const runsDir = path.join(outDir, "test-runs");
fs.mkdirSync(runsDir, { recursive: true });
const jsonlPath = path.join(runsDir, `uat-${stamp}.jsonl`);
const reportPath = path.join(outDir, `relay-uat-test-run-${day}.md`);
const logStream = fs.createWriteStream(jsonlPath, { flags: "a" });

interface Rec {
  id: string; name: string; target: string; startedAt: string;
  input?: unknown; expected: string; actual?: unknown;
  verdict: "PASS" | "FAIL" | "BLOCKED"; diagnosis?: string;
}
const records: Rec[] = [];
function push(r: Rec) {
  records.push(r);
  logStream.write(JSON.stringify(r) + "\n");
  console.log(`[${r.verdict}] ${r.id}  ${r.name}`);
  if (r.verdict === "FAIL") console.log(`        ↳ ${r.diagnosis}`);
}

type Outcome = { pass: boolean; actual?: unknown; input?: unknown; diagnosis?: string };
async function test(id: string, name: string, target: string, expected: string, fn: () => Promise<Outcome>) {
  const startedAt = new Date().toISOString();
  try {
    const o = await fn();
    push({ id, name, target, startedAt, input: o.input, expected, actual: o.actual,
      verdict: o.pass ? "PASS" : "FAIL", diagnosis: o.pass ? undefined : o.diagnosis });
  } catch (err) {
    // Diagnose-don't-fix: an unexpected throw is itself a documented finding; keep going.
    push({ id, name, target, startedAt, expected, verdict: "FAIL",
      diagnosis: `Unexpected error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}` });
  }
}
function blocked(id: string, name: string, reason: string) {
  push({ id, name, target: "salesforce", startedAt: new Date().toISOString(),
    expected: "n/a (requires SF write access)", verdict: "BLOCKED", diagnosis: reason });
}

// ---- helpers ----
function testAcctId(seed: string): string {
  const body = (seed.replace(/[^A-Za-z0-9]/g, "").toUpperCase() + "0".repeat(15)).slice(0, 15);
  return "001" + body; // 18-char, alphanumeric, 001 (Account) prefix — verified SF-IN()-safe
}
function extractToken(url?: string): string | null {
  const m = url ? /\/t\/([0-9a-f-]{36})/i.exec(url) : null;
  return m ? m[1] : null;
}
async function callCaseCreated(body: unknown, key = process.env.SALESFORCE_INTEGRATION_KEY) {
  const res = await fetch(`${BASE}/api/salesforce/case-created`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  let json: any = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, json };
}
async function getPage(p: string, cookie?: string) {
  const res = await fetch(`${BASE}${p}`, cookie ? { headers: { cookie } } : undefined);
  return { status: res.status, text: await res.text() };
}
/** Walk the customer entry flow by hand: /t/{token} → 302 + Set-Cookie → GET /tracker with it. */
async function openTracker(token: string) {
  const entry = await fetch(`${BASE}/t/${token}`, { redirect: "manual" });
  const setCookie = entry.headers.get("set-cookie") ?? "";
  const cookie = setCookie.split(";")[0]; // "relay_tracker=<token>" (or "relay_tracker=" when cleared)
  const page = await getPage("/tracker", cookie);
  return { entryStatus: entry.status, location: entry.headers.get("location"), setCookie, ...page };
}
let sfTok: { access_token: string; instance_url: string } | null = null;
async function sfRest(soql: string): Promise<any> {
  if (!sfTok) {
    const r = await fetch(`${process.env.SF_INSTANCE_URL}/services/oauth2/token`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials",
        client_id: process.env.SF_CLIENT_ID!, client_secret: process.env.SF_CLIENT_SECRET! }),
    });
    if (!r.ok) throw new Error(`SF auth ${r.status}: ${await r.text()}`);
    sfTok = await r.json();
  }
  const res = await fetch(`${sfTok!.instance_url}/services/data/v60.0/query?q=${encodeURIComponent(soql)}`,
    { headers: { Authorization: `Bearer ${sfTok!.access_token}` } });
  const body = await res.json();
  if (!res.ok) throw new Error(`SF ${res.status}: ${JSON.stringify(body)}`);
  return body;
}
async function ricksUpdates() {
  const { data: acct } = await sb.from("accounts").select("id").eq("sf_account_id", KNOWN.ricks).maybeSingle();
  const { data } = await sb.from("cases").select("case_updates(cleaned_update,safety_flag)").eq("account_id", acct?.id);
  return (data ?? []).map((c: any) => (Array.isArray(c.case_updates) ? c.case_updates[0] : c.case_updates)).filter(Boolean);
}

// Stable test-account ids (recognizable, cleaned up post-run)
const idA1 = testAcctId("UATTESTA1");
const idA6 = testAcctId("UATTESTA6");
const idA8 = testAcctId("UATA8" + Date.now().toString(36)); // fresh per run for a real race
const createdIds = [idA1, idA6, idA8];

const SPEC: Record<string, string> = {
  "Waiting for Customer": "waiting_for_you",
  New: "waiting_for_support", "Waiting for Support": "waiting_for_support",
  "In Progress": "in_progress", Hold: "in_progress", Monitoring: "in_progress",
  "Waiting for CS": "in_progress", "Waiting for Sync": "in_progress", "Waiting on Engineering": "in_progress",
  Closed: "resolved", "Cannot Reproduce": "resolved", Rejected: "resolved", Merged: "resolved",
};
const CRAFTED_SENSITIVE = [
  "Hi Dale, we issued a refund of $4,120.55 to your Amex ending 3345. Best, Support",
  "For reference, another customer (Rivera HVAC, acct 55231) hit the same bug last week.",
  "Internal note: do NOT tell the customer we lost their data. Handle quietly and escalate.",
  "Reconnect using API key sk_live_ABC123DEF456GHI and your temporary password Hunter2!.",
  "Call me directly at (602) 555-0148 or email me personally at bobthetech@gmail.com.",
];

async function main() {
  console.log(`\nRelay UAT test run — ${stamp}\nTarget: ${BASE}\nRaw log: ${jsonlPath}\n`);

  // ---------- A. Case-create endpoint ----------
  await test("A1e", "New account via endpoint", "endpoint",
    "200 + /t/<uuid>; Supabase account row whose token matches the returned link", async () => {
      const { status, json } = await callCaseCreated({ accountId: idA1, accountName: "UAT Test A1" });
      const tok = extractToken(json?.trackerUrl);
      const { data } = await sb.from("accounts").select("token").eq("sf_account_id", idA1).maybeSingle();
      const pass = status === 200 && !!tok && !!data?.token && data.token === tok;
      return { input: { accountId: idA1 }, actual: { status, trackerUrl: json?.trackerUrl, dbToken: data?.token },
        pass, diagnosis: `status=${status} linkToken=${tok} dbToken=${data?.token} (want 200 + equal tokens)` };
    });

  await test("A2e", "Idempotency — same account → same link", "endpoint",
    "identical token both calls; exactly one row", async () => {
      const a = await callCaseCreated({ accountId: idA1, accountName: "UAT Test A1" });
      const b = await callCaseCreated({ accountId: idA1, accountName: "UAT Test A1 v2" });
      const t1 = extractToken(a.json?.trackerUrl), t2 = extractToken(b.json?.trackerUrl);
      const { count } = await sb.from("accounts").select("token", { count: "exact", head: true }).eq("sf_account_id", idA1);
      const pass = !!t1 && t1 === t2 && count === 1;
      return { actual: { t1, t2, rowCount: count }, pass, diagnosis: `t1=${t1} t2=${t2} rows=${count} (want equal + 1)` };
    });

  await test("A5e", "Missing accountId → 400", "endpoint", "HTTP 400", async () => {
    const { status, json } = await callCaseCreated({});
    return { actual: { status, json }, pass: status === 400, diagnosis: `got ${status}, want 400` };
  });

  await test("A6e", "Blank name → \"(unknown)\"", "endpoint", "200; Supabase name = (unknown)", async () => {
    const { status } = await callCaseCreated({ accountId: idA6 });
    const { data } = await sb.from("accounts").select("name").eq("sf_account_id", idA6).maybeSingle();
    const pass = status === 200 && data?.name === "(unknown)";
    return { actual: { status, name: data?.name }, pass, diagnosis: `status=${status} name=${data?.name} (want 200 + "(unknown)")` };
  });

  await test("A7e", "Wrong bearer → 401, nothing written", "endpoint", "401; no row", async () => {
    const idA7 = testAcctId("UATTESTA7NOAUTH");
    const { status } = await callCaseCreated({ accountId: idA7, accountName: "should not persist" }, "WRONG-KEY-123");
    const { data } = await sb.from("accounts").select("id").eq("sf_account_id", idA7).maybeSingle();
    const pass = status === 401 && !data;
    return { actual: { status, rowExists: !!data }, pass, diagnosis: `status=${status} rowExists=${!!data} (want 401 + none)` };
  });

  await test("A8e", "Concurrency — one token under race", "endpoint", "5 parallel POSTs → exactly one token", async () => {
    const res = await Promise.all(Array.from({ length: 5 }, () => callCaseCreated({ accountId: idA8, accountName: "UAT race" })));
    const tokens = new Set(res.map((r) => extractToken(r.json?.trackerUrl)).filter(Boolean));
    const { count } = await sb.from("accounts").select("token", { count: "exact", head: true }).eq("sf_account_id", idA8);
    const statuses = res.map((r) => r.status);
    const pass = tokens.size === 1 && count === 1 && statuses.every((s) => s === 200);
    return { actual: { distinctTokens: [...tokens], rowCount: count, statuses }, pass,
      diagnosis: `distinctTokens=${tokens.size} rows=${count} statuses=${statuses.join(",")} (want 1/1/all-200)` };
  });

  // ---------- B. Sync + cleaner ----------
  await test("B1", "Sync populates tracked accounts (+ duration)", "sync",
    "runSync ok; ivan358 & Ricks have cases with valid chips", async () => {
      // Pre-flight: make sure our fake test ids don't break the SOQL IN() (would poison every sync).
      let idSafe = true, safeErr = "";
      try { await sfRest(`SELECT Id FROM Case WHERE AccountId IN (${createdIds.map((i) => `'${i}'`).join(",")}) LIMIT 1`); }
      catch (e) { idSafe = false; safeErr = String(e); }
      const t0 = Date.now();
      const result = await runSync();
      const durationMs = Date.now() - t0;
      const chips = new Set(["waiting_for_you", "waiting_for_support", "in_progress", "resolved"]);
      const counts: Record<string, number> = {};
      let chipsOk = true;
      for (const [k, sfid] of Object.entries(KNOWN)) {
        const { data: a } = await sb.from("accounts").select("id").eq("sf_account_id", sfid).maybeSingle();
        const { data: cs } = await sb.from("cases").select("status_chip").eq("account_id", a?.id);
        counts[k] = (cs ?? []).length;
        if ((cs ?? []).some((c: any) => !chips.has(c.status_chip))) chipsOk = false;
      }
      const pass = result.status === "ok" && idSafe && counts.ivan >= 1 && counts.ricks >= 1 && chipsOk;
      return { actual: { syncStatus: result.status, durationMs, cases: counts, chipsOk, idSafe }, pass,
        diagnosis: `sync=${result.status}${result.error ? ` (${result.error})` : ""} idSafe=${idSafe}${safeErr ? ` (${safeErr})` : ""} ivan=${counts.ivan} ricks=${counts.ricks} chipsOk=${chipsOk}` };
    });

  await test("B2", "Status→chip mapping vs Saffi's spec (live statuses)", "sync",
    "every status currently on UAT tech cases maps per spec; none silently default", async () => {
      const res = await sfRest(`SELECT Status FROM Case WHERE Type IN ('Technical Support','Quickbooks Tech Support') AND AccountId != null GROUP BY Status`);
      const statuses: string[] = res.records.map((r: any) => r.Status);
      const mismatches: string[] = [], unmapped: string[] = [];
      for (const s of statuses) {
        const got = statusToChip(s);
        if (s in SPEC) { if (got !== SPEC[s]) mismatches.push(`${s}: got ${got}, spec ${SPEC[s]}`); }
        else unmapped.push(`${s}→${got}(default)`);
      }
      const pass = mismatches.length === 0;
      return { actual: { liveStatuses: statuses, mismatches, unmappedUsingDefault: unmapped }, pass,
        diagnosis: pass ? `note: ${unmapped.length} live status(es) rely on the in_progress default — ${unmapped.join("; ") || "none"}`
          : `MAPPING MISMATCH: ${mismatches.join("; ")}` };
    });

  await test("B3", "Outbound email → real cleaned update", "cleaner",
    "≥1 Ricks case_update has real text (flag=false, ≠ fallback)", async () => {
      const ups = await ricksUpdates();
      const real = ups.filter((u: any) => !u.safety_flag && u.cleaned_update && u.cleaned_update !== SAFE_FALLBACK);
      return { actual: { total: ups.length, real: real.length, sample: real[0]?.cleaned_update?.slice(0, 90) },
        pass: real.length >= 1, diagnosis: `real=${real.length} of ${ups.length} (want ≥1)` };
    });

  await test("B4", "SAFETY GATE — sensitive content never rendered", "cleaner",
    "every sensitive input → safety_flag + exact fallback", async () => {
      const inputs = [
        ...EMAIL_FIXTURES.filter((f) => f.mustFlag).map((f) => ({ label: f.label, raw: f.raw })),
        ...CRAFTED_SENSITIVE.map((raw, i) => ({ label: `crafted-${i + 1}`, raw })),
      ];
      const leaks: string[] = [];
      for (const s of inputs) {
        const r = await cleanUpdate(s.raw);
        if (!r.safetyFlag || r.cleaned !== SAFE_FALLBACK) leaks.push(`${s.label}: flag=${r.safetyFlag} out="${r.cleaned.slice(0, 60)}"`);
      }
      return { actual: { tested: inputs.length, leaks: leaks.length, detail: leaks }, pass: leaks.length === 0,
        diagnosis: `SENSITIVE NOT FLAGGED (${leaks.length}/${inputs.length}): ${leaks.join(" | ")}` };
    });

  await test("B5", "No outbound email → generic fallback", "cleaner",
    "≥1 Ricks case renders the fallback line (flag=false)", async () => {
      const ups = await ricksUpdates();
      const fb = ups.filter((u: any) => !u.safety_flag && u.cleaned_update === SAFE_FALLBACK);
      return { actual: { fallback: fb.length, total: ups.length }, pass: fb.length >= 1,
        diagnosis: `fallback(flag=false)=${fb.length} of ${ups.length} (want ≥1)` };
    });

  await test("B6", "Resolved 30-day window enforced", "sync",
    "no stored closed case older than ~31 days", async () => {
      const { data } = await sb.from("cases").select("case_number,closed_date").eq("is_closed", true);
      const cutoff = Date.now() - 31 * 864e5;
      const stale = (data ?? []).filter((c: any) => c.closed_date && new Date(c.closed_date).getTime() < cutoff);
      return { actual: { closedStored: (data ?? []).length, staleBeyond31d: stale.length, examples: stale.slice(0, 5).map((c: any) => c.case_number) },
        pass: stale.length === 0, diagnosis: `stale closed cases retained: ${stale.length}` };
    });

  // ---------- C. Page / access ----------
  await test("C1", "Valid token → cookie → /tracker renders", "page",
    "/t/{token} 302 → /tracker with HttpOnly SameSite=Lax cookie; /tracker 200 + account name", async () => {
      const { data } = await sb.from("accounts").select("token,name").eq("sf_account_id", KNOWN.ricks).maybeSingle();
      const r = await openTracker(data?.token ?? "");
      const cookieOk = /HttpOnly/i.test(r.setCookie) && /SameSite=Lax/i.test(r.setCookie) && /Secure/i.test(r.setCookie);
      const pass = r.entryStatus === 302 && r.location === "/tracker" && cookieOk && r.status === 200
        && !!data?.name && r.text.includes(data.name);
      return { actual: { entryStatus: r.entryStatus, location: r.location, cookieOk, status: r.status,
        nameShown: data?.name ? r.text.includes(data.name) : null }, pass,
        diagnosis: `entry=${r.entryStatus}→${r.location} cookieOk=${cookieOk} page=${r.status} nameShown=${data?.name ? r.text.includes(data.name) : "n/a"}` };
    });

  await test("C2", "Bad tokens fail closed", "page",
    "garbage and unknown UUID → 302 that CLEARS the cookie; /tracker then 404", async () => {
      const g = await openTracker("not-a-real-token");
      const u = await openTracker("00000000-0000-0000-0000-000000000000");
      const cleared = (sc: string) => /Max-Age=0/i.test(sc);
      const pass = g.entryStatus === 302 && u.entryStatus === 302 && cleared(g.setCookie) && cleared(u.setCookie)
        && g.status === 404 && u.status === 404;
      return { actual: { garbage: { entry: g.entryStatus, cleared: cleared(g.setCookie), page: g.status },
        unknownUuid: { entry: u.entryStatus, cleared: cleared(u.setCookie), page: u.status } }, pass,
        diagnosis: `garbage=${g.entryStatus}/${g.status} unknownUuid=${u.entryStatus}/${u.status} (want 302→404 with cleared cookie)` };
    });

  await test("C3", "Empty state — account with 0 cases", "page", "200 + empty-state message", async () => {
    const { data } = await sb.from("accounts").select("token").eq("sf_account_id", idA1).maybeSingle();
    const { status, text } = await openTracker(data?.token ?? "");
    // Redesign (0e85027) renders an explicit empty state instead of an "Open tickets — 0" count.
    const emptyState = /No open tickets right now/i.test(text);
    return { actual: { status, showsEmptyState: emptyState, token: data?.token }, pass: status === 200 && emptyState,
      diagnosis: `status=${status} showsEmptyState=${emptyState} (want 200 + "No open tickets right now")` };
  });

  await test("C6", "/tracker without a session cookie fails closed", "page", "404 + re-click-your-link copy", async () => {
    const { status, text } = await getPage("/tracker");
    const copy = /click the link again/i.test(text);
    return { actual: { status, copy }, pass: status === 404 && copy,
      diagnosis: `status=${status} copy=${copy} (want 404 + "click the link again")` };
  });

  // ---------- Blocked (need Saffi / SF write) ----------
  blocked("A1", "Full Flow: case-create → link written to field", "Requires creating a Case in SF. Already proven once via the ivan358 test; re-run belongs to Saffi.");
  blocked("A3", "Write-if-empty: existing link not overwritten", "Flow write logic — needs a 2nd case on an already-linked account, created in SF by Saffi.");
  blocked("A4", "Non-qualifying Type does NOT fire the Flow", "Flow entry-criteria — needs Saffi to create a non-tech case and confirm no callout.");
  blocked("B7", "Status change in SF propagates to the page", "Needs a Case status edit in SF (write) followed by a resync.");
  blocked("C5", "Multi-location parent/child rollup", "Open design question — 3 account patterns per Saffi; resolve before including multi-location accounts.");
  blocked("D1", "Sync-failure Slack alert fires", "Observability not built yet (IAI-239).");
  blocked("D3", "Bulk API load doesn't dent REST quota", "Requires monitoring the org's quota over time — confirm with Saffi.");
  // C4 (mobile render) is run separately via the Browser MCP and appended to the report.

  // ---------- report ----------
  const finishedAt = new Date().toISOString();
  logStream.end();
  fs.writeFileSync(reportPath, buildReport(finishedAt));
  const p = records.filter((r) => r.verdict === "PASS").length;
  const f = records.filter((r) => r.verdict === "FAIL").length;
  const b = records.filter((r) => r.verdict === "BLOCKED").length;
  console.log(`\nDONE — ${p} PASS · ${f} FAIL · ${b} BLOCKED`);
  console.log(`Report: ${reportPath}`);
  if (f > 0) console.log(`Failures: ${records.filter((r) => r.verdict === "FAIL").map((r) => r.id).join(", ")}`);
}

function buildReport(finishedAt: string): string {
  const p = records.filter((r) => r.verdict === "PASS").length;
  const f = records.filter((r) => r.verdict === "FAIL").length;
  const b = records.filter((r) => r.verdict === "BLOCKED").length;
  const badge = (v: string) => (v === "PASS" ? "✅ PASS" : v === "FAIL" ? "❌ FAIL" : "⏸️ BLOCKED");
  const L: string[] = [];
  L.push(`# Relay — UAT test run ${day}`);
  L.push("");
  L.push(`Target: \`${BASE}\` (deployed prod app, pointed at the UAT sandbox). Finished ${finishedAt}.`);
  L.push(`Policy: diagnose-don't-fix — failures were logged, not fixed. Raw log: \`docs/test-runs/uat-${stamp}.jsonl\`.`);
  L.push("");
  L.push(`**${p} PASS · ${f} FAIL · ${b} BLOCKED** (of ${records.length} tracked; + C4 mobile appended separately).`);
  L.push("");
  L.push("## Results");
  L.push("");
  L.push("| ID | Test | Verdict | Target |");
  L.push("|---|---|---|---|");
  for (const r of records) L.push(`| ${r.id} | ${r.name} | ${badge(r.verdict)} | ${r.target} |`);
  L.push("");
  const fails = records.filter((r) => r.verdict === "FAIL");
  L.push("## Failures & diagnoses");
  L.push("");
  if (fails.length === 0) L.push("_None — every app-side test passed._");
  for (const r of fails) {
    L.push(`### ${r.id} — ${r.name}`);
    L.push(`- **Expected:** ${r.expected}`);
    L.push(`- **Actual:** \`${JSON.stringify(r.actual)}\``);
    L.push(`- **Diagnosis:** ${r.diagnosis}`);
    L.push("");
  }
  const notes = records.filter((r) => r.verdict === "PASS" && r.diagnosis);
  if (notes.length) {
    L.push("## Passed with notes");
    L.push("");
    for (const r of notes) L.push(`- **${r.id}** — ${r.diagnosis}`);
    L.push("");
  }
  L.push("## Blocked — needs Saffi (SF write access)");
  L.push("");
  for (const r of records.filter((x) => x.verdict === "BLOCKED")) L.push(`- **${r.id} ${r.name}** — ${r.diagnosis}`);
  L.push("");
  L.push("## Test artifacts to clean up (post-run)");
  L.push("");
  L.push("Delete these seeded test accounts from Supabase after review:");
  L.push("");
  L.push("```");
  for (const id of createdIds) L.push(id);
  L.push("```");
  L.push("");
  L.push("_Also still in the store from earlier: the `Rivergate Plumbing & Air` demo, `ivan358`, `Ricks Plumbing Service`, and the `UAT callout test` junk row — all to be removed before real customers._");
  return L.join("\n");
}

main().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(1); });
