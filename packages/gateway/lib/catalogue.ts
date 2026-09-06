/**
 * `CATALOGUE`: the `{ name, version }` pairs the gateway requires a cached
 * Annotation to be complete for, read off `models.catalogue()`. Memoised on
 * the first answer and forgotten on a failure, so a models still creating its
 * sessions is retried on the next request rather than at boot: until it
 * answers, the pipeline is `503 models_unavailable` and `/health` still serves
 * (spec, "Boot").
 */
import type { ModelId } from "@meco/contracts";
import type { ModelsClient } from "@meco/models";
import { GatewayError } from "./errors";

export function catalogueOf(
  models: ModelsClient | null
): () => Promise<readonly ModelId[]> {
  let known: Promise<readonly ModelId[]> | null = null;
  return () => {
    if (models === null) {
      return Promise.reject(
        new GatewayError(
          "models_unavailable",
          "MODELS_URL is not set, so no Model can run"
        )
      );
    }
    known ??= models
      .catalogue()
      .then((entries) => entries.map(({ name, version }) => ({ name, version })))
      .catch((error: unknown) => {
        known = null;
        throw error;
      });
    return known;
  };
}
