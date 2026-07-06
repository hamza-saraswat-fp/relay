import { notFound } from "next/navigation";
import { getAccountView } from "@/lib/data";
import { CHIP_LABEL, type AccountView, type StatusChip, type Ticket } from "@/lib/types";
import styles from "./tracker.module.css";

export const dynamic = "force-dynamic";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Format a date-only or ISO string without timezone drift.
function fmtDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return iso;
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

function waitingOn(chip: StatusChip): string {
  return chip === "waiting_for_you" ? "You" : "FieldPulse";
}

function chipClass(chip: StatusChip): string {
  return styles[`chip_${chip}`] ?? "";
}

export default async function TrackerPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  if (!UUID_RE.test(token)) notFound();

  let account: AccountView | null = null;
  try {
    account = await getAccountView(token);
  } catch (err) {
    // Fail closed — never leak an error page for a customer-facing link.
    console.error("[relay] getAccountView failed:", err);
    notFound();
  }
  if (!account) notFound();

  const open = account.tickets
    .filter((t) => t.chip !== "resolved")
    .sort((a, b) => (a.chip === "waiting_for_you" ? 0 : 1) - (b.chip === "waiting_for_you" ? 0 : 1));
  const resolved = account.tickets
    .filter((t) => t.chip === "resolved")
    .sort((a, b) => (b.resolvedDateISO ?? "").localeCompare(a.resolvedDateISO ?? ""));
  const needsResponse = open.filter((t) => t.chip === "waiting_for_you").length;

  return (
    <main className={styles.wrap}>
      <div className={styles.topbar}>
        <div className={styles.brand}>
          <span className={styles.badge}>FP</span> FieldPulse{" "}
          <span className={styles.brandMuted}>· Support Status</span>
        </div>
        <div className={styles.verified}>verified link</div>
      </div>

      <header className={styles.hero}>
        <div className={styles.eyebrow}>Technical Support — Status Report</div>
        <h1 className={styles.h1}>{account.name}</h1>
        <div className={styles.statline}>
          <span className={styles.stat}>
            <b>{open.length}</b> open ticket{open.length !== 1 ? "s" : ""}
          </span>
          {needsResponse > 0 && (
            <span className={`${styles.stat} ${styles.statAccent}`}>
              <b>{needsResponse}</b> need{needsResponse !== 1 ? "" : "s"} your response
            </span>
          )}
          <span className={`${styles.stat} ${styles.statGreen}`}>
            <b>{resolved.length}</b> resolved · last 30 days
          </span>
        </div>
        <div className={styles.asof}>
          Updated {fmtDate(account.lastUpdatedISO)} · refreshes automatically
        </div>

        {needsResponse > 0 && (
          <div className={styles.callout}>
            <span className={styles.calloutDot} />
            <p>
              <b>
                {needsResponse === 1
                  ? "One ticket is waiting on your response."
                  : `${needsResponse} tickets are waiting on your response.`}
              </b>{" "}
              Our team is paused until we hear back — reply to the email thread for that
              ticket and we&apos;ll pick it right up.
            </p>
          </div>
        )}
      </header>

      <div className={styles.seclabel}>Open tickets — {open.length}</div>
      {open.map((t, i) => (
        <TicketCard key={`open-${i}`} t={t} defaultOpen={t.chip === "waiting_for_you"} />
      ))}

      {resolved.length > 0 && (
        <details className={styles.resolvedGroup}>
          <summary className={styles.resolvedSummary}>
            <span className={styles.chev} aria-hidden>▾</span>
            Recently resolved
            <span className={styles.resCount}>{resolved.length} in the last 30 days</span>
          </summary>
          {resolved.map((t, i) => (
            <TicketCard key={`res-${i}`} t={t} defaultOpen={false} resolved />
          ))}
        </details>
      )}

      <footer className={styles.footer}>
        <b>Questions about a ticket?</b> Reply to the email thread you already have with our
        support team — every ticket above links back to its original conversation.
        <br />
        General support: <b>support@fieldpulse.com</b>
        <div className={styles.fine}>
          This page is read-only and updates automatically from FieldPulse&apos;s support system.
        </div>
      </footer>
    </main>
  );
}

function TicketCard({
  t,
  defaultOpen,
  resolved,
}: {
  t: Ticket;
  defaultOpen: boolean;
  resolved?: boolean;
}) {
  return (
    <details className={`${styles.tk} ${t.chip === "waiting_for_you" ? styles.tkAttn : ""}`} open={defaultOpen}>
      <summary className={styles.tkRow}>
        <span className={`${styles.chip} ${chipClass(t.chip)}`}>
          {resolved && t.resolvedDateISO
            ? `Resolved · ${fmtDate(t.resolvedDateISO)}`
            : CHIP_LABEL[t.chip]}
        </span>
        <span className={styles.tkMain}>
          <span className={styles.tkTitle}>{t.subject}</span>
          <span className={styles.tkMeta}>Opened {fmtDate(t.openedISO)}</span>
        </span>
        <span className={styles.chev} aria-hidden>▾</span>
      </summary>
      <div className={styles.tkBody}>
        <div className={styles.updLabel}>
          {resolved ? "Resolution" : "Latest update from our team"}
        </div>
        <div className={styles.upd}>{t.latestUpdate}</div>
        <div className={styles.facts}>
          <div className={styles.fact}>
            <b>Opened</b>
            <span>{fmtDate(t.openedISO)}</span>
          </div>
          <div className={styles.fact}>
            <b>Last activity</b>
            <span>{fmtDate(t.lastActivityISO)}</span>
          </div>
          {!resolved && (
            <div className={styles.fact}>
              <b>Waiting on</b>
              <span>{waitingOn(t.chip)}</span>
            </div>
          )}
        </div>
      </div>
    </details>
  );
}
