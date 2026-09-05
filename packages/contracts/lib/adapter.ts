import type { ModelId, RegionKind } from "./annotation";
import type { AdapterRegion } from "./region-ids";

/**
 * A Source Image as raw pixels: RGB, row-major, top-left origin, one byte per
 * channel, so `data.length === width * height * 3`. The models host decodes
 * once and hands the same Decoded Image to every Model Adapter, because
 * decoding costs more than inference.
 *
 * A plain type and not a zod schema: nothing crosses a wire in this shape, and
 * validating a megabyte of pixels per call would cost more than it can catch.
 */
export interface DecodedImage {
  width: number;
  height: number;
  /** RGB. Alpha is dropped at decode; a grey image is decoded to three channels. */
  channels: 3;
  data: Uint8Array;
}

/**
 * The hand-written code that runs one Model over a Decoded Image and answers
 * in Adapter Regions. One adapter per Model: the middle cannot be generalised,
 * so only the edges are standardised — the same input in, the same output out.
 *
 * Ids are not the adapter's to give: the host passes the union of every
 * adapter's Regions to `assignRegionIds`.
 *
 * Every adapter passes `adapterConformance` from `@meco/contracts/conformance`.
 */
export interface ModelAdapter {
  /** The Model this adapter runs. Stamped on every Region it answers with. */
  model: ModelId;
  /**
   * The verbatim licence text of the Model. Read from the adapter's own
   * `LICENCE.txt`, so a Model cannot be added without one.
   */
  licence: string;
  /** The Region Kinds this adapter can emit. It emits no others. */
  kinds: RegionKind[];
  run(image: DecodedImage): Promise<AdapterRegion[]>;
}
