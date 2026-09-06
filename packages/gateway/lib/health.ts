import type { ModuleName } from "@meco/contracts";
import type { RecordsReach } from "@meco/records/health";
import type { StoreHealth } from "@meco/store/health";

/** What `models` looks like from here, over the Vercel service binding. */
export type ModelsReach = {
  /** `MODELS_URL` is present, so the binding was injected. */
  readonly bound: boolean;
  readonly reachable: boolean;
  /** HTTP status of the probe, or `null` when the call never completed. */
  readonly status: number | null;
};

/**
 * `ok` is the gateway's own liveness. A `models`, a `store` or a `records` that
 * cannot be reached is reported in its own block, not by failing this endpoint:
 * the gateway is up.
 */
export type Health = {
  readonly ok: boolean;
  readonly service: ModuleName;
  readonly version: string;
  readonly models: ModelsReach;
  readonly store: StoreHealth;
  readonly records: RecordsReach;
};

export function version(env: NodeJS.ProcessEnv = process.env): string {
  return env["VERCEL_GIT_COMMIT_SHA"] ?? env["MECO_VERSION"] ?? "0.0.0";
}

/**
 * Probe `models` through the binding. The binding resolves at runtime only,
 * never during a build, so this is called per request rather than cached.
 */
export async function reachModels(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch
): Promise<ModelsReach> {
  const base = env["MODELS_URL"];
  if (base === undefined || base === "") {
    return { bound: false, reachable: false, status: null };
  }

  try {
    const res = await fetchImpl(new URL("/health", base), {
      signal: AbortSignal.timeout(2000),
    });
    return { bound: true, reachable: res.ok, status: res.status };
  } catch {
    return { bound: true, reachable: false, status: null };
  }
}
