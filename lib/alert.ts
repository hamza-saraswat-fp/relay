/**
 * Fail-safe operational alerting (IAI-239). Sync-failure notifications to a Slack incoming webhook.
 *
 * If SLACK_ALERT_WEBHOOK_URL is unset it no-ops (local/dev/tests stay silent). Alerting must NEVER
 * affect the thing it observes, so every path is wrapped — this function never throws.
 */

interface SyncFailureContext {
  error: string;
  runId?: string;
  casesUpserted?: number;
}

export async function notifySyncFailure(ctx: SyncFailureContext): Promise<void> {
  const webhook = process.env.SLACK_ALERT_WEBHOOK_URL;
  if (!webhook) {
    console.warn("[relay] sync failed but SLACK_ALERT_WEBHOOK_URL is unset — no alert sent.");
    return;
  }
  const origin = process.env.NEXT_PUBLIC_APP_URL ?? "(unknown origin)";
  const text = [
    "🔴 *Relay sync failed*",
    `*Error:* ${ctx.error}`,
    ctx.runId ? `*Run:* ${ctx.runId}` : null,
    `*App:* ${origin}`,
    `*At:* ${new Date().toISOString()}`,
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const res = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      console.error(`[relay] Slack alert POST failed: ${res.status} ${await res.text().catch(() => "")}`);
    }
  } catch (err) {
    // Never let alerting throw into the sync.
    console.error("[relay] Slack alert threw:", err);
  }
}
