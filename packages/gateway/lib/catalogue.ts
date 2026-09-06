/**
 * `CATALOGUE`: the `{ name, version }` pairs the gateway requires a cached
 * Annotation to be complete for, read off `models.catalogue()`. Memoised on
 * the first answer and forgotten on a failure, so a models still creating its
 * sessions is retried on the next request rather than by a boot timer: until
 * it answers, the pipeline is `503 models_unavailable` and `/health` still
 * serves (spec, "Boot").
 */
import type { ModelId } from "@meco/contracts";
import type { ModelsClient } from "@meco/models";
import { GatewayError } from "./errors";

/** No client at all: `MODELS_URL` was not injected. */
export const modelsUnbound = (): GatewayError =>
  new GatewayError(
    "models_unavailable",
    "MODELS_URL is not set, so no Model can run"
  );

export function catalogueOf(
  models: ModelsClient | null
): () => Promise<readonly ModelId[]> {
  let known: Promise<readonly ModelId[]> | null = null;
  return () => {
    if (models === null) return Promise.reject(modelsUnbound());
    known ??= models
      .catalogue()
      .then((entries) => entries.map(({ name, version }) => ({ name, version })))
      .catch((cause: unknown) => {
        known = null;
        // Whatever models answered, the gateway has no Catalogue: one code,
        // and the caller does the one thing it can about it, try again later.
        throw new GatewayError(
          "models_unavailable",
          "models has not answered with its Catalogue yet",
          undefined,
          { cause }
        );
      });
    return known;
  };
}
