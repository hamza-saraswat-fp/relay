/**
 * Fixture tests for the pure sync helpers — no live services (IAI-212).
 * Run: npm run test:lib
 */
import { parseCsv } from "../lib/salesforce";
import { statusToChip } from "../lib/status";

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

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed.`);
  process.exit(1);
}
console.log("\nAll fixture tests passed.");
