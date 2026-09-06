import type { ModelAdapter } from "@meco/contracts";

/**
 * A Detector as the Catalogue holds it: contracts' Model Adapter, plus what
 * the host needs to warm it and to list it. Everything a request reads goes
 * through the adapter half; the rest is the operator's.
 */
export interface Detector extends ModelAdapter {
  /**
   * The SPDX id of `licence`, what `GET /models` shows. The text itself stays
   * in the repository and the image, read into `licence` at construction.
   */
  licenceId: string;
  /** Create the session now, so a request pays inference and not the load. */
  warm(): Promise<void>;
  /** Whether the session exists on this instance. Per instance, never per deployment. */
  isWarm(): boolean;
}

/**
 * The fixed list of Models this service holds, in the order they run and are
 * listed. Built once by `lib/catalogue.ts` from the real adapters; a test
 * hands `createApp` one with in-memory Detectors instead.
 */
export interface Catalogue {
  readonly detectors: readonly Detector[];
  /** The inference runtime's version, reported on `/health`. */
  readonly onnxruntime: string;
}
