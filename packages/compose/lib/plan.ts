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
 */
export function resolve(input: PlanInput): Resolved {
  const template = TEMPLATES.get(input.template);
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
  image?: SlotImage
): Promise<Layout> {
  const { template, look, placement } = resolved;
  const renderer = await sharedRenderer();
  const { node, css } = await fromJsx(
    template.render({
      fields: resolved.fields,
      look,
      placement,
      image: image ?? { width: placement.width, height: placement.height },
    })
  );
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

/** The Plan a laid-out Template stands for. */
export function planOf(resolved: Resolved, measured: Layout): Plan {
  const { slot, zones } = measured;
  const subjectArea = resolved.template.subjectArea?.[resolved.placement.id];
  return {
    imageSlot: { width: slot.width, height: slot.height },
    occlusion: zones.flatMap((zone) => clipToSlot(zone, slot) ?? []),
    ...(subjectArea ? { subjectArea } : {}),
  };
}

/**
 * What a Template will cover at one Placement with these Fields, before any
 * picture exists.
 *
 * Pure and cheap (0.6–3.6 ms, ADR-0009 decision 1): the gateway calls it to
 * fill the FramingRequest's `target`, `occlusion` and `subjectArea` from one
 * source, then calls `render` once frame has chosen the window.
 */
export async function plan(input: PlanInput): Promise<Plan> {
  const resolved = resolve(input);
  return planOf(resolved, await layout(resolved));
}
