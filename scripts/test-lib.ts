/**
 * Fixture tests for the pure sync helpers — no live services (IAI-212).
 * Run: npm run test:lib
 */
import { parseCsv } from "../lib/salesforce";
import { statusToChip } from "../lib/status";
import { syncHealth, type SyncRunRow } from "../lib/health";
import { cleanedOrFallback, fallbackFor, safeSubject } from "../lib/data";
import {
  containsSensitive,
  containsBannedCta,
  latestMessageOnly,
  SAFE_FALLBACK,
} from "../lib/update-cleaner";

let failed = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    failed++;
    console.error(`  ❌ ${msg}`);
  } else {
    console.log(`  ✓ ${msg}`);
  }
}

console.log("parseCsv:");
{
  const rows = parseCsv(
    `Id,Subject,Status\r\n001,"Invoice #70593 not syncing","In Progress"\r\n002,"He said ""hi""","New"\r\n`,
  );
  assert(rows.length === 2, "parses two data rows");
  assert(rows[0].Id === "001" && rows[0].Status === "In Progress", "maps header→value by column");
  assert(rows[0].Subject === "Invoice #70593 not syncing", "handles quoted comma field");
  assert(rows[1].Subject === 'He said "hi"', "handles escaped double-quotes");

  const withNewline = parseCsv(`A,B\r\n"line1\nline2",x\r\n`);
  assert(withNewline.length === 1 && withNewline[0].A === "line1\nline2", "handles embedded newline");

  assert(parseCsv("").length === 0, "empty input → no rows");
  assert(parseCsv("Id,Status\r\n").length === 0, "header-only → no rows");
}

console.log("statusToChip (Saffi's mapping):");
{
  assert(statusToChip("Waiting for Customer") === "waiting_for_you", "Waiting for Customer → waiting_for_you");
  assert(statusToChip("New") === "waiting_for_support", "New → waiting_for_support");
  assert(statusToChip("Waiting for Support") === "waiting_for_support", "Waiting for Support → waiting_for_support");
  assert(statusToChip("In Progress") === "in_progress", "In Progress → in_progress");
  assert(statusToChip("Waiting on Engineering") === "in_progress", "Waiting on Engineering → in_progress");
  assert(statusToChip("Closed") === "resolved", "Closed → resolved");
  assert(statusToChip("Merged") === "resolved", "Merged → resolved");
  assert(statusToChip("Some Unknown Status") === "in_progress", "unknown → in_progress (safe default)");
}

console.log("syncHealth (IAI-239):");
{
  const NOW = Date.parse("2026-07-14T18:00:00Z");
  const min = (m: number) => new Date(NOW - m * 60000).toISOString();
  const row = (o: Partial<SyncRunRow> = {}): SyncRunRow => ({
    started_at: min(5), finished_at: min(4), status: "ok", cases_upserted: 5, error: null, ...o,
  });

  assert(syncHealth([], NOW).state === "never_run", "no runs → never_run");
  assert(syncHealth([], NOW).healthy === false, "never_run → not healthy");
  assert(syncHealth([row()], NOW).state === "ok", "recent ok run → ok");
  assert(syncHealth([row()], NOW).healthy === true, "recent ok run → healthy (200)");
  assert(
    syncHealth([row({ started_at: min(9 * 60 + 5), finished_at: min(9 * 60) })], NOW).state === "stale",
    "ok run finished 9h ago → stale",
  );
  assert(
    syncHealth([row({ started_at: min(30), finished_at: null, status: "running" })], NOW).state === "stuck",
    "running >15m → stuck (killed function)",
  );
  assert(
    syncHealth([row({ started_at: min(2), finished_at: null, status: "running" })], NOW).state === "ok",
    "running <15m → ok (in progress)",
  );
  assert(
    syncHealth([row({ status: "error", error: "boom" })], NOW).state === "error",
    "latest run errored → error",
  );
  assert(
    syncHealth(
      [row({ started_at: min(100) }), row({ started_at: min(1), finished_at: null, status: "running" })],
      NOW,
    ).lastRun?.status === "running",
    "picks the newest run by started_at regardless of order",
  );
}

console.log("status-aware fallbacks (IAI-316):");
{
  // fallbackFor: every chip gets copy that agrees with the chip label rendered next to it.
  assert(
    fallbackFor("in_progress", false).startsWith("Our team is actively working"),
    "in_progress → actively-working copy",
  );
  assert(
    !fallbackFor("in_progress", false).includes("email thread"),
    "in_progress + no email → no email pointer (nothing is there)",
  );
  assert(
    fallbackFor("in_progress", true).includes("full details are in your email thread"),
    "in_progress + hidden email → points at the thread",
  );
  assert(
    fallbackFor("waiting_for_you", false).startsWith("We're waiting on a reply from you"),
    "waiting_for_you → leads with needing their reply",
  );
  assert(
    fallbackFor("waiting_for_support", false).includes("in our support queue"),
    "waiting_for_support → queue copy",
  );
  assert(
    fallbackFor("waiting_for_support", true).includes("full details are in your email thread"),
    "waiting_for_support + hidden email → points at the thread",
  );
  assert(fallbackFor("resolved", false).startsWith("This ticket has been resolved"), "resolved → resolved copy");

  // cleanedOrFallback: what counts as "no real blurb".
  assert(
    cleanedOrFallback(null, "in_progress") === fallbackFor("in_progress", false),
    "missing row → status fallback",
  );
  assert(
    cleanedOrFallback({ cleaned_update: "Real update.", safety_flag: false }, "in_progress") === "Real update.",
    "real blurb passes through untouched",
  );
  assert(
    cleanedOrFallback(
      { cleaned_update: "Real but flagged.", safety_flag: true, email_message_at: "2026-07-01T00:00:00Z" },
      "in_progress",
    ) === fallbackFor("in_progress", true),
    "flagged row → status fallback with email pointer",
  );
  assert(
    cleanedOrFallback({ cleaned_update: SAFE_FALLBACK, safety_flag: false }, "waiting_for_support") ===
      fallbackFor("waiting_for_support", false),
    "stored legacy generic fallback → replaced with status-aware copy",
  );
  assert(
    cleanedOrFallback({ cleaned_update: "", safety_flag: false, email_message_at: null }, "resolved") ===
      fallbackFor("resolved", false),
    "empty blurb → status fallback",
  );
}

