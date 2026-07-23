"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./tracker.module.css";

/**
 * Customer-facing "Refresh" control (IAI-396) — the only interactive piece on an otherwise
 * fully-SSR page.
 *
 * A sync takes ~4 minutes, so the endpoint starts it in the background and we poll until a run
 * that began after this click has finished, then reload to show the fresh data. Every non-started
 * outcome is phrased as reassurance ("Already up to date"), never as an error.
 */

const POLL_MS = 12_000;
const GIVE_UP_MS = 6 * 60_000;

type Phase = "idle" | "starting" | "refreshing" | "done" | "fresh" | "busy" | "slow" | "error";

const MESSAGE: Partial<Record<Phase, string>> = {
  refreshing: "Refreshing — this takes a couple of minutes…",
  fresh: "Already up to date.",
  busy: "High refresh traffic right now — try again in a few minutes.",
  slow: "Taking longer than usual — check back shortly.",
  error: "Couldn't refresh — try again shortly.",
};

export default function RefreshButton({ token }: { token: string }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  // Clear any pending timers if the component goes away mid-poll.
  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach(clearTimeout);
  }, []);

  const poll = useCallback(
    (clickedAtMs: number) => {
      const deadline = Date.now() + GIVE_UP_MS;

      const tick = async () => {
        if (Date.now() > deadline) {
          setPhase("slow");
          return;
        }
        try {
          const res = await fetch(`/api/refresh?token=${encodeURIComponent(token)}`, {
            cache: "no-store",
          });
          if (res.ok) {
            const run = (await res.json()) as {
              startedAt: string | null;
              finishedAt: string | null;
            };
            // Only a run that began after the click can reflect this refresh.
            const startedAfterClick =
              run.startedAt !== null && new Date(run.startedAt).getTime() >= clickedAtMs - 2000;
            if (startedAfterClick && run.finishedAt) {
              setPhase("done");
              window.location.reload();
              return;
            }
          }
        } catch {
          // Transient network blip — keep polling until the deadline.
        }
        timers.current.push(setTimeout(tick, POLL_MS));
      };

      timers.current.push(setTimeout(tick, POLL_MS));
    },
    [token],
  );

  const onClick = useCallback(async () => {
    setPhase("starting");
    const clickedAtMs = Date.now();
    try {
      const res = await fetch("/api/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (!res.ok) {
        setPhase("error");
        return;
      }
      const { state } = (await res.json()) as { state: string };
      if (state === "started" || state === "refreshing") {
        setPhase("refreshing");
        poll(state === "refreshing" ? 0 : clickedAtMs);
        return;
      }
      // 'fresh' — synced recently, already current. 'busy' — global safety valve engaged.
      setPhase(state === "busy" ? "busy" : "fresh");
    } catch {
      setPhase("error");
    }
  }, [token, poll]);

  const busy = phase === "starting" || phase === "refreshing" || phase === "done";

  return (
    <span className={styles.refreshWrap}>
      <button
        type="button"
        className={styles.refreshBtn}
        onClick={onClick}
        disabled={busy}
        aria-busy={busy}
      >
        <svg
          className={`${styles.refreshIcon} ${busy ? styles.refreshSpin : ""}`}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M21 12a9 9 0 1 1-2.64-6.36" />
          <polyline points="21 3 21 9 15 9" />
        </svg>
        {busy ? "Refreshing…" : "Refresh"}
      </button>
      {MESSAGE[phase] && (
        <span className={styles.refreshMsg} role="status">
          {MESSAGE[phase]}
        </span>
      )}
    </span>
  );
}
