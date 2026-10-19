import styles from "./tracker.module.css";

/**
 * Rendered (as HTTP 404) when `/tracker` is opened without a valid session cookie: a cleared or
 * expired cookie, a private window that was closed, a bookmark of `/tracker` itself, or an unknown
 * link that `/t/[token]` redirected here after clearing the cookie. The fix is always the same —
 * re-click the permanent link — so say exactly that, in the brand's own layout.
 */
export default function TrackerNotFound() {
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
            <h1 className={styles.h1}>We couldn&apos;t open your ticket tracker</h1>
            <p className={styles.lede}>
              For your privacy, this page only opens from your personal link. Go back to the email
              from FieldPulse support and click the link again. It never expires.
            </p>
          </div>
        </section>

        <footer className={styles.footer}>
          <b>Still stuck?</b> Email{" "}
          <a href="mailto:support@fieldpulse.com">support@fieldpulse.com</a> and our support team
          will send your link again.
          <div className={styles.fine}>
            This page is read-only and reflects your tickets in FieldPulse&apos;s support system.
          </div>
        </footer>
      </div>
    </main>
  );
}
