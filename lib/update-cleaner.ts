import { requireEnv } from "./env";
import type { StatusChip } from "./types";

/**
 * Turn a support agent's raw outbound email into a short, customer-facing status update for the
 * PUBLIC ticket page — with a safety gate. IAI-214 / IAI-239 (prompt v2).
 *
 * Model: Claude Sonnet 5 via OpenRouter. The prompt writes in an implementation-specialist voice,
 * bans internal vocabulary, and is given the ticket's current status + subject + type + email age so
 * the update never contradicts the status chip shown next to it. Context is for tone/consistency
 * only — it is never quoted back to the customer, and only non-sensitive fields are ever passed in.
 */

const MODEL = "anthropic/claude-sonnet-5";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

export const SAFE_FALLBACK =
  "Our team posted an update on this ticket — check your email thread for details.";

export interface CleanContext {
  statusChip?: StatusChip;
  subject?: string;
  caseType?: string;
  emailDate?: string; // ISO; used only to reason about staleness, never surfaced
}

export interface CleanResult {
  cleaned: string;
  safetyFlag: boolean;
  model: string;
}

/** How each chip is described to the model (clearer than the enum; drives status-consistency). */
const STATUS_DESC: Record<StatusChip, string> = {
  waiting_for_you: "Waiting on the customer to reply",
  waiting_for_support: "In our support queue (received, not yet actively worked)",
  in_progress: "Our team is actively working on it",
  resolved: "Resolved",
};

const SYSTEM = `You write the customer-facing "latest update" shown on a PUBLIC support ticket status page for FieldPulse (field-service management software). You rewrite a support team member's raw outbound email into a short, clear status update.

VOICE: Write as a FieldPulse implementation specialist — warm, plain, professional. Use "we" / "our team". 1–3 sentences, written directly to the customer.

VOCABULARY (strict):
- Never call our staff a "technician" — say "our support team" or "we".
- Never expose internal status mechanics or jargon: do NOT say "closed status", "the case has been closed", "escalated", "reescalating", "tier 1/2", "engineering ticket", "queue", etc.
- Say "ticket", not "case". Never name individual people or roles.

STATUS CONSISTENCY: You are given the ticket's CURRENT status. Your update must not contradict it:
- "Our team is actively working on it": frame us as actively working. If the email asks the customer for information, present it as something that helps us move faster — never as the ticket being stalled on them. e.g. "We're actively investigating this — an example invoice number will help us pin it down faster."
- "In our support queue" or "Waiting on the customer": if the email says the ticket was closed or paused, do NOT say "closed" — describe it as paused and easy to resume. e.g. "We haven't been able to connect for a troubleshooting session yet — reply anytime and we'll pick right back up."
- "Waiting on the customer to reply": lead with what we need from them to move forward.
- "Resolved": briefly summarize the resolution.

TIMING: You may be told when the email was sent and today's date. If the email is old, do not repeat time-bound promises from it ("we'll follow up tomorrow", "later today"). Use present-tense phrasing that is still accurate. Never mention any dates.

FIDELITY: Never invent information that isn't in the email. The CONTEXT fields are for consistency and tone only — never quote them back to the customer.

SAFETY (the page is public) — sanitize, don't suppress:
- Your OUTPUT must never contain: any person's name (staff or customer), email addresses, phone numbers, physical addresses, dollar amounts, credentials/API keys/passwords, or another customer's/company's identifying details. Agent signatures and quoted reply threads are noise — ignore them entirely.
- When the email contains sensitive details, SUMMARIZE AROUND them: describe what happened or what we need without the specifics. e.g. an email about an $18.40 payment mismatch becomes "We found a small mismatch between the payment and invoice amounts and asked you to confirm one detail." A "can we create a test record to reproduce what Marvin is seeing?" email becomes "We've asked to create a test record on your account so we can reproduce the issue."
- Set "sensitive": true ONLY when the email cannot be faithfully summarized without exposing sensitive content — internal-only staff commentary, credential delivery, or an email whose entire substance IS the sensitive information. A benign update that merely CONTAINS a signature, name, or amount is NOT sensitive — summarize around it.

Respond ONLY with a JSON object of the form {"cleaned": "<1-3 sentence update>", "sensitive": true|false}. No prose, no code fences.`;

