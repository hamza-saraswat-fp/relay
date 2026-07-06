/**
 * Fail-fast env access (comp-intel pattern). Call inside request/job code, not
 * at module top level — Next.js evaluates modules at build time when envs may
 * legitimately be absent.
 */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}
