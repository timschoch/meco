import type { ModelId } from "@meco/contracts";

/**
 * What the host needs of a Catalogue entry whatever its role: enough to warm
 * it, to list it and to name it on `producedBy`. A Detector adds contracts'
 * Model Adapter to this; an Enricher adds models' own `run(image, regions)`.
 *
 * The split is what lets `/health`, `/models` and the warm loop walk both
 * roles as one list without knowing which is which.
 */
export interface CatalogueModel {
  /** The Model this adapter runs. Stamped on everything it answers with. */
  model: ModelId;
  /**
   * The verbatim licence text of the Model, read from the adapter's own
   * `LICENCE.txt` at construction, so a Model cannot be added without one.
   */
  licence: string;
  /**
   * The SPDX id of `licence`, what `GET /models` shows. The text itself stays
   * in the repository and the image.
   */
  licenceId: string;
  /** Create the session now, so a request pays inference and not the load. */
  warm(): Promise<void>;
  /** Whether the session exists on this instance. Per instance, never per deployment. */
  isWarm(): boolean;
}
