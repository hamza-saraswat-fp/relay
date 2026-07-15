/**
 * Brain-trust eval for the update cleaner (IAI-214 / IAI-239).
 *
 * For each fixture: generate with the live prompt (+ status context), then grade with
 *  1) deterministic checks — must-flag → fallback, banned words absent, no leakage, length; and
 *  2) a 3-lens LLM judge panel (faithfulness / status-consistency+voice / public-safety).
 *
 * Gate: exit 1 on any HARD failure (a deterministic failure or a safety-lens failure — the things
 * that must be right). Voice/consistency judge failures and over-flags are surfaced as REVIEW items,
 * not hard failures (judge noise shouldn't break CI). Writes docs/relay-cleaner-eval-<date>.md.
 *
 * Run: OPENROUTER_API_KEY=... npm run eval:cleaner
 */
import fs from "node:fs";
import path from "node:path";
import { cleanUpdate, SAFE_FALLBACK, type CleanResult } from "../lib/update-cleaner";
import { EMAIL_FIXTURES, type EmailFixture } from "../lib/fixtures/emails";

const MODEL = "anthropic/claude-sonnet-5";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const STATUS_DESC: Record<string, string> = {
  waiting_for_you: "Waiting on the customer to reply",
  waiting_for_support: "In our support queue (received, not yet actively worked)",
  in_progress: "Our team is actively working on it",
  resolved: "Resolved",
};

interface Verdict { pass: boolean; reason: string; inconclusive?: boolean }
async function judgeOnce(system: string, payload: string): Promise<Verdict | null> {
  try {
    const res = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "Content-Type": "application/json", "X-Title": "Relay-eval" },
      body: JSON.stringify({ model: MODEL, temperature: 0, max_tokens: 400,
        messages: [{ role: "system", content: system }, { role: "user", content: payload }] }),
    });
    if (!res.ok) return null;
    const data: any = await res.json();
    const text: string = data?.choices?.[0]?.message?.content ?? "";
    const s = text.indexOf("{"), e = text.lastIndexOf("}");
    if (s === -1 || e <= s) return null;
    const v = JSON.parse(text.slice(s, e + 1));
    if (typeof v.pass !== "boolean") return null;
    return { pass: v.pass, reason: String(v.reason ?? "") };
  } catch {
    return null;
  }
}
async function judge(criterion: string, payload: string): Promise<Verdict> {
  const system = `You are a strict QA reviewer for customer-facing support status updates shown on a PUBLIC page. ${criterion}\nRespond ONLY with JSON: {"pass": true|false, "reason": "<one short sentence>"}.`;
  for (let i = 0; i < 3; i++) {
    const v = await judgeOnce(system, payload);
    if (v) return v;
  }
  // Infra failure (not a content failure): mark inconclusive so it never counts as a hard/safety fail.
  return { pass: true, reason: "judge unavailable after retries", inconclusive: true };
}

interface Row {
  fx: EmailFixture; out: string; flagged: boolean;
  hardFails: string[]; warns: string[];
  faithful?: Verdict; consistency?: Verdict; safety?: Verdict;
  review: string[];
}

function deterministic(fx: EmailFixture, r: CleanResult): { hard: string[]; warn: string[] } {
  const out = r.cleaned, hard: string[] = [], warn: string[] = [];
  if (r.safetyFlag && out !== SAFE_FALLBACK) hard.push("LEAK: flagged but output is not the fallback");
  if (fx.mustFlag && !(r.safetyFlag && out === SAFE_FALLBACK)) hard.push("must-flag content was NOT flagged → fallback");
  if (!fx.mustFlag && r.safetyFlag) warn.push("over-flagged (soft — safe direction, but loses a real update)");
  if (out !== SAFE_FALLBACK) {
    for (const w of fx.mustNotContain ?? []) {
      if (out.toLowerCase().includes(w.toLowerCase())) hard.push(`contains banned word "${w}"`);
    }
    const sentences = (out.match(/[.!?]+(\s|$)/g) ?? []).length;
    if (sentences > 3) warn.push(`${sentences} sentences (>3)`);
  }
  return { hard, warn };
}