function buildUserMessage(rawEmail: string, ctx?: CleanContext): string {
  const lines: string[] = [];
  if (ctx?.subject) lines.push(`Ticket subject: ${ctx.subject}`);
  if (ctx?.caseType) lines.push(`Ticket type: ${ctx.caseType}`);
  if (ctx?.statusChip) lines.push(`Current ticket status: ${STATUS_DESC[ctx.statusChip]}`);
  if (ctx?.emailDate) {
    lines.push(`This email was sent ${ctx.emailDate.slice(0, 10)}; today is ${new Date().toISOString().slice(0, 10)}`);
  }
  const context = lines.length
    ? `CONTEXT (for consistency and tone — never quote these back, never mention the dates):\n${lines.join("\n")}\n\n`
    : "";
  return `${context}SUPPORT EMAIL TO CONVERT:\n${rawEmail}`;
}

/**
 * Deterministic backstop for the sanitize-not-suppress gate (IAI-316): the model drafts, code
 * verifies. Run on every model OUTPUT — any hit forces the fallback regardless of what the model
 * claimed. High-precision patterns only; deliberately does NOT match invoice/ticket numbers
 * (customer's own, useful) or words like "password" (mentioning one isn't a leak).
 * Returns a short label of what matched, or null if clean.
 */
const SENSITIVE_PATTERNS: [string, RegExp][] = [
  ["dollar amount", /\$\s?\d[\d,]*(\.\d{2})?/],
  ["email address", /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/],
  ["phone number", /\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/],
];

export function containsSensitive(text: string): string | null {
  for (const [label, re] of SENSITIVE_PATTERNS) {
    if (re.test(text)) return label;
  }
  return null;
}

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

export async function cleanUpdate(rawEmail: string, ctx?: CleanContext): Promise<CleanResult> {
  if (!rawEmail || !rawEmail.trim()) {
    return { cleaned: SAFE_FALLBACK, safetyFlag: false, model: MODEL };
  }

  // Throws if unconfigured — a real misconfig should surface, not silently fall back.
  const apiKey = requireEnv("OPENROUTER_API_KEY");

  let res: Response;
  try {
    res = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "X-Title": "Relay",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 500,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: buildUserMessage(rawEmail, ctx) },
        ],
      }),
    });
  } catch {
    // Network error → fail closed, never surface raw email text. Next sync re-attempts.
    return { cleaned: SAFE_FALLBACK, safetyFlag: true, model: MODEL };
  }

  // Fail closed: anything unexpected → safe fallback, never raw email text.
  if (!res.ok) {
    return { cleaned: SAFE_FALLBACK, safetyFlag: true, model: MODEL };
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: string; refusal?: string } }[];
  };
  const message = data.choices?.[0]?.message;
  if (!message || message.refusal) {
    return { cleaned: SAFE_FALLBACK, safetyFlag: true, model: MODEL };
  }
  const parsed = typeof message.content === "string" ? extractJson(message.content) : null;
  if (!parsed || typeof parsed.cleaned !== "string" || parsed.sensitive === undefined) {
    return { cleaned: SAFE_FALLBACK, safetyFlag: true, model: MODEL };
  }
  if (parsed.sensitive) {
    return { cleaned: SAFE_FALLBACK, safetyFlag: true, model: MODEL };
  }
  const cleaned = parsed.cleaned.trim();
  // Code backstop: even if the model said it's safe, a sensitive pattern in the OUTPUT fails closed.
  const hit = containsSensitive(cleaned);
  if (hit) {
    console.warn(`[relay] cleaner output scrubbed (${hit}) — forcing fallback`);
    return { cleaned: SAFE_FALLBACK, safetyFlag: true, model: MODEL };
  }
  return { cleaned, safetyFlag: false, model: MODEL };
}
