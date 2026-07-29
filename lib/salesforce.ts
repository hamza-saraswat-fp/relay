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
/** Budget for ONE Bulk query's polling. Deliberately well under the route's maxDuration (300s):
 *  a sync runs two queries plus the cleaning phase, and a run that overruns maxDuration is hard-
 *  killed by Vercel — no catch block runs, so the sync_runs row is left stuck at 'running' instead
 *  of recording a clean error. Healthy queries finish in ~10s; 90s is already pathological. */
const POLL_TIMEOUT_MS = 90 * 1000;
/** Re-auth well before Salesforce expires the token, rather than waiting for a 401 (IAI-460). */
const TOKEN_TTL_MS = 30 * 60 * 1000;
/** Attempts per call, including the first. */
const RETRY_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 8000;

interface Token {
  accessToken: string;
  instanceUrl: string;
  fetchedAt: number;
}

let cached: Token | null = null;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

export interface RetryOpts {
  attempts?: number;
  /** Absolute epoch-ms ceiling. A retry is abandoned if its backoff would sleep past this. */
  deadline?: number;
  fetchImpl?: FetchLike;
  sleepImpl?: (ms: number) => Promise<void>;
  /** For log context, e.g. "bulk poll". */
  label?: string;
}

/**
 * Is this HTTP status worth retrying? (IAI-460)
 *
 * 5xx and 429 are transient — the request was well-formed and may succeed later. Every other 4xx
 * means we sent something wrong (bad SOQL, bad credentials, missing permission); retrying just
 * burns time and API quota to fail identically. 401 is handled separately by `sfFetch`, which
 * re-authenticates rather than blindly repeating the same rejected request.
 */
export function shouldRetryStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * Exponential backoff with jitter, capped. Honors a server-supplied `Retry-After` (seconds) when
 * present, since that's authoritative. Jitter matters less for a single-instance cron than for a
 * fleet, but it costs nothing and avoids lockstep retries when several syncs overlap.
 */
export function backoffMs(attempt: number, retryAfterSec?: number): number {
  if (retryAfterSec !== undefined && Number.isFinite(retryAfterSec) && retryAfterSec >= 0) {
    return Math.min(retryAfterSec * 1000, BACKOFF_CAP_MS);
  }
  const exponential = Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1), BACKOFF_CAP_MS);
  return Math.round(exponential * (0.75 + Math.random() * 0.5));
}

function retryAfterSeconds(res: Response): number | undefined {
  const raw = res.headers.get("Retry-After");
  if (!raw) return undefined;
  const secs = Number(raw);
  return Number.isFinite(secs) ? secs : undefined;
}

/**
 * `fetch` that survives a transient blip (IAI-460).
 *
 * The 2026-07-29 sync failure was a single dropped connection on one of the ~6-10 round-trips a
 * sync makes to Salesforce — with no retry anywhere, that killed the entire run. Retries here
 * cover network-level throws, 5xx, and 429.
 *
 * Deadline-aware: retry sleeps can never push a call past its caller's budget, because overrunning
 * the function's maxDuration is strictly worse than failing cleanly.
 *
 * `fetchImpl`/`sleepImpl` are injectable so the retry behavior is unit-testable without a network
 * or real delays (the repo has no mocking framework).
 */
export async function fetchWithRetry(
  url: string | URL,
  init: RequestInit = {},
  opts: RetryOpts = {},
): Promise<Response> {
  const attempts = opts.attempts ?? RETRY_ATTEMPTS;
  const doFetch = opts.fetchImpl ?? ((u, i) => fetch(u, i));
  const doSleep = opts.sleepImpl ?? sleep;
  const label = opts.label ?? "salesforce";

  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let res: Response | null = null;
    try {
      res = await doFetch(url, init);
      if (!shouldRetryStatus(res.status)) return res; // success or a non-retryable error
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastErr = err; // network-level failure — the actual incident
    }

    if (attempt === attempts) break;
    const wait = backoffMs(attempt, res ? retryAfterSeconds(res) : undefined);
    if (opts.deadline !== undefined && Date.now() + wait > opts.deadline) {
      console.warn(`[relay] ${label}: retry budget exhausted (deadline), giving up`);
      break;
    }
    console.warn(
      `[relay] ${label}: attempt ${attempt}/${attempts} failed (${
        lastErr instanceof Error ? lastErr.message : String(lastErr)
      }) — retrying in ${wait}ms`,
    );
    await doSleep(wait);
  }

  if (lastErr instanceof Error) throw lastErr;
  throw new Error(`${label}: request failed`);
}

