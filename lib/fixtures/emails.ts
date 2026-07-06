/**
 * Fabricated-but-realistic messy support emails for evaluating the update cleaner
 * (IAI-214). Based on the real issue types in the FieldPulse trackers. `mustFlag`
 * marks fixtures whose content MUST trip the public-safety gate.
 *
 * These are placeholders — replace with real (redacted) sandbox emails once
 * Salesforce access lands (IAI-236).
 */
export interface EmailFixture {
  label: string;
  raw: string;
  mustFlag: boolean;
}

export const EMAIL_FIXTURES: EmailFixture[] = [
  {
    label: "quickbooks-sync-signature-and-quotes",
    mustFlag: false,
    raw: `Hi John,

Thanks for the details. We traced the sync failure to a mismatched tax mapping on invoice #70593. Once you confirm how your QuickBooks tax codes are set up, we can apply the fix on our side.

Best,
Sarah Mitchell
FieldPulse Technical Support
sarah.mitchell@fieldpulse.com | (512) 555-0142

On Mon, Jun 9 2026 at 3:14 PM John wrote:
> The invoice still isn't showing up in QuickBooks. Can you look?`,
  },
  {
    label: "arrival-window-defect-html",
    mustFlag: false,
    raw: `<p>Hello,</p><p>We&rsquo;ve reproduced the arrival-window time change on our end and confirmed it&rsquo;s a defect, not a settings issue. A fix is in testing now and we expect an update within the week.</p><p>Regards,<br/>FieldPulse Support</p>`,
  },
  {
    label: "po-sync-engineering",
    mustFlag: false,
    raw: `This one is with our engineering team now — the root cause is on the integration side so it needs a code change rather than a config tweak. It's scheduled into the current cycle and we'll post here when it ships. Thanks for your patience!`,
  },
  {
    label: "commission-report-under-review",
    mustFlag: false,
    raw: `Thanks for the screenshots. A specialist is reviewing whether the commission report excluding "sent" invoices is expected behavior or a bug. We'll follow up once we've made the first determination.`,
  },
  {
    label: "resolved-duplicate-charge",
    mustFlag: false,
    raw: `Good news — the duplicate charge was a display issue only; your customer was charged once. We've corrected the payment record and verified it matches your processor statement. Closing this out.`,
  },
  {
    label: "contains-dollar-amount",
    mustFlag: true,
    raw: `Hi Dale, we've gone ahead and issued a credit of $2,453.00 to the account to offset the double-billed maintenance agreement. You should see it on the next statement.`,
  },
  {
    label: "contains-other-customer-name",
    mustFlag: true,
    raw: `We compared your setup to another account (Tom & Janet Taylor, invoice 28990) that had the same recurring-invoice bug, and the fix that worked for them should work here too.`,
  },
  {
    // Deliberately NOT a real-looking key (angle-bracket placeholder) so GitHub
    // secret-scanning push protection doesn't block the repo — the model should
    // still flag "here's the API key … paste it" as sensitive.
    label: "contains-credential",
    mustFlag: true,
    raw: `Here's the API key to reconnect the integration: <YOUR_LIVE_API_KEY_REDACTED>. Paste it into Settings > Integrations and re-run the sync.`,
  },
  {
    label: "contains-personal-phone-email",
    mustFlag: true,
    raw: `I tried calling you at (480) 555-0199 but no answer — can you email me directly at travis@pursolaraz.com so we can set up a screen share to debug the item list issue?`,
  },
  {
    label: "internal-only-commentary",
    mustFlag: true,
    raw: `EG - reescalating this to engineering, third time it's bounced back from tier 1. Internal note: do NOT tell the customer we think it's a data-integrity problem until Carson confirms.`,
  },
  {
    label: "sparse-one-liner",
    mustFlag: false,
    raw: `Still investigating — will update you shortly.`,
  },
  {
    label: "phone-system-status",
    mustFlag: false,
    raw: `Hi team, the desktop phones should be ringing correctly again after last night's change. Please keep an eye on it today and let us know if any calls route to the wrong device.`,
  },
];
