"use client";

import { useEffect } from "react";
import Clarity from "@microsoft/clarity";
import { CLARITY_PROJECT_ID, bucket, entrySource, track } from "./analytics";

/**
 * Loads Microsoft Clarity and tags the session. Rendered by `app/tracker/page.tsx` only in
 * production, after the account has resolved — so it never runs on previews, in dev, or on a 404.
 *
 * Tags (all filterable in the Clarity UI):
 * - `account`      Supabase accounts.id — joins a session back to our data. Never the token.
 * - `entry`        where the visitor came from: `salesforce` (a CS agent clicking the Account
 *                  field) · `webmail` · `direct` (most email clients send no referrer) · `other`.
 *                  The "Customers" segment is `entry != salesforce AND internal != yes`.
 * - `open_tickets` bucketed count, `needs_reply` yes/no — page state at view time.
 * - `internal`     `yes` when the link was opened with `?internal=1` (our own testing).
 *
 * Events for the server-rendered bits (the `<details>` toggle and the footer mailto) are attached
 * here via `data-track` attributes so the page stays a Server Component.
 */

type Props = {
  accountId: string;
  openTickets: number;
  needsReply: number;
};

export default function ClarityTracker({ accountId, openTickets, needsReply }: Props) {
  useEffect(() => {
    try {
      Clarity.init(CLARITY_PROJECT_ID);
      // Hashed client-side by Clarity; the friendly name is the first 8 chars of the row id.
      Clarity.identify(accountId, undefined, undefined, accountId.slice(0, 8));
      Clarity.setTag("account", accountId);
      Clarity.setTag("entry", entrySource(document.referrer));
      Clarity.setTag("open_tickets", bucket(openTickets));
      Clarity.setTag("needs_reply", needsReply > 0 ? "yes" : "no");
      if (new URLSearchParams(window.location.search).get("internal") === "1") {
        Clarity.setTag("internal", "yes");
      }
    } catch {
      // Analytics must never affect the page.
    }

    const details = document.querySelector<HTMLDetailsElement>('[data-track="resolved"]');
    const onToggle = () => {
      if (details?.open) track("resolved_expanded");
    };
    details?.addEventListener("toggle", onToggle);

    const mail = document.querySelector<HTMLAnchorElement>('[data-track="support_email"]');
    const onMail = () => track("support_email_clicked");
    mail?.addEventListener("click", onMail);

    return () => {
      details?.removeEventListener("toggle", onToggle);
      mail?.removeEventListener("click", onMail);
    };
  }, [accountId, openTickets, needsReply]);

  return null;
}
