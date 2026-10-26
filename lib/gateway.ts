import { getVercelOidcToken } from "@vercel/oidc";

/**
 * Model calls go through the Vercel AI Gateway (OpenAI-compatible chat completions). On Vercel the
 * project's OIDC token authenticates them, so no model key is stored anywhere. AI_GATEWAY_API_KEY,
 * when set, takes precedence (local scripts, runs off Vercel). Locally, `vercel env pull` writes a
 * VERCEL_OIDC_TOKEN good for 12 hours.
 */
export const GATEWAY_URL = "https://ai-gateway.vercel.sh/v1/chat/completions";

/**
 * Bearer credential for the Gateway. Call inside request/job code, never at module top level — the
 * OIDC token is per request. Throws when neither credential is available, so a real misconfig
 * surfaces instead of silently falling back.
 */
export async function gatewayAuth(): Promise<string> {
  return process.env.AI_GATEWAY_API_KEY || (await getVercelOidcToken());
}
