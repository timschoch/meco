import type { AdapterRegion, DecodedImage, RegionKind } from "@meco/contracts";
import type { CatalogueModel } from "./model";

/**
 * A Model Adapter that draws no Region of its own: it takes the Regions the
 * Detectors found and hands them back with more on them. EdgeFace puts a Face
 * Print on each face Region whose landmarks it can align.
 *
 * models' own interface and not contracts', because contracts' `ModelAdapter`
 * is `run(image)` and widening it would give every Detector an argument it
 * ignores (ADR-0007, Decision 2).
 *
 * Every Enricher passes `enricherConformance` from `catalogue.ts`.
 */
export interface Enricher extends CatalogueModel {
  /** The one Region Kind this Enricher serves. It touches no other. */
  on: RegionKind;
  /**
   * The same Regions back, in the same order and the same number, each of the
   * served kind carrying what this Model could add. A Region the Model could
   * not serve is returned unchanged, never dropped: redact hides a face the
   * print could not name, so losing it would lose a stranger's face.
   *
   * `regions` is not written to. The image is the host's one decode, the same
   * buffer every Detector saw.
   */
  run(image: DecodedImage, regions: AdapterRegion[]): Promise<AdapterRegion[]>;
}
