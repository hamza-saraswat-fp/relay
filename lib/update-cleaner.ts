import { requireEnv } from "./env";
import type { StatusChip } from "./types";

/**
 * Turn a support agent's raw outbound email into a short, customer-facing status update for the
 * PUBLIC ticket page — with layered guardrails. IAI-214 / IAI-239 / IAI-316 / IAI-317 (prompt v4).
 *
 * Model: Claude Sonnet 5 via OpenRouter. The prompt writes in an implementation-specialist voice,
 * bans internal vocabulary, and is given the ticket's current status + subject + type + email age so
 * the update never contradicts the status chip shown next to it. Context is for tone/consistency
 * only — it is never quoted back to the customer, and only non-sensitive fields are ever passed in.
 *
 * Guardrail pipeline (IAI-317), every stage fails closed to SAFE_FALLBACK:
 *   1. latestMessageOnly()  — quoted thread history is cut BEFORE the model sees it, so an old ask
 *                             can never blend into a card labeled "latest update".
 *   2. generation           — prompt v4 (sanitize-not-suppress + read-only-page CTA rules).
 *   3. containsSensitive()  — deterministic scrub of the OUTPUT ($ / emails / phones).
 *   4. containsBannedCta()  — deterministic ban on impossible CTAs ("reply here" on a page with
 *                             no reply box).
 *   5. verifyFaithful()     — second LLM judge on the OUTPUT: nothing claimed beyond the source
 *                             email, no impossible actions. Verify-then-publish.
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

/**
 * Guardrail 1 (IAI-317): keep only the NEWEST message of an email — quoted thread history is cut
 * before the model ever sees it. Input is stripHtml'd plain text. Cuts at the first match of the
 * FieldPulse email-to-case separator ("--- Original Message ---") or a Gmail-style "On … wrote:"
 * line; also strips salesforce thread:: tokens. No separator → full text passes through.
 */
const QUOTE_SEPARATORS: RegExp[] = [
  /-{3,}\s*Original Message\s*-{3,}/i,
  /\bOn .{5,80}? wrote:/,
];

