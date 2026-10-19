"use client";

import { useEffect } from "react";
import { entrySource } from "./analytics";

/**
 * Records one first-party page view per real page load (IAI-465, page-views slice).
 *
 * Why a beacon: email link scanners (Outlook Safe Links, Mimecast, …) follow the `/t/{token}` link
 * before the customer does, but rarely run JavaScript — so they never reach this. The account is
 * resolved server-side from the httpOnly cookie; this sends only `{ entry, internal }`.
 *
 * Not counted: reloads (the Refresh button calls `window.location.reload()`, and F5 is the same
 * visit), and React Strict Mode's dev-only second effect run (module-level `sent` guard; a real new
 * page load gets a fresh module).
 */
let sent = false;

export default function ViewBeacon() {
  useEffect(() => {
    if (sent) return;
    sent = true;
    try {
      const nav = performance.getEntriesByType?.("navigation")[0] as PerformanceNavigationTiming | undefined;
      if (nav?.type === "reload") return;

      const body = JSON.stringify({
        entry: entrySource(document.referrer),
        internal: new URLSearchParams(window.location.search).get("internal") === "1",
      });
      const queued =
        typeof navigator.sendBeacon === "function" &&
        navigator.sendBeacon("/api/view", new Blob([body], { type: "application/json" }));
      if (!queued) {
        void fetch("/api/view", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          keepalive: true,
        }).catch(() => {});
      }
    } catch {
      // Analytics must never affect the page.
    }
  }, []);

  return null;
}
