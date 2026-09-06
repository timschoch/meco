/**
 * `GET /health`: the gateway's own liveness, and what models, both stores and
 * the database look like from here. The three probes run behind one memoised
 * promise with a 30 s TTL, because the endpoint is unauthenticated and each
 * probe costs a round trip: the store block 268 ms private and 246 ms public
 * on the preview (#135), the records block one Neon round trip (#160).
 */
import type { ModuleName } from "@meco/contracts";
import { ModelsError, type ModelsClient } from "@meco/models";
import type { Records } from "@meco/records";
import { reachRecords, type RecordsReach } from "@meco/records/health";
import { reachStores, type StoreHealth } from "@meco/store/health";

/** What `models` looks like from here, over the Vercel service binding. */
export type ModelsReach = {
  /** `MODELS_URL` is present, so the binding was injected. */
  readonly bound: boolean;
  readonly reachable: boolean;
  /** HTTP status of the probe, or `null` when the call never completed. */
  readonly status: number | null;
  /**
   * Every Model on the answering instance has its session, or `null` when
   * models did not answer. `reachable: true, warm: false` is a cold start in
   * progress, without a third state.
   */
  readonly warm: boolean | null;
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
  /** ISO 8601: when the blocks below were probed, so a cached body says so. */
  readonly probedAt: string;
  readonly models: ModelsReach;
  readonly store: StoreHealth;
  readonly records: RecordsReach;
};

export const HEALTH_TTL_MS = 30_000;

/**
 * A cold models start creates three ONNX sessions after it listens, longer
 * than the 2 s the skeleton allowed, so the first `/health` after idle used to
 * report a live service as down (#88, Q7).
 */
export const MODELS_PROBE_TIMEOUT_MS = 10_000;

export async function reachModels(
  models: ModelsClient | null,
  timeoutMs = MODELS_PROBE_TIMEOUT_MS
): Promise<ModelsReach> {
  if (models === null) {
    return { bound: false, reachable: false, status: null, warm: null };
  }
  let timer: NodeJS.Timeout | undefined;
  const clock = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new ModelsError("timeout", "the health probe timed out", undefined)
        ),
      timeoutMs
    );
    timer.unref();
  });
  try {
    const body = await Promise.race([models.health(), clock]);
    return {
      bound: true,
      reachable: true,
      status: 200,
      warm: body.models.every((model) => model.warm),
    };
  } catch (error) {
    const status = error instanceof ModelsError ? (error.status ?? null) : null;
    return { bound: true, reachable: false, status, warm: null };
  } finally {
    clearTimeout(timer);
  }
}

export interface HealthProbeDeps {
  readonly records: Records;
  readonly models: ModelsClient | null;
  readonly version: string;
  now(): Date;
}

/**
 * The memoised probe. A body younger than the TTL is answered again; the
 * promise is shared, so two requests in the same instant probe once too.
 */
export function healthProbe(
  deps: HealthProbeDeps,
  ttlMs = HEALTH_TTL_MS
): () => Promise<Health> {
  let cached: { readonly at: number; readonly body: Promise<Health> } | null =
    null;

  const probe = async (probedAt: Date): Promise<Health> => {
    const [models, store, records] = await Promise.all([
      reachModels(deps.models),
      reachStores(),
      reachRecords(deps.records),
    ]);
    return {
      ok: true,
      service: "gateway",
      version: deps.version,
      probedAt: probedAt.toISOString(),
      models,
      store,
      records,
    };
  };

  return () => {
    const now = deps.now();
    if (cached === null || now.getTime() - cached.at >= ttlMs) {
      cached = { at: now.getTime(), body: probe(now) };
    }
    return cached.body;
  };
}
