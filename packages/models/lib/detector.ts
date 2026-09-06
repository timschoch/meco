import type { ModelAdapter } from "@meco/contracts";
import type { Enricher } from "./enricher";
import type { CatalogueModel } from "./model";

/**
 * A Detector as the Catalogue holds it: contracts' Model Adapter, plus what
 * the host needs to warm it and to list it. Everything a request reads goes
 * through the adapter half; the rest is the operator's.
 */
export interface Detector extends ModelAdapter, CatalogueModel {}

/**
 * The fixed list of Models this service holds, in the order they run and are
 * listed: every Detector, then every Enricher. Built once by
 * `lib/catalogue.ts` from the real adapters; a test hands `createApp` one with
 * in-memory adapters instead.
 */
export interface Catalogue {
  readonly detectors: readonly Detector[];
  readonly enrichers: readonly Enricher[];
  /** The inference runtime's version, reported on `/health`. */
  readonly onnxruntime: string;
}