export function latestMessageOnly(text: string): string {
  let out = text;
  for (const re of QUOTE_SEPARATORS) {
    const m = out.match(re);
    if (m && m.index !== undefined) out = out.slice(0, m.index);
  }
  return out.replace(/thread::[^:\s]+::/g, " ").replace(/\s+/g, " ").trim();
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

PAGE IS READ-ONLY: This update appears on a status page the customer CANNOT reply on. If the customer needs to respond or send something, direct them to their EMAIL THREAD — say "reply to your email thread". NEVER say "reply here", "respond here", "let us know here", or anything implying they can act on the page itself.

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

/**
 * Guardrail 2 backstop (IAI-317): impossible calls-to-action. The page is read-only — an update
 * inviting the customer to "reply here" points at a reply box that doesn't exist. Separate list
 * from SENSITIVE_PATTERNS (different failure class), same fail-closed enforcement.
 */
const BANNED_CTA_PATTERNS: [string, RegExp][] = [
  ["reply here", /reply (right )?here/i],
  ["respond here", /respond (right )?here/i],
  ["let us know here", /let us know (right )?here/i],
  ["comment here", /comment (right )?here/i],
  ["reply below", /reply below/i],
  ["reply to this page", /reply (to|on) this page/i],
];

export function containsBannedCta(text: string): string | null {
  for (const [label, re] of BANNED_CTA_PATTERNS) {
    if (re.test(text)) return label;
  }
  return null;
}

/**
 * Guardrail 3 (IAI-317): runtime faithfulness gate — verify-then-publish. A second judge call on
 * every generated blurb: it must claim nothing beyond the source email and invite no action that
 * is impossible on a read-only page. Infra failure after retries → fail closed (pass: false); an
 * unfaithful blurb must never reach a customer, even once.
 */
const FAITHFUL_JUDGE = `You are a strict QA gate for a customer-facing support status update shown on a PUBLIC, READ-ONLY status page. Judge the UPDATE against the SOURCE EMAIL it summarizes, plus any CONTEXT provided:
1. FAITHFUL: the update must not state or ask anything that is not supported by the source email OR the context. The ticket SUBJECT and CURRENT STATUS in the context are legitimate sources — naming the issue from the subject when the email only says "the issue" is CORRECT, not invention. Omitting details, softening internal jargon, and rephrasing are all fine — inventing facts, asks, promises, or resolutions found in neither the email nor the context is not.
2. STATUS POLICY: the current status takes precedence over the email. If the status is open but the email says the case was closed, describing it as paused/easy-to-resume is CORRECT and required — do not fail it for omitting or softening "closed".
3. POSSIBLE: the page displays OUR updates automatically but has NO reply mechanism for the customer. "We'll post an update here" is CORRECT (that is what the page does). What must fail is inviting the CUSTOMER to act on the page — reply/respond/comment/send "here". Directing the customer to their email thread is correct.
Respond ONLY with JSON: {"pass": true|false, "reason": "<one short sentence>"}.`;

export async function verifyFaithful(
  source: string,
  cleaned: string,
  ctx?: CleanContext,
): Promise<{ pass: boolean; reason: string }> {
  const apiKey = requireEnv("OPENROUTER_API_KEY");
  const ctxLines: string[] = [];
  if (ctx?.subject) ctxLines.push(`Ticket subject: ${ctx.subject}`);
  if (ctx?.statusChip) ctxLines.push(`Current ticket status: ${STATUS_DESC[ctx.statusChip]}`);
  const context = ctxLines.length ? `CONTEXT:\n${ctxLines.join("\n")}\n\n` : "";
  const payload = `${context}SOURCE EMAIL:\n${source}\n\nUPDATE TO JUDGE:\n${cleaned}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(OPENROUTER_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "X-Title": "Relay-faithfulness-gate",
        },
        body: JSON.stringify({
          model: MODEL,
          temperature: 0,
          max_tokens: 300,
          messages: [
            { role: "system", content: FAITHFUL_JUDGE },
            { role: "user", content: payload },
          ],
        }),
      });
      if (!res.ok) continue;
      const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const parsed = extractJson<{ pass?: boolean; reason?: string }>(
        data.choices?.[0]?.message?.content ?? "",
      );
      if (parsed && typeof parsed.pass === "boolean") {
        return { pass: parsed.pass, reason: String(parsed.reason ?? "") };
      }
    } catch {
      // retry
    }
  }
  return { pass: false, reason: "faithfulness gate unavailable after retries (failing closed)" };
}

function extractJson<T>(text: string): T | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

export async function cleanUpdate(rawEmail: string, ctx?: CleanContext): Promise<CleanResult> {
  if (!rawEmail || !rawEmail.trim()) {
    return { cleaned: SAFE_FALLBACK, safetyFlag: false, model: MODEL };
  }

  // Guardrail 1: the model only ever sees the newest message — quoted history can't blend in.
  const source = latestMessageOnly(rawEmail);
  if (!source) {
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
          { role: "user", content: buildUserMessage(source, ctx) },
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
  const parsed =
    typeof message.content === "string"
      ? extractJson<{ cleaned?: string; sensitive?: boolean }>(message.content)
      : null;
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
  // Guardrail 2 backstop: impossible calls-to-action ("reply here" on a read-only page).
  const cta = containsBannedCta(cleaned);
  if (cta) {
    console.warn(`[relay] cleaner output has banned CTA ("${cta}") — forcing fallback`);
    return { cleaned: SAFE_FALLBACK, safetyFlag: true, model: MODEL };
  }
  // Guardrail 3: verify-then-publish — a second judge must confirm the update claims nothing
  // beyond the source email + context and invites no impossible action. Fails closed.
  const verdict = await verifyFaithful(source, cleaned, ctx);
  if (!verdict.pass) {
    console.warn(`[relay] faithfulness gate rejected update — forcing fallback (${verdict.reason})`);
    return { cleaned: SAFE_FALLBACK, safetyFlag: true, model: MODEL };
  }
  return { cleaned, safetyFlag: false, model: MODEL };
}
