import { notFound } from "next/navigation";
import type { ReactElement } from "react";
import { getAccountView } from "@/lib/data";
import { type AccountView, type StatusChip, type Ticket } from "@/lib/types";
import RefreshButton from "./RefreshButton";
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

// Status icons — one bespoke glyph per state rather than a generic marker, so
// each chip reads at a glance without leaning on color alone.
function IconReply() {
  return (
    <svg className={styles.chipIcon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="9 14 4 9 9 4" />
      <path d="M20 20v-7a4 4 0 0 0-4-4H4" />
    </svg>
  );
}
function IconProgress() {
  return (
    <svg className={styles.chipIcon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <path d="M21 12a9 9 0 1 1-3-6.7" />
    </svg>
  );
}
function IconClock() {
  return (
    <svg className={styles.chipIcon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}
function IconCheck() {
  return (
    <svg className={styles.chipIcon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}
// Envelope glyph for the "how to reply" notice.
function IconMailNote() {
  return (
    <svg className={styles.noticeIcon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3 7 9 6 9-6" />
    </svg>
  );
}
// Disclosure chevron: sideways when collapsed, rotates to point down when open
// (styles.rez[open] .rchev handles the rotation).
function IconChevron() {
  return (
    <svg className={styles.rchev} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

// Plain-English status, one per ticket: whose ball is it, in the brand's colors.
const STATUS: Record<StatusChip, { label: string; cls: string; Icon: () => ReactElement }> = {
  waiting_for_you: { label: "Needs your reply", cls: "chip_you", Icon: IconReply },
  in_progress: { label: "Our team is on it", cls: "chip_working", Icon: IconProgress },
  waiting_for_support: { label: "In our support queue", cls: "chip_queued", Icon: IconClock },
  resolved: { label: "Resolved", cls: "chip_resolved", Icon: IconCheck },
};

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
    <main className={styles.page}>
      <div className={styles.wrap}>
        <header className={styles.bar}>
          <div className={styles.brandGroup}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className={styles.logo} src="/brand/navy_logo.svg" alt="FieldPulse" />
            <span className={styles.barDivider} aria-hidden />
            <span className={styles.barLabel}>Ticket Tracker</span>
          </div>
        </header>

        <section className={styles.hero}>
          <div>
            <h1 className={styles.h1}>{account.name}</h1>
            <p className={styles.lede}>
              Where every open ticket stands, updated live from our support team.
            </p>
          </div>

          <aside className={styles.summary}>
            <div className={styles.sumHead}>At a glance</div>
            <div className={styles.sumStats}>
              <div className={styles.sumStat}>
                <span className={styles.sumN}>{open.length}</span>
                <span className={styles.sumL}>Open {open.length === 1 ? "ticket" : "tickets"}</span>
              </div>
              <div className={`${styles.sumStat} ${styles.sumYou}`}>
                <span className={styles.sumN}>{needsResponse}</span>
                <span className={styles.sumL}>Needs your reply</span>
              </div>
              <div className={styles.sumStat}>
                <span className={styles.sumN}>{resolved.length}</span>
                <span className={styles.sumL}>Resolved<br />last 30 days</span>
              </div>
            </div>
          </aside>
        </section>

        <section className={styles.how} aria-label="How to reply to a ticket">
          <div className={styles.howHead}>
            <IconMailNote />
            How to reply to a ticket
          </div>
          <ol className={styles.howSteps}>
            <li>
              <span className={styles.howNum}>1</span>
              <div>
                <b>Find the email</b>
                <p>
                  Every ticket title below is the subject line of an email from our support
                  team. Search your inbox for it.
                </p>
              </div>
            </li>
            <li>
              <span className={styles.howNum}>2</span>
              <div>
                <b>Reply in that thread</b>
                <p>
                  Your reply goes straight to the person working on it. No need to start a new
                  email.
                </p>
              </div>
            </li>
            <li>
              <span className={styles.howNum}>3</span>
              <div>
                <b>Track it here</b>
                <p>
                  Statuses below move as we work. Use Refresh any time to pull the latest.
                </p>
              </div>
            </li>
          </ol>
        </section>

        <div className={styles.sec}>
          <h2>Open tickets</h2>
          <span className={styles.secC}>{open.length} active</span>
          <span className={styles.rule} />
          <div className={styles.secEnd}>
            <span className={styles.updated}>Updated {fmtDate(account.lastUpdatedISO)}</span>
            {/* Live data only — in seed/offline mode there is nothing to refresh. */}
            {process.env.SUPABASE_URL ? <RefreshButton token={token} /> : null}
          </div>
        </div>

        {open.length === 0 ? (
          <p className={styles.empty}>No open tickets right now. You are all caught up.</p>
        ) : (
          open.map((t, i) => <TicketCard key={`open-${i}`} t={t} />)
        )}

        {resolved.length > 0 && (
          <details className={styles.rez}>
            <summary>
              <IconChevron />
              Recently resolved
              <span className={styles.rcount}>
                <b>{resolved.length}</b> resolved · last 30 days
              </span>
            </summary>
            {resolved.map((t, i) => (
              <div className={styles.rzItem} key={`res-${i}`}>
                <span className={styles.ck} aria-hidden>✓</span>
                <span className={styles.rzTitle}>{t.subject}</span>
                <span className={styles.rzDate}>
                  {t.resolvedDateISO ? `Resolved ${fmtDate(t.resolvedDateISO)}` : "Resolved"}
                </span>
              </div>
            ))}
          </details>
        )}

        <footer className={styles.footer}>
          <b>Need something that isn&apos;t listed here?</b> Email{" "}
          <a href="mailto:support@fieldpulse.com">support@fieldpulse.com</a> and our support team
          will pick it up from there.
          <div className={styles.fine}>
            This page is read-only and reflects your tickets in FieldPulse&apos;s support system.
            The link is private to your account.
          </div>
        </footer>
      </div>
    </main>
  );
}

function TicketCard({ t }: { t: Ticket }) {
  const attn = t.chip === "waiting_for_you";
  const status = STATUS[t.chip];
  return (
    <article className={`${styles.tk} ${attn ? styles.tkYou : ""}`}>
      <div className={styles.tkLeft}>
        <span className={`${styles.chip} ${styles[status.cls]}`}>
          <status.Icon />
          {status.label}
        </span>
        <h3 className={styles.subject}>{t.subject}</h3>
        <div className={styles.meta}>
          <span>Opened <b>{fmtDate(t.openedISO)}</b></span>
          <span>Updated <b>{fmtDate(t.lastActivityISO)}</b></span>
        </div>
      </div>
      <div className={styles.update}>
        <div className={styles.updLabel}>Latest update</div>
        <p>{t.latestUpdate}</p>
      </div>
    </article>
  );
}
