import type { ModelId, ModuleName } from "@meco/contracts";

/** What `GET /health` answers: this instance's liveness, warmth and memory. */
export type Health = {
  readonly ok: boolean;
  readonly service: ModuleName;
  readonly version: string;
  /** Every Model in the Catalogue, and whether it is Warm on this instance. */
  readonly models: readonly (ModelId & { readonly warm: boolean })[];
  readonly onnxruntime: string;
  /** Resident set size in bytes, so a leak or a cold start is visible without a profiler. */
  readonly rss: number;
};

/**
 * The running revision. Vercel injects `VERCEL_GIT_COMMIT_SHA` into every
 * function at runtime; outside Vercel the package version is the fallback.
 */
export function version(env: NodeJS.ProcessEnv = process.env): string {
  return env["VERCEL_GIT_COMMIT_SHA"] ?? env["MECO_VERSION"] ?? "0.0.0";
}