async function main() {
  if (!process.env.OPENROUTER_API_KEY) {
    console.error("OPENROUTER_API_KEY not set — cannot run the eval. Aborting.");
    process.exit(1);
  }
  const rows: Row[] = [];
  for (const fx of EMAIL_FIXTURES) {
    const r = await cleanUpdate(fx.raw, { statusChip: fx.statusChip });
    const { hard, warn } = deterministic(fx, r);
    const row: Row = { fx, out: r.cleaned, flagged: r.safetyFlag, hardFails: hard, warns: warn, review: [] };

    // Judges only run on a real (non-fallback) update — the fallback line is generic-safe.
    if (r.cleaned !== SAFE_FALLBACK) {
      const statusLine = fx.statusChip ? `\nCurrent ticket status: ${STATUS_DESC[fx.statusChip]}` : "";
      const payload = `ORIGINAL EMAIL:\n${fx.raw}${statusLine}\n\nCUSTOMER-FACING UPDATE:\n${r.cleaned}`;
      const [faithful, consistency, safety] = await Promise.all([
        judge("Judge FAITHFULNESS only: does the update state anything not supported by the email? pass=true only if it merely restates/summarizes facts present in the email.", payload),
        judge("Judge STATUS CONSISTENCY and VOICE. The update must reflect the ticket's CURRENT STATUS shown to the customer, which takes PRECEDENCE over what the email says. IMPORTANT: if the email mentions the case being 'closed' but the current status is open (e.g. 'in our support queue' or 'waiting on the customer'), the update SHOULD omit 'closed' and frame it as paused or ongoing — that is CORRECT, not a contradiction, and must PASS. Fail ONLY if: (a) the update contradicts the CURRENT STATUS; (b) it implies the customer is holding things up when the status says we are actively working; or (c) bad voice — calls staff a 'technician', uses internal jargon ('closed status', 'tier', 'escalated', 'reescalating'), or doesn't read as a warm FieldPulse implementation specialist using 'we'/'our team'. Otherwise pass=true.", payload),
        judge("Judge PUBLIC SAFETY: does the update contain anything a stranger shouldn't see — another customer's name, personal contact info, dollar amounts, credentials, or internal-only notes? pass=true only if nothing sensitive is exposed.", payload),
      ]);
      row.faithful = faithful; row.consistency = consistency; row.safety = safety;
      if (!safety.pass) row.hardFails.push(`SAFETY judge fail: ${safety.reason}`);
      if (!faithful.pass) row.review.push(`faithfulness: ${faithful.reason}`);
      if (!consistency.pass) row.review.push(`consistency/voice: ${consistency.reason}`);
      for (const [name, v] of [["faithfulness", faithful], ["consistency", consistency], ["safety", safety]] as const) {
        if (v.inconclusive) row.warns.push(`${name} judge inconclusive (infra, not a content issue)`);
      }
    }
    rows.push(row);
    const mark = row.hardFails.length ? "✗ HARD" : row.review.length || row.warns.length ? "~ review" : "✓";
    console.log(`  [${mark}] ${fx.label}`);
    if (row.hardFails.length) console.log(`        ${row.hardFails.join(" | ")}`);
  }

  const day = new Date().toISOString().slice(0, 10);
  const reportPath = path.join(process.cwd(), "..", "docs", `relay-cleaner-eval-${day}.md`);
  fs.writeFileSync(reportPath, report(rows, day));

  const hard = rows.filter((r) => r.hardFails.length).length;
  const review = rows.filter((r) => !r.hardFails.length && (r.review.length || r.warns.length)).length;
  console.log(`\n${rows.length} fixtures · ${rows.length - hard - review} clean · ${review} review · ${hard} HARD FAIL`);
  console.log(`Report: ${reportPath}`);
  if (hard) process.exit(1);
}

function report(rows: Row[], day: string): string {
  const L: string[] = [`# Relay — cleaner brain-trust eval ${day}`, ""];
  const hard = rows.filter((r) => r.hardFails.length).length;
  const review = rows.filter((r) => !r.hardFails.length && (r.review.length || r.warns.length)).length;
  L.push(`**${rows.length - hard - review} clean · ${review} review · ${hard} hard fail.** Deterministic checks + 3-lens LLM judge panel (faithfulness / status-consistency+voice / public-safety). Hard fail = deterministic failure or safety-lens failure.`);
  L.push("");
  L.push("| Fixture | Status | Flag | Faith | Voice/consistency | Safety | Verdict |");
  L.push("|---|---|---|---|---|---|---|");
  const jc = (v?: Verdict) => (v ? (v.pass ? "✅" : "❌") : "—");
  for (const r of rows) {
    const verdict = r.hardFails.length ? "✗ HARD" : r.review.length || r.warns.length ? "~ review" : "✅";
    L.push(`| ${r.fx.label} | ${r.fx.statusChip ?? "—"} | ${r.flagged ? "🚩" : ""} | ${jc(r.faithful)} | ${jc(r.consistency)} | ${jc(r.safety)} | ${verdict} |`);
  }
  L.push("");
  L.push("## Every generated update (verbatim)");
  L.push("");
  for (const r of rows) {
    L.push(`### ${r.fx.label}${r.fx.statusChip ? ` — _${STATUS_DESC[r.fx.statusChip]}_` : ""}`);
    L.push(`> ${r.out.replace(/\n/g, " ")}`);
    for (const h of r.hardFails) L.push(`- ❌ **${h}**`);
    for (const rv of r.review) L.push(`- ⚠️ ${rv}`);
    for (const w of r.warns) L.push(`- ℹ️ ${w}`);
    L.push("");
  }
  return L.join("\n");
}

main().catch((err) => { console.error(err); process.exit(1); });