/**
 * Cached bearer token. The cache is now time-boxed (IAI-460): it previously lived for the whole
 * lifetime of a warm serverless instance with no expiry check, so once Salesforce expired the
 * token every subsequent call would 401 forever with no recovery path.
 */
async function getToken(force = false): Promise<Token> {
  if (!force && cached && Date.now() - cached.fetchedAt < TOKEN_TTL_MS) return cached;

  const instanceUrl = requireEnv("SF_INSTANCE_URL").replace(/\/+$/, "");
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: requireEnv("SF_CLIENT_ID"),
    client_secret: requireEnv("SF_CLIENT_SECRET"),
  });
  const res = await fetchWithRetry(
    `${instanceUrl}/services/oauth2/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    },
    { label: "sf auth" },
  );
  if (!res.ok) {
    throw new Error(`Salesforce auth failed: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as { access_token: string; instance_url?: string };
  cached = {
    accessToken: json.access_token,
    instanceUrl: (json.instance_url ?? instanceUrl).replace(/\/+$/, ""),
    fetchedAt: Date.now(),
  };
  return cached;
}

function authHeaders(token: Token): HeadersInit {
  return { Authorization: `Bearer ${token.accessToken}` };
}

/**
 * Authenticated Salesforce request: retry + one-shot 401 recovery (IAI-460).
 *
 * A 401 means the token went stale mid-run, so re-authenticating and repeating once is the correct
 * response — retrying the same rejected request would fail identically. This finally wires up
 * `resetSalesforceToken`, which was exported but never called.
 */
async function sfFetch(
  url: string | URL,
  init: RequestInit,
  deadline: number,
  label: string,
): Promise<Response> {
  const token = await getToken();
  const res = await fetchWithRetry(
    url,
    { ...init, headers: { ...authHeaders(token), ...((init.headers as Record<string, string>) ?? {}) } },
    { deadline, label },
  );
  if (res.status !== 401) return res;

  console.warn(`[relay] ${label}: 401 — re-authenticating and retrying once`);
  resetSalesforceToken();
  const fresh = await getToken(true);
  return fetchWithRetry(
    url,
    { ...init, headers: { ...authHeaders(fresh), ...((init.headers as Record<string, string>) ?? {}) } },
    { deadline, label: `${label} (post-reauth)` },
  );
}

/**
 * Run a SOQL query via Bulk API 2.0 and return parsed rows (array of
 * column→value string maps). Handles job creation, polling, and paged CSV results.
 *
 * Every call goes through `sfFetch`, so a transient blip on any single round-trip no longer kills
 * the whole sync. The create call is retried too: if its response is lost after the job was
 * actually created, the retry leaves an orphan job that completes and is never read — ~1 wasted
 * Bulk job out of the org's 10,000/day, an accepted trade for closing that failure surface.
 */
export async function runBulkQuery(soql: string): Promise<Record<string, string>[]> {
  const token = await getToken();
  const base = `${token.instanceUrl}/services/data/${API_VERSION}/jobs/query`;
  // One budget for the whole query, so retry sleeps can't extend it past the caller's limit.
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  // 1. Create the query job.
  const createRes = await sfFetch(
    base,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operation: "query", query: soql }),
    },
    deadline,
    "bulk create",
  );
  if (!createRes.ok) {
    throw new Error(`Bulk job create failed: ${createRes.status} ${await createRes.text()}`);
  }
  const { id: jobId } = (await createRes.json()) as { id: string };

  // 2. Poll until complete.
  for (;;) {
    const statusRes = await sfFetch(`${base}/${jobId}`, {}, deadline, "bulk poll");
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
    const res = await sfFetch(url, { headers: { Accept: "text/csv" } }, deadline, "bulk results");
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
