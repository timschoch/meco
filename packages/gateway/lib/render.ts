/**
 * The `render` Operation: one photograph, one Template, one Placement, one
 * Render.
 *
 * The order is `lib/pipeline.ts`, which every Output-producing kind shares.
 * What is here is what only a Render knows: compose's Plan is the Fill, and
 * compose's `render` is the paint.
 */
import {
  plan as composePlan,
  render as composeRender,
  templates,
} from "@meco/compose";
import { placement as placementById } from "@meco/compose/placements";
import { z } from "zod";
import { Brand, FramingOptions } from "./inputs";
import {
  type CallFraming,
  type FaceReport,
  type NumberReport,
  type PipelineDeps,
  type Stages,
  pipeline,
} from "./pipeline";
import { SourceReference } from "./source";
import { recorded } from "./trace";

/** The `render_image` Operation's input, on both Doors. */
export const RenderInput = z.object({
  brand: Brand,
  template: z.string().min(1),
  placement: z.string().min(1),
  fields: z.record(z.string(), z.unknown()),
  source: SourceReference,
  ...FramingOptions,
});

export type RenderInput = z.output<typeof RenderInput>;

export type RenderDeps = PipelineDeps;

/**
 * A type alias and not an interface: an Operation answers a
 * `Record<string, unknown>`, which the MCP Door carries as
 * `structuredContent`, and only an alias gets the implicit index signature
 * that makes it one.
 */
export type RenderAnswer = {
  readonly output: {
    readonly url: string;
    readonly key: string;
    readonly kind: "render";
    readonly placement: string;
    readonly width: number;
    readonly height: number;
    readonly mime: string;
    readonly bytes: number;
  };
  readonly call: { readonly id: string; readonly replayed: boolean };
  readonly framing: CallFraming;
  readonly faces: readonly FaceReport[];
  readonly numbers: readonly NumberReport[];
};

/** The two stages a Render fills in. */
const RENDER: Stages<RenderInput> = {
  namespace: "renders",

  // One Fill per Plan, which is one per Template Variant: compose measures
  // every layout the Template offers and frame chooses among them.
  async fill(deps, input, trace) {
    const plans = await trace.step("compose.plan", () =>
      composePlan(
        {
          template: input.template,
          placement: input.placement,
          brand: input.brand,
          fields: input.fields,
        },
        deps.templates
      )
    );
    return plans.map((plan) => ({
      target: plan.imageSlot,
      occlusion: plan.occlusion,
      ...(plan.subjectArea === undefined
        ? {}
        : { subjectArea: plan.subjectArea }),
      ...(plan.variant === undefined ? {} : { variant: plan.variant }),
    }));
  },

  // `fill` is the one frame chose, so its Variant is the one to draw.
  paint(deps, input, fill, image, window, trace) {
    return trace.step("compose.render", () =>
      composeRender(
        {
          template: input.template,
          placement: input.placement,
          brand: input.brand,
          fields: input.fields,
          source: image,
          window,
          ...(fill.variant === undefined ? {} : { variant: fill.variant }),
          ...(input.format === undefined ? {} : { format: input.format }),
          ...(input.quality === undefined ? {} : { quality: input.quality }),
        },
        deps.templates
      )
    );
  },

  // The Template's rung of the Redaction Policy, off the same catalogue
  // `list_templates` answers from and the same registry the Plan came from.
  // A Template the Brand does not have is not refused here: `compose.plan`
  // already ran and would have said so, and a lookup that missed can only
  // mean the Template declares nothing.
  templateRedaction: (deps, input) =>
    templates(input.brand, deps.templates).find(
      (one) => one.id === input.template
    )?.redaction,
};

export async function renderImage(
  deps: RenderDeps,
  input: RenderInput
): Promise<RenderAnswer> {
  const { brand, placement } = input;

  const { call, result } = await recorded(
    deps,
    deps.caller,
    brand,
    "render",
    (trace) => pipeline(deps, input, RENDER, trace)
  );

  // Not a Step: the row cannot time its own write, and a Replay files no
  // second Output — one Output, two Calls, which is what happened.
  if (!result.replayed) {
    await deps.records.outputs.record({
      brand,
      storeKey: result.storeKey,
      callId: call.id,
      kind: "render",
      placement,
      requestHash: result.requestHash,
    });
  }

  // The Placement is the canvas compose drew on, so the output's size is a
  // fact of the catalogue and costs no second decode of the bytes just
  // written. Unreachable: compose refuses a Placement it does not hold before
  // anything is rendered, so this is a catalogue that disagrees with itself.
  const size = placementById(placement);
  if (size === undefined) {
    throw new Error(`compose rendered for the unknown Placement ${placement}`);
  }

  return {
    output: {
      url: deps.store.publicUrl(result.storeKey),
      key: result.storeKey,
      kind: "render",
      placement,
      width: size.width,
      height: size.height,
      mime: result.mime,
      bytes: result.bytes,
    },
    call: { id: call.id, replayed: result.replayed },
    framing: result.framing,
    faces: result.faces,
    numbers: result.numbers,
  };
}
