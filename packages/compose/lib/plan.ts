import type { MeasuredNode, Node } from "@takumi-rs/core";
import { fromJsx } from "@takumi-rs/helpers/jsx";
import type { Box, Size } from "@meco/contracts";
import type { Look, SlotImage, Template } from "../template";
import { placement as placementById, type Placement } from "../placements";
import { ComposeError } from "./errors";
import { LOOKS } from "./looks/registry";
import {
  findMarked,
  IMAGE_SLOT_MARKER,
  OCCLUDES_MARKER,
  type MeasuredBox,
  withoutUnmeasured,
} from "./measured-tree";
import { sharedRenderer } from "./renderer";
import { TEMPLATES } from "./templates/registry";

/** What a caller asks a Plan for. No picture: a Plan may not depend on one. */
export interface PlanInput {
  readonly template: string;
  readonly placement: string;
  readonly brand: string;
  readonly fields: unknown;
}

/**
 * What a Template will do at one Placement with these Fields.
 *
 * `imageSlot` is pixels, because it is what the picture is resampled into and
 * what the gateway hands frame as `target`. Everything else is Image Slot
 * fractions, so frame never learns the Template's size.
 */
export interface Plan {
  readonly imageSlot: Size;
  readonly occlusion: readonly Box[];
  readonly subjectArea?: Box;
  /** The Variant this Plan measures. Absent for a Template that lays out one way. */
  readonly variant?: string;
}

/**
 * The Variants a Template lays out, as `layout` takes them: the declared
 * names in the Template's order, or one `undefined` for a Template that
 * declares none, so every caller walks one list.
 */
export const variantsOf = (
  template: Template
): readonly (string | undefined)[] =>
  template.variants?.map((variant) => variant.name) ?? [undefined];

/**
 * The Variant a `render` draws: the one asked for, or the Template's first.
 *
 * A name the Template does not declare is refused, and so is any name on a
 * Template that declares none — frame chose it off a Plan this Template did
 * not make, so drawing the Template's one layout under that name would file a
 * Render whose Framing lies about it.
 */
export function resolveVariant(
  template: Template,
  asked: string | undefined
): string | undefined {
  const names = variantsOf(template);
  if (asked === undefined) return names[0];
  if (names.includes(asked)) return asked;
  throw new ComposeError(
    "unknown_variant",
    template.variants === undefined
      ? `Template "${template.id}" lays out one way and has no Variant "${asked}".`
      : `Template "${template.id}" has no Variant "${asked}"; it offers ${names.join(", ")}.`
  );
}

/** The four inputs after the registries and the Fields schema have had them. */
export interface Resolved {
  readonly template: Template;
  readonly look: Look;
  readonly placement: Placement;
  readonly fields: unknown;
}

/**
 * The registry lookups and the Fields parse, in the order a caller would want
 * to hear about them: what does not exist first, then what does not fit.
 *
 * The registry is a parameter so the layout suite can resolve a Template a
 * caller registered rather than one compose ships. Every other caller takes the
 * default, which is the only registry `plan` and `render` know.
 */
export function resolve(
  input: PlanInput,
  templates: ReadonlyMap<string, Template> = TEMPLATES
): Resolved {
  const template = templates.get(input.template);
  if (!template) {
    throw new ComposeError(
      "unknown_template",
      `No Template with id "${input.template}".`
    );
  }

  const look = LOOKS.get(input.brand);
  if (!look) {
    throw new ComposeError(
      "unknown_brand",
      `No Look for Brand "${input.brand}".`
    );
  }

  const placement = placementById(input.placement);
  if (!placement || !template.placements.includes(placement.id)) {
    throw new ComposeError(
      "placement_not_supported",
      `Template "${template.id}" does not support Placement "${input.placement}".`
    );
  }

  const parsed = template.fields.safeParse(input.fields);
  if (!parsed.success) {
    throw new ComposeError(
      "invalid_fields",
      `Fields do not match what "${template.id}" asks for.`,
      parsed.error.issues
    );
  }

  return { template, look, placement, fields: parsed.data };
}

/** One pass of takumi's layout, with the Marker boxes already picked out. */
export interface Layout {
  readonly source: Node;
  readonly measured: MeasuredNode;
  /** The Image Slot in whole canvas pixels: what sharp resizes into. */
  readonly slot: MeasuredBox;
  /** Every `Occludes` box in canvas pixels, as measured — before any clipping. */
  readonly zones: readonly MeasuredBox[];
}

