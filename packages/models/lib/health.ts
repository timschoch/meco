/**
 * The running revision. Vercel injects `VERCEL_GIT_COMMIT_SHA` into every
 * function at runtime; outside Vercel the package version is the fallback.
 */
export function version(env: NodeJS.ProcessEnv = process.env): string {
  return env["VERCEL_GIT_COMMIT_SHA"] ?? env["MECO_VERSION"] ?? "0.0.0";
}
