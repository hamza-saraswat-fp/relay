// Root page intentionally reveals nothing — customer pages live at /t/[token].
export default function Home() {
  return (
    <main style={{ padding: "4rem 2rem", textAlign: "center", color: "#555" }}>
      <h1 style={{ fontSize: "1.25rem" }}>FieldPulse Support Status</h1>
      <p>If you were sent a status link, use the full link from your email.</p>
    </main>
  );
}