console.log("containsSensitive scrubber (IAI-316):");
{
  // Positives: any of these in a model output must force the fallback.
  assert(containsSensitive("We issued a credit of $2,453.00 to your account.") !== null, "catches $2,453.00");
  assert(containsSensitive("a small charge of $18.40 was found") !== null, "catches $18.40");
  assert(containsSensitive("call us at 469.382.5668 anytime") !== null, "catches 469.382.5668");
  assert(containsSensitive("reach me at (480) 555-0199 today") !== null, "catches (480) 555-0199");
  assert(containsSensitive("email techsupport@fieldpulse.com for help") !== null, "catches an email address");
  // Negatives: normal support-speak must NOT trip it.
  assert(containsSensitive("We traced this to invoice #70593 and applied a fix.") === null, "invoice numbers OK");
  assert(containsSensitive("Our team is available 24/7 for urgent issues.") === null, "24/7 OK");
  assert(containsSensitive("Fixed in version 3.2.1 of the mobile app.") === null, "version strings OK");
  assert(containsSensitive("We're actively working on this ticket.") === null, "plain updates OK");
  assert(containsSensitive("Payment #4187 wasn't syncing due to a small mismatch.") === null, "payment ref OK");
}

console.log("latestMessageOnly quoted-thread truncation (IAI-317):");
{
  const fp = latestMessageOnly(
    "We're closing this for now — reply anytime. Kind regards, Dave --------------- Original Message --------------- From: Techsupport Sent: 4/24/2026 If the issue persists, please provide a screen recording.",
  );
  assert(fp.includes("closing this for now"), "keeps the newest message (FieldPulse separator)");
  assert(!fp.includes("screen recording"), "drops quoted history below the FieldPulse separator");

  const gm = latestMessageOnly(
    "Once you confirm the tax codes, we can apply the fix. On Mon, Jun 9 2026 at 3:14 PM John wrote: The invoice still isn't showing up.",
  );
  assert(gm.includes("apply the fix"), "keeps the newest message (Gmail separator)");
  assert(!gm.includes("invoice still isn't showing"), "drops quoted history below 'On … wrote:'");

  assert(
    latestMessageOnly("Just a single message with no quoted thread.") ===
      "Just a single message with no quoted thread.",
    "no separator → passthrough",
  );
  assert(
    !latestMessageOnly("Thanks for your patience. thread::Il4qbrbcJEWF5KbHD0dBMyY:: See you soon.").includes(
      "thread::",
    ),
    "strips salesforce thread:: tokens",
  );
  const both = latestMessageOnly(
    "Newest. --------------- Original Message --------------- Middle. On Jan 2 2026 at 9:00 AM Sam wrote: Oldest.",
  );
  assert(both === "Newest.", "cuts at the first separator when both kinds appear");
}

console.log("containsBannedCta read-only-page guard (IAI-317):");
{
  assert(containsBannedCta("just reply here and we'll pick this back up") !== null, "catches 'reply here'");
  assert(containsBannedCta("please respond here at your convenience") !== null, "catches 'respond here'");
  assert(containsBannedCta("let us know here if it happens again") !== null, "catches 'let us know here'");
  assert(containsBannedCta("Reply below with the invoice number") !== null, "catches 'reply below'");
  assert(
    containsBannedCta("just reply to your email thread and we'll pick this back up") === null,
    "'reply to your email thread' is the CORRECT phrasing — allowed",
  );
  assert(containsBannedCta("let us know if you're still seeing this") === null, "'let us know if …' allowed");
  assert(containsBannedCta("we'll post an update here as soon as there's news") === null, "'update here' allowed");
}

console.log("safeSubject email-thread reference (IAI-318):");
{
  assert(safeSubject("Re: Disappearing Photos in the Field") === "Re: Disappearing Photos in the Field", "normal subject passes through");
  assert(safeSubject("  Re:   Site Visit   on Schedule  ") === "Re: Site Visit on Schedule", "trims + collapses whitespace");
  assert(safeSubject(null) === undefined, "null → undefined");
  assert(safeSubject("") === undefined, "empty → undefined");
  assert(safeSubject("Re: refund of $2,453.00 processed") === undefined, "subject with $ amount is dropped");
  assert(safeSubject("Re: call me at (480) 555-0199") === undefined, "subject with phone number is dropped");
  assert(safeSubject("Re: email me at ops@acme.com") === undefined, "subject with email address is dropped");
  {
    const long =
      "Work Orders Not Consistently Linked to Projects (Broken Hierarchy: Estimate to Project to Work Order) Scenario Description reproduction steps and environment details";
    const capped = safeSubject(long)!;
    assert(capped.length <= 81, "over-long subject is capped to a bounded handle");
    assert(capped.endsWith("…"), "capped subject ends with an ellipsis");
    assert(!/\s…$/.test(capped), "no dangling space before the ellipsis");
    assert(long.startsWith(capped.replace(/…$/, "")), "cap is a clean prefix of the original");
  }
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed.`);
  process.exit(1);
}
console.log("\nAll fixture tests passed.");
