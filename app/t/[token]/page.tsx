import { notFound } from "next/navigation";
import { getServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Customer status page (scaffold). Placeholder rendering only — the real UI
 * (approved FieldPulse-branded mock) lands with IAI-238.
 */
export default async function TrackerPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  // Non-UUID tokens can't exist — 404 without touching the database.
  if (!UUID_RE.test(token)) notFound();

  let account: { id: string; name: string } | null = null;
  try {
    const supabase = getServiceClient();
    const { data, error } = await supabase
      .from("accounts")
      .select("id, name")
      .eq("token", token)
      .maybeSingle();
    if (error) throw error;
    account = data;
  } catch (err) {
    // Scaffold behavior: fail closed. IAI-238 may distinguish 500 from 404.
    console.error("[relay] account lookup failed:", err);
    notFound();
  }

  if (!account) notFound();

  return (
    <main style={{ padding: "4rem 2rem", maxWidth: 720, margin: "0 auto" }}>
      <h1>{account.name} — Support Status</h1>
      <p style={{ color: "#777" }}>
        Status page scaffold — ticket list UI arrives with IAI-238.
      </p>
    </main>
  );
}
