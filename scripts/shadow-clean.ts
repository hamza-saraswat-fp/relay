/**
 * Shadow run for cleaner changes (IAI-317): re-clean every tracked ticket READ-ONLY and write a
 * before/after report. ZERO writes — no runSync, no Supabase mutations; the live pages are
 * untouched. This is the review artifact required before any cleaner change ships to prod.
 *
 * Run: set -a && source .env.local && set +a && npx tsx scripts/shadow-clean.ts
 */
import fs from "node:fs";
import path from "node:path";
import { getServiceClient } from "../lib/supabase";
import { cleanUpdate, SAFE_FALLBACK } from "../lib/update-cleaner";
import type { StatusChip } from "../lib/types";

interface Row {
  account: string;
  subject: string;
  chip: StatusChip;
  liveBlurb: string;
  liveFlag: boolean;
  shadowBlurb: string;
  shadowFlag: boolean;
  notes: string[];
}

async function main() {
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("case_updates")
    .select(
      "raw_body, cleaned_update, safety_flag, email_message_at, cases(subject, status_chip, accounts(name))",
    );
  if (error) throw error;

  const rows: Row[] = [];
  for (const u of data ?? []) {
    const c = (Array.isArray(u.cases) ? u.cases[0] : u.cases) as
      | { subject: string; status_chip: StatusChip; accounts: { name: string } | { name: string }[] }
      | null;
    if (!c) continue;
    const acct = Array.isArray(c.accounts) ? c.accounts[0] : c.accounts;
    const raw = (u.raw_body as string | null) ?? "";

    // Capture the pipeline's console.warn output so the report shows WHICH guardrail acted.
    const notes: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => notes.push(args.map(String).join(" "));
    let shadow: { cleaned: string; safetyFlag: boolean };
    try {
      shadow = raw.trim()
        ? await cleanUpdate(raw, {
            statusChip: c.status_chip,
            subject: c.subject,
            emailDate: (u.email_message_at as string | null) ?? undefined,
          })
        : { cleaned: "(no outbound email — page shows the status-aware fallback)", safetyFlag: false };
    } finally {
      console.warn = origWarn;
    }

    rows.push({
      account: acct?.name ?? "?",
      subject: c.subject,
      chip: c.status_chip,
      liveBlurb: (u.cleaned_update as string | null) ?? "",
      liveFlag: Boolean(u.safety_flag),
      shadowBlurb: shadow.cleaned,
      shadowFlag: shadow.safetyFlag,
      notes,
    });
    console.log(`  [${shadow.safetyFlag ? "fallback" : "ok"}] ${acct?.name ?? "?"} — ${c.subject.slice(0, 60)}`);
  }

  rows.sort((a, b) => a.account.localeCompare(b.account) || a.subject.localeCompare(b.subject));
  const day = new Date().toISOString().slice(0, 10);
  const L: string[] = [
    `# Relay — IAI-317 guardrails shadow run ${day}`,
    "",
    "Every tracked ticket re-cleaned READ-ONLY through the new pipeline (thread truncation →",
    "prompt v4 → sensitive scrub → CTA ban → runtime faithfulness gate). **No Supabase writes;",
    "live pages unchanged.** \"Live blurb\" = what customers see right now; \"shadow blurb\" = what",
    "they would see after this change ships and the next sync runs.",
    "",
  ];
  let changed = 0;
  let acct = "";
  for (const r of rows) {
    if (r.account !== acct) {
      acct = r.account;
      L.push(`## ${acct}`, "");
    }
    const diff = r.liveBlurb !== r.shadowBlurb;
    if (diff) changed++;
    L.push(`### ${r.subject.slice(0, 90)}`);
    L.push(`- Chip: \`${r.chip}\` · ${diff ? "**changed**" : "unchanged"}${r.shadowFlag ? " · shadow fell back (see notes)" : ""}`);
    L.push(`- Live:   > ${r.liveBlurb.replace(/\n/g, " ")}`);
    L.push(`- Shadow: > ${r.shadowBlurb.replace(/\n/g, " ")}`);
    for (const n of r.notes) L.push(`- ⚠️ ${n}`);
    L.push("");
  }
  L.push(`**${rows.length} tickets · ${changed} would change.** Fallback lines above render as the status-aware copy on the page (IAI-316).`);
  const out = path.join(process.cwd(), "..", "docs", `relay-shadow-run-${day}.md`);
  fs.writeFileSync(out, L.join("\n"));
  console.log(`\n${rows.length} tickets, ${changed} would change. Report: ${out}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
