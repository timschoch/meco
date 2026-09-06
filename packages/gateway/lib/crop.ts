/**
 * The `crop` Operation: one photograph, one size, one Crop, with no Template
 * over it.
 *
 * The order is `lib/pipeline.ts`, which every Output-producing kind shares.
 * What is here is what only a Crop knows: the request itself is the Layout —
 * its own `width` and `height`, nothing occluded, and the `subjectArea` the
 * caller named rather than one a Plan derived — and compose's `cut` is the
 * paint. No Placement: a Crop is a size, not a Channel (ADR-0014).
 */
import { Box } from "@meco/contracts";
import { cut as composeCut } from "@meco/compose";
import type { Framing } from "@meco/frame";
import { z } from "zod";
import { Brand, FramingOptions } from "./inputs";
import {
  type FaceReport,
  type PipelineDeps,
  type Stages,
  pipeline,
} from "./pipeline";
import { SourceReference } from "./source";
import { recorded } from "./trace";

/** The `crop_image` Operation's input, on both Doors. */
export const CropInput = z.object({
  brand: Brand,
  source: SourceReference,
  width: z.int().positive().describe("The Crop's width in whole pixels."),
  height: z.int().positive().describe("The Crop's height in whole pixels."),
  subjectArea: Box.optional().describe(
    "Where the Subject must land in the Crop, in fractions of it. A Template gives frame one; a bare Crop has only what the caller says."
  ),
  ...FramingOptions,
});

export type CropInput = z.output<typeof CropInput>;

export type CropDeps = PipelineDeps;

/** A `RenderAnswer` without the Placement a bare Crop does not have. */
export type CropAnswer = {
  readonly output: {
    readonly url: string;
    readonly key: string;
    readonly kind: "crop";
    readonly width: number;
    readonly height: number;
    readonly mime: string;
    readonly bytes: number;
  };
  readonly call: { readonly id: string; readonly replayed: boolean };
  readonly framing: Framing;
  readonly faces: readonly FaceReport[];
};

/** The two stages a Crop fills in. */
const CROP: Stages<CropInput> = {
  kind: "crop",
  namespace: "crops",

  // No Step and nothing awaited: no module answers this, the request does.
  // `occlusion: []` because nothing will be drawn over the picture, which is
  // what makes frame free to use the whole window.
  layout: async (input) => ({
    target: { width: input.width, height: input.height },
    occlusion: [],
    ...(input.subjectArea === undefined
      ? {}
      : { subjectArea: input.subjectArea }),
  }),

  paint(input, layout, image, window, trace) {
    return trace.step("compose.cut", () =>
      composeCut({
        source: image,
        window,
        target: layout.target,
        ...(input.format === undefined ? {} : { format: input.format }),
        ...(input.quality === undefined ? {} : { quality: input.quality }),
      })
    );
  },
};

export async function cropImage(
  deps: CropDeps,
  input: CropInput
): Promise<CropAnswer> {
  const { brand } = input;

  const { call, result } = await recorded(deps, deps.caller, brand, "crop", (trace) =>
    pipeline(deps, input, CROP, trace)
  );

  // Not a Step: the row cannot time its own write, and a Replay files no
  // second Output — one Output, two Calls, which is what happened. No
  // `placement`: `outputs.record` stores `null` for a bare Crop.
  if (!result.replayed) {
    await deps.records.outputs.record({
      brand,
      storeKey: result.storeKey,
      callId: call.id,
      kind: "crop",
      requestHash: result.requestHash,
    });
  }

  return {
    output: {
      url: deps.store.publicUrl(result.storeKey),
      key: result.storeKey,
      kind: "crop",
      // The request's own size, not a second read of the bytes: compose cut to
      // it or refused, and `framing_mismatch` is how it refuses.
      width: input.width,
      height: input.height,
      mime: result.mime,
      bytes: result.bytes,
    },
    call: { id: call.id, replayed: result.replayed },
    framing: result.framing,
    faces: result.faces,
  };
}
