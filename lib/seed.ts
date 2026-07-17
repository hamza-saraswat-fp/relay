import type { AccountView } from "./types";

/**
 * Seed fixtures for building the page without Salesforce or a live database.
 * `data.ts` returns these when Supabase env is absent. Sample data only — the
 * accounts, tickets, and updates are fictional (mirrors the approved mock).
 * Tokens are stable so you can bookmark /t/<token> during dev.
 */
export const SEED_ACCOUNTS: Record<string, AccountView> = {
  // Bluebird Plumbing & Air — the account from the approved mock.
  "11111111-1111-4111-8111-111111111111": {
    name: "Bluebird Plumbing & Air",
    lastUpdatedISO: "2026-06-12T12:00:00Z",
    tickets: [
      {
        subject: "Invoice #70593 not syncing to QuickBooks",
        chip: "waiting_for_you",
        openedISO: "2026-01-15",
        lastActivityISO: "2026-06-10",
        lastReplyISO: "2026-06-10T15:22:00Z",
        emailSubject: "Re: Invoice #70593 not syncing to QuickBooks",
        latestUpdate:
          "We traced the sync failure to a mismatched tax mapping on this invoice. We've sent over two questions about how your QuickBooks tax codes are set up — once we hear back, the fix is ready to apply on our side.",
      },
      {
        subject: "Arrival window time changes after saving a job",
        chip: "in_progress",
        openedISO: "2026-04-28",
        lastActivityISO: "2026-06-09",
        latestUpdate:
          "We've reproduced this with your timezone settings and confirmed it's a defect, not a configuration issue. A fix is being tested now — we expect an update for you within the week.",
      },
      {
        subject: "Purchase orders not syncing for inventory-tracked items",
        chip: "in_progress",
        openedISO: "2026-05-05",
        lastActivityISO: "2026-06-06",
        latestUpdate:
          "This is with our engineering team. The root cause is on the integration side, so the fix requires a code change rather than a settings adjustment. It's scheduled into the current engineering cycle.",
      },
      {
        subject: 'Commission report excluding invoices in "sent" status',
        chip: "in_progress",
        openedISO: "2026-06-11",
        lastActivityISO: "2026-06-11",
        latestUpdate:
          "Thanks for the screenshots — a specialist is reviewing whether this is expected report behavior or a defect. You'll see an update here once we've made the first determination.",
      },
      {
        subject: "Duplicate charge appearing on customer payment",
        chip: "resolved",
        openedISO: "2026-05-12",
        lastActivityISO: "2026-05-28",
        resolvedDateISO: "2026-05-28",
        latestUpdate:
          "The duplicate was a display issue only — your customer was charged once. We corrected the payment record and verified the amounts match your processor statement.",
      },
      {
        subject: "Technicians unable to add materials from mobile app",
        chip: "resolved",
        openedISO: "2026-05-06",
        lastActivityISO: "2026-05-19",
        resolvedDateISO: "2026-05-19",
        latestUpdate:
          "A permissions setting was limiting material-list access for two technician accounts. We updated the user roles and confirmed with your office manager that both techs can now add materials.",
      },
      {
        subject: "Recurring invoice not sending for maintenance agreement",
        chip: "resolved",
        openedISO: "2026-04-30",
        lastActivityISO: "2026-05-15",
        resolvedDateISO: "2026-05-15",
        latestUpdate:
          "The agreement's billing schedule had an end date in the past, which stopped the invoices. We corrected the schedule, the missed invoice went out the same day, and future runs are confirmed.",
      },
    ],
  },

  // A second, lighter account — one open ticket waiting on support, no resolved items.
  "22222222-2222-4222-8222-222222222222": {
    name: "Cedar Ridge Electric",
    lastUpdatedISO: "2026-06-12T12:00:00Z",
    tickets: [
      {
        subject: "Work order filter panel loading very slowly",
        chip: "waiting_for_support",
        openedISO: "2026-06-08",
        lastActivityISO: "2026-06-11",
        latestUpdate:
          "Your ticket is in our support queue. We're gathering timing details on the filter panel and will follow up with next steps shortly.",
      },
    ],
  },
};