const round = (box: MeasuredBox): MeasuredBox => ({
  x: Math.round(box.x),
  y: Math.round(box.y),
  width: Math.round(box.width),
  height: Math.round(box.height),
});

/**
 * Lay the Template out and read its Marker boxes.
 *
 * The descriptor handed to the Template carries the Placement's size unless the
 * caller knows better, because the slot is what this call is measuring. That is
 * sound only because a Template may not size itself to the picture — the same
 * rule that lets the Plan be built before any picture exists (ADR-0009,
 * decision 2), and the one the layout Conformance Checks hold it to.
 */
export async function layout(
  resolved: Resolved,
  image?: SlotImage,
  variant?: string
): Promise<Layout> {
  const { template, look, placement } = resolved;
  const renderer = await sharedRenderer();
  const { node: drawn, css } = await fromJsx(
    template.render({
      fields: resolved.fields,
      look,
      placement,
      image: image ?? { width: placement.width, height: placement.height },
      ...(variant === undefined ? {} : { variant }),
    })
  );
  // What takumi will measure and nothing it will not, so the walk below can
  // pair the two trees node for node (#244).
  const node = withoutUnmeasured(drawn);
  const measured = await renderer.measure(node, {
    width: placement.width,
    height: placement.height,
    css,
  });

  const slots = findMarked(node, measured, IMAGE_SLOT_MARKER);
  const slot = slots[0];
  if (slots.length !== 1 || slot === undefined) {
    throw new Error(
      `Template "${template.id}" placed ${slots.length} ImageSlots; exactly one is required.`
    );
  }

  return {
    source: node,
    measured,
    slot: round(slot),
    zones: findMarked(node, measured, OCCLUDES_MARKER),
  };
}

/**
 * A measured box in Image Slot fractions, clipped to the slot; `undefined` when
 * it lies wholly outside.
 *
 * Dropped rather than reported as a zero-area rectangle: a zone off the slot
 * covers no part of the picture, so it is nothing frame has to keep the Subject
 * clear of, and a degenerate Box would fail the contracts schema on the way
 * into the FramingRequest.
 */
function clipToSlot(zone: MeasuredBox, slot: MeasuredBox): Box | undefined {
  const x = Math.max(0, (zone.x - slot.x) / slot.width);
  const y = Math.max(0, (zone.y - slot.y) / slot.height);
  const right = Math.min(1, (zone.x + zone.width - slot.x) / slot.width);
  const bottom = Math.min(1, (zone.y + zone.height - slot.y) / slot.height);
  if (right <= x || bottom <= y) return undefined;
  return { x, y, width: right - x, height: bottom - y };
}

/**
 * The Plan a laid-out Template stands for. The Subject Area is the Variant's
 * own for this Placement, falling back to the Template's.
 */
export function planOf(
  resolved: Resolved,
  measured: Layout,
  variant?: string
): Plan {
  const { slot, zones } = measured;
  const { template, placement } = resolved;
  const subjectArea =
    template.variants?.find((one) => one.name === variant)?.subjectArea?.[
      placement.id
    ] ?? template.subjectArea?.[placement.id];
  return {
    imageSlot: { width: slot.width, height: slot.height },
    occlusion: zones.flatMap((zone) => clipToSlot(zone, slot) ?? []),
    ...(subjectArea ? { subjectArea } : {}),
    ...(variant === undefined ? {} : { variant }),
  };
}

/**
 * What a Template will cover at one Placement with these Fields, before any
 * picture exists: one Plan per Variant, in the Template's order of
 * preference, and one unnamed Plan for a Template that lays out one way.
 *
 * Pure and cheap (0.6–3.6 ms per layout, ADR-0009 decision 1): the gateway
 * calls it to fill one FramingRequest per Plan from one source, lets frame
 * choose among them, then calls `render` with the Variant frame named.
 *
 * The registry is a parameter, as `resolve`'s is, so a caller that brought its
 * own Templates plans from the same registry it will render from (#65).
 */
export async function plan(
  input: PlanInput,
  templates: ReadonlyMap<string, Template> = TEMPLATES
): Promise<readonly Plan[]> {
  const resolved = resolve(input, templates);
  return Promise.all(
    variantsOf(resolved.template).map(async (variant) =>
      planOf(resolved, await layout(resolved, undefined, variant), variant)
    )
  );
}
