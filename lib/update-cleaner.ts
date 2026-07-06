import Anthropic from "@anthropic-ai/sdk";
import { requireEnv } from "./env";

/**
 * Turn a support agent's raw outbound email into a short, customer-facing
 * status update for the PUBLIC ticket page — with a safety gate.
 *
 * IAI-214. Model: Haiku 4.5 (cheap/fast) — no `effort`/`thinking` (Haiku rejects effort).
 */

const MODEL = "claude-haiku-4-5";

export const SAFE_FALLBACK =
  "Our team posted an update on this ticket — check your email thread for details.";

export interface CleanResult {
  cleaned: string;
  safetyFlag: boolean;
  model: string;
}

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: requireEnv("ANTHROPIC_API_KEY") });
  return client;
}

const SYSTEM = `You convert a support agent's raw outbound email into a short, customer-facing status update for a PUBLIC ticket status page.

Rules:
- Output 1–3 plain sentences describing the current status or next step, written to the customer.
- Strip email signatures, quoted reply chains, greetings/sign-offs, headers, and any HTML.
- Never invent information that isn't in the email.
- SAFETY (the page is public): set "sensitive": true if the email contains anything that must not be shown publicly — other customers' names, personal emails or phone numbers, dollar amounts, credentials/API keys/passwords, internal-only system details, or commentary clearly meant for internal staff only.

Respond ONLY with a JSON object of the form {"cleaned": "<1-3 sentence update>", "sensitive": true|false}. No prose, no code fences.`;

function extractJson(text: string): { cleaned?: string; sensitive?: boolean } | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

export async function cleanUpdate(rawEmail: string): Promise<CleanResult> {
  if (!rawEmail || !rawEmail.trim()) {
    return { cleaned: SAFE_FALLBACK, safetyFlag: false, model: MODEL };
  }

  const response = await getClient().messages.create({
    model: MODEL,
    max_tokens: 500,
    system: SYSTEM,
    messages: [{ role: "user", content: rawEmail }],
  });

  // Fail closed: anything unexpected → safe fallback, never raw email text.
  if (response.stop_reason === "refusal") {
    return { cleaned: SAFE_FALLBACK, safetyFlag: true, model: MODEL };
  }
  const textBlock = response.content.find((b) => b.type === "text");
  const parsed = textBlock && "text" in textBlock ? extractJson(textBlock.text) : null;
  if (!parsed || typeof parsed.cleaned !== "string" || parsed.sensitive === undefined) {
    return { cleaned: SAFE_FALLBACK, safetyFlag: true, model: MODEL };
  }
  if (parsed.sensitive) {
    return { cleaned: SAFE_FALLBACK, safetyFlag: true, model: MODEL };
  }
  return { cleaned: parsed.cleaned.trim(), safetyFlag: false, model: MODEL };
}
