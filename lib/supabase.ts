import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { requireEnv } from "./env";

/**
 * Service-role client — SERVER ONLY. Relay renders everything server-side; the
 * browser must never receive this client or the service-role key. Lazy singleton
 * so builds succeed without envs and requests fail fast without them.
 */
let client: SupabaseClient | null = null;

export function getServiceClient(): SupabaseClient {
  if (!client) {
    client = createClient(
      requireEnv("SUPABASE_URL"),
      requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
      { auth: { persistSession: false } }
    );
  }
  return client;
}
