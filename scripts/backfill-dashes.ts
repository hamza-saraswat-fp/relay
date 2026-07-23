/**
 * One-off backfill: apply normalizeDashes() to every stored `cleaned_update`.
 *
 * The em-dash ban (prompt rule + normalizeDashes backstop) only affects blurbs generated from
 * here on, and needsReclean() deliberately skips tickets whose source email and chip haven't
 * changed. Without this pass the dashes already on customer pages would persist until each
 * ticket next moves, which for a quiet ticket could be never.
 *
 * Text-only rewrite: no re-generation, no model calls, so the blurb's meaning cannot drift and
 * the safety gates that already passed this text still hold (normalizeDashes only swaps
 * punctuation). Dry run by default; --apply writes, after dumping a rollback file.
 *
 * Run: set -a && source .env.local && set +a && npx tsx scripts/backfill-dashes.ts [--apply]
 */
import fs from "node:fs";
import path from "node:path";
import { getServiceClient } from "../lib/supabase";
import { normalizeDashes } from "../lib/update-cleaner";

const APPLY = process.argv.includes("--apply");

async function main() {
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("case_updates")
    .select("case_id, cleaned_update, cases(subject, accounts(name))");
  if (error) throw error;

  const rows = data ?? [];
  const changed = rows
    .filter((r) => typeof r.cleaned_update === "string" && r.cleaned_update.length > 0)
    .map((r) => {
      const before = r.cleaned_update as string;
      return { id: r.case_id as string, before, after: normalizeDashes(before), row: r };
    })
    .filter((r) => r.before !== r.after);

  console.log(`Scanned ${rows.length} stored updates; ${changed.length} contain a dash to rewrite.\n`);

  for (const c of changed) {
    const rec = c.row as unknown as {
      cases?: { subject?: string; accounts?: { name?: string } | { name?: string }[] } | Array<{
        subject?: string;
        accounts?: { name?: string } | { name?: string }[];
      }>;
    };
    const cse = Array.isArray(rec.cases) ? rec.cases[0] : rec.cases;
    const acct = Array.isArray(cse?.accounts) ? cse?.accounts[0] : cse?.accounts;
    console.log(`— ${acct?.name ?? "?"} / ${cse?.subject ?? "?"}`);
    console.log(`  BEFORE: ${c.before}`);
    console.log(`  AFTER : ${c.after}\n`);
  }

  if (!changed.length) {
    console.log("Nothing to do.");
    return;
  }

  if (!APPLY) {
    console.log("DRY RUN — no writes. Re-run with --apply to commit these.");
    return;
  }

  // Rollback artifact first: every prior value, so this pass is reversible.
  const backup = path.join(process.cwd(), `backfill-dashes-rollback-${Date.now()}.json`);
  fs.writeFileSync(backup, JSON.stringify(changed.map(({ id, before, after }) => ({ id, before, after })), null, 2));
  console.log(`Rollback file written: ${backup}\n`);

  let ok = 0;
  for (const c of changed) {
    const { error: upErr } = await supabase
      .from("case_updates")
      .update({ cleaned_update: c.after })
      .eq("case_id", c.id);
    if (upErr) {
      console.error(`FAILED ${c.id}: ${upErr.message}`);
      continue;
    }
    ok++;
  }
  console.log(`Updated ${ok}/${changed.length} rows.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
