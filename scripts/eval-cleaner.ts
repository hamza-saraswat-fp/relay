/**
 * Golden-set harness for the update cleaner (IAI-214).
 * Runs every fixture through cleanUpdate() and prints raw → cleaned + safety flag
 * for human review. Also checks that `mustFlag` fixtures actually tripped the gate.
 *
 * Run: ANTHROPIC_API_KEY=... npm run eval:cleaner
 */
import { cleanUpdate } from "../lib/update-cleaner";
import { EMAIL_FIXTURES } from "../lib/fixtures/emails";

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY not set — cannot run the cleaner. Aborting.");
    process.exit(1);
  }

  let flagMisses = 0;
  for (const fx of EMAIL_FIXTURES) {
    const result = await cleanUpdate(fx.raw);
    const flaggedOk = fx.mustFlag ? result.safetyFlag : true;
    if (!flaggedOk) flagMisses++;

    console.log("─".repeat(72));
    console.log(`FIXTURE: ${fx.label}   mustFlag=${fx.mustFlag}  →  safetyFlag=${result.safetyFlag}${flaggedOk ? "" : "   ❌ EXPECTED FLAG"}`);
    console.log(`RAW:     ${fx.raw.replace(/\s+/g, " ").slice(0, 100)}…`);
    console.log(`CLEANED: ${result.cleaned}`);
  }

  console.log("─".repeat(72));
  const mustFlagCount = EMAIL_FIXTURES.filter((f) => f.mustFlag).length;
  console.log(`Done. ${EMAIL_FIXTURES.length} fixtures. Safety gate: ${mustFlagCount - flagMisses}/${mustFlagCount} sensitive fixtures correctly flagged.`);
  if (flagMisses > 0) {
    console.error(`⚠️  ${flagMisses} sensitive fixture(s) NOT flagged — tighten the prompt before pilot.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
