import { requireEnv } from "./env";

/**
 * Salesforce Bulk API 2.0 read client (IAI-212).
 *
 * Reads go through Bulk API 2.0 (submit query job → poll → download CSV), NOT the
 * REST Query API — keeps Relay off the org's strained REST quota (Saffi's steer).
 * Standard, documented Bulk 2.0 shapes; validate against Saffi's docs + sandbox
 * once creds land.
 *
 * Auth: OAuth client-credentials against the sandbox/prod Connected App.
 */

const API_VERSION = "v60.0";
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

interface Token {
  accessToken: string;
  instanceUrl: string;
}

let cached: Token | null = null;

async function getToken(): Promise<Token> {
  if (cached) return cached;
  const instanceUrl = requireEnv("SF_INSTANCE_URL").replace(/\/+$/, "");
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: requireEnv("SF_CLIENT_ID"),
    client_secret: requireEnv("SF_CLIENT_SECRET"),
  });
  const res = await fetch(`${instanceUrl}/services/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    throw new Error(`Salesforce auth failed: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as { access_token: string; instance_url?: string };
  cached = {
    accessToken: json.access_token,
    instanceUrl: (json.instance_url ?? instanceUrl).replace(/\/+$/, ""),
  };
  return cached;
}

function authHeaders(token: Token): HeadersInit {
  return { Authorization: `Bearer ${token.accessToken}` };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Run a SOQL query via Bulk API 2.0 and return parsed rows (array of
 * column→value string maps). Handles job creation, polling, and paged CSV results.
 */
export async function runBulkQuery(soql: string): Promise<Record<string, string>[]> {
  const token = await getToken();
  const base = `${token.instanceUrl}/services/data/${API_VERSION}/jobs/query`;

  // 1. Create the query job.
  const createRes = await fetch(base, {
    method: "POST",
    headers: { ...authHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ operation: "query", query: soql }),
  });
  if (!createRes.ok) {
    throw new Error(`Bulk job create failed: ${createRes.status} ${await createRes.text()}`);
  }
  const { id: jobId } = (await createRes.json()) as { id: string };

  // 2. Poll until complete.
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    const statusRes = await fetch(`${base}/${jobId}`, { headers: authHeaders(token) });
    if (!statusRes.ok) {
      throw new Error(`Bulk job status failed: ${statusRes.status} ${await statusRes.text()}`);
    }
    const { state } = (await statusRes.json()) as { state: string };
    if (state === "JobComplete") break;
    if (state === "Failed" || state === "Aborted") {
      throw new Error(`Bulk job ${jobId} ended in state ${state}`);
    }
    if (Date.now() > deadline) throw new Error(`Bulk job ${jobId} timed out (state ${state})`);
    await sleep(POLL_INTERVAL_MS);
  }

  // 3. Download results, following Sforce-Locator paging.
  const rows: Record<string, string>[] = [];
  let locator: string | null = null;
  do {
    const url = new URL(`${base}/${jobId}/results`);
    if (locator) url.searchParams.set("locator", locator);
    const res = await fetch(url, {
      headers: { ...authHeaders(token), Accept: "text/csv" },
    });
    if (!res.ok) {
      throw new Error(`Bulk results fetch failed: ${res.status} ${await res.text()}`);
    }
    rows.push(...parseCsv(await res.text()));
    const next = res.headers.get("Sforce-Locator");
    locator = next && next !== "null" ? next : null;
  } while (locator);

  return rows;
}

/**
 * Minimal RFC-4180 CSV parser (handles quotes, escaped quotes, embedded newlines/commas).
 * Salesforce Bulk 2.0 returns UTF-8 CSV with a header row.
 */
export function parseCsv(csv: string): Record<string, string>[] {
  const records: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < csv.length; i++) {
    const c = csv[i];
    if (inQuotes) {
      if (c === '"') {
        if (csv[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && csv[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") records.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    if (row.length > 1 || row[0] !== "") records.push(row);
  }

  if (records.length === 0) return [];
  const header = records[0];
  return records.slice(1).map((r) => {
    const obj: Record<string, string> = {};
    header.forEach((h, idx) => (obj[h] = r[idx] ?? ""));
    return obj;
  });
}

/** Reset the cached token (used if a request 401s mid-run). */
export function resetSalesforceToken(): void {
  cached = null;
}
