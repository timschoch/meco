import { deepStrictEqual, ok } from "node:assert/strict";
import sharp from "sharp";
import type { MeasuredNode } from "@takumi-rs/core";
import type { RgbaImage } from "@takumi-rs/helpers";
import { Box, MAX_OCCLUSION_ZONES, type DecodedImage } from "@meco/contracts";
import type { Check } from "@meco/contracts/conformance";
import type { PlacementId } from "../placements";
import type { Template } from "../template";
import {
  layout,
  planOf,
  resolve,
  variantsOf,
  type Layout,
  type Plan,
} from "./plan";
import type { MeasuredBox } from "./measured-tree";
import { LOOKS } from "./looks/registry";
import { registerTemplates } from "./templates/register";
import { TEMPLATES } from "./templates/registry";

/** What the layout suite is handed. */
export interface LayoutFixtures {
  /**
   * Pictures the Plan must come out the same for. A flat placeholder and a real
   * photograph of another shape are the pair worth passing: between them they
   * vary content, aspect and resolution, which is everything a Template could
   * wrongly read off the bytes.
   */
  readonly images: readonly DecodedImage[];
  /**
   * The Templates to check. Compose's own when the caller names none; a
   * caller's own TSX when they do, which is what makes this entry point useful
   * outside compose. Registered the way the shipped ones are, so a Template
   * whose Brand has no Look is refused here rather than at the first check.
   */
  readonly templates?: readonly Template[];
}

/**
 * How far a measured box may sit outside the box holding it before the checks
 * call it an overflow, in canvas pixels.
 *
 * Not a tolerance for layout error: takumi lays out in floats, so a run that
 * exactly fills its line comes back a fraction of a pixel over. Anything a
 * reader would see is whole pixels wide.
 */
const SUBPIXEL = 0.5;

/** The picture as the render pass hands it to a Template: slot-sized RGBA. */
async function intoSlot(
  image: DecodedImage,
  slot: MeasuredBox
): Promise<RgbaImage> {
  const data = await sharp(image.data, {
    raw: { width: image.width, height: image.height, channels: 3 },
  })
    .resize(slot.width, slot.height, { fit: "fill" })
    .ensureAlpha()
    .raw()
    .toBuffer();
  return { width: slot.width, height: slot.height, data };
}

/** Every measured node with its own box, depth first. */
function nodes(measured: MeasuredNode): MeasuredNode[] {
  return [measured, ...measured.children.flatMap(nodes)];
}

/**
 * Every text run wider than the node it was laid out in.
 *
 * The inline axis only. A run's reported height is the font's own line box, not
 * the CSS one, so a Template that tightens `lineHeight` — `swisshutless-story`
 * sets 1.02, where Barlow's own is 1.2 — puts every run 10 px above a box 19 px
 * shorter than the glyphs, by design and on every line. Down the block axis a
 * flex column grows to fit its children, so the box a reader would call too
 * small is the one the text is too wide for, and that is what this measures.
 */
function overflowingRuns(measured: MeasuredNode): string[] {
  return nodes(measured).flatMap((node) =>
    node.runs
      .filter(
        (run) => run.x < -SUBPIXEL || run.x + run.width > node.width + SUBPIXEL
      )
      .map(
        (run) =>
          `"${run.text}" measures ${run.width} wide at x ${run.x} in a ${node.width} px box`
      )
  );
}

/**
 * Whether two Boxes share any area. Both are Image Slot fractions, so the
 * comparison needs no tolerance: an edge that exactly meets another overlaps by
 * nothing and is a design that touches, not one that covers.
 */
function overlap(a: MeasuredBox, b: MeasuredBox): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

function leavesSlot(zone: MeasuredBox, slot: MeasuredBox): boolean {
  return (
    zone.x < slot.x - SUBPIXEL ||
    zone.y < slot.y - SUBPIXEL ||
    zone.x + zone.width > slot.x + slot.width + SUBPIXEL ||
    zone.y + zone.height > slot.y + slot.height + SUBPIXEL
  );
}

/**
 * Whether the zone is cut by the Image Slot's edge: partly on it, partly off.
 *
 * The half of "leaves the slot" that is a design fault. A zone entirely off the
 * slot is the other half, and it is not one: it covers no part of the picture,
 * so the Plan drops it and the rule below says so.
 */
function crossesSlot(zone: MeasuredBox, slot: MeasuredBox): boolean {
  return overlap(zone, slot) && leavesSlot(zone, slot);
}

/** One layout pass per Template x Placement, however many Checks ask for it. */
function once<T>(make: () => Promise<T>): () => Promise<T> {
  let started: Promise<T> | undefined;
  return () => (started ??= make());
}

function checksFor(
  template: Template,
  placement: PlacementId,
  variant: string | undefined,
  fixtures: LayoutFixtures,
  registry: ReadonlyMap<string, Template>
): Check[] {
  const name = `${template.id} at ${placement}${variant === undefined ? "" : ` (${variant})`}`;
  // The Template's own `example`, so the suite runs the Fields its author says
  // are real and no test invents a second set to keep in step.
  const resolved = () =>
    resolve(
      {
        template: template.id,
        brand: template.brand,
        placement,
        fields: template.example,
      },
      registry
    );
  const measured = once(async () => layout(resolved(), undefined, variant));
  const planned = once(async (): Promise<Plan> =>
    planOf(resolved(), await measured(), variant)
  );

  return [
    {
      name: `${name} places exactly one Image Slot`,
      // `layout` refuses any other count before this check can look, so
      // reaching it at all is half the answer; the size is the other half.
      run: async () => {
        const { slot } = await measured();
        ok(
          slot.width > 0 && slot.height > 0,
          `The Image Slot measured ${slot.width}x${slot.height}.`
        );
      },
    },
    {
      name: `${name} keeps every Occlusion Zone inside the Image Slot`,
      run: async () => {
        for (const zone of (await planned()).occlusion) Box.parse(zone);
      },
    },
    {
      name: `${name} needs no Occlusion Zone clipped`,
      run: async () => {
        // Clipping is what the Plan does with a zone the slot's edge cuts, and
        // it is right to do it. But a Template whose own text block falls half
        // off its own Image Slot is a design that never renders whole, and a
        // clipped zone is where that first shows.
        const { slot, zones } = await measured();
        const escaped = zones.filter((zone) => crossesSlot(zone, slot));
        ok(
          escaped.length === 0,
          `${escaped.length} Occlusion Zone(s) leave the ${slot.width}x${slot.height} Image Slot and are clipped: ${JSON.stringify(escaped)}`
        );
      },
    },
    {
      name: `${name} drops any Occlusion Zone wholly outside the Image Slot`,
      run: async () => {
        // The other half of the rule above, and the one a Template may break
        // without being wrong: a zone off the slot covers no part of the
        // picture, so frame has nothing to keep the Subject clear of. The Plan
        // leaves it out rather than reporting a rectangle of no area, which no
        // FramingRequest would accept.
        const { slot, zones } = await measured();
        const covering = zones.filter((zone) => overlap(zone, slot));
        deepStrictEqual(
          (await planned()).occlusion.length,
          covering.length,
          `The Template measures ${zones.length} Occlusion Zone(s), ${covering.length} of them over the ${slot.width}x${slot.height} Image Slot, and the Plan reports ${(await planned()).occlusion.length}.`
        );
      },
    },
    {
      name: `${name} keeps every text run inside its own box`,
      run: async () => {
        const overflowing = overflowingRuns((await measured()).measured);
        ok(
          overflowing.length === 0,
          `Text overflows its box: ${overflowing.join("; ")}`
        );
      },
    },
    {
      name: `${name} plans the same whatever the image bytes are`,
      run: async () => {
        const { slot } = await measured();
        for (const image of fixtures.images) {
          const src = await intoSlot(image, slot);
          const withBytes = await layout(
            resolved(),
            { src, width: slot.width, height: slot.height },
            variant
          );
          deepStrictEqual(
            planOf(resolved(), withBytes, variant),
            await planned(),
            `The Plan changed once a ${image.width}x${image.height} picture sat in the Image Slot. A Template may not lay itself out around the bytes: the Plan is built before they exist.`
          );
        }
      },
    },
    {
      name: `${name} declares a valid Subject Area or none`,
      run: async () => {
        const { subjectArea } = await planned();
        if (subjectArea) Box.parse(subjectArea);
      },
    },
    {
      name: `${name} keeps the Subject Area clear of every Occlusion Zone`,
      run: async () => {
        // Both are what the gateway puts in one FramingRequest: "put the
        // Subject here" and "keep it out from under this". A Template that
        // declares them overlapping is asking frame for a crop that cannot
        // exist, and frame would satisfy neither. It is design intent against
        // measured layout, so only the Template's own numbers can be wrong.
        const { subjectArea, occlusion } = await planned();
        if (!subjectArea) return;
        const covered = occlusion.filter((zone) => overlap(zone, subjectArea));
        ok(
          covered.length === 0,
          `The Subject Area ${JSON.stringify(subjectArea)} lies under ${covered.length} Occlusion Zone(s): ${JSON.stringify(covered)}.`
        );
      },
    },
    {
      name: `${name} declares no more Occlusion Zones than a FramingRequest holds`,
      run: async () => {
        const { occlusion } = await planned();
        ok(
          occlusion.length <= MAX_OCCLUSION_ZONES,
          `${occlusion.length} Occlusion Zones; a FramingRequest holds ${MAX_OCCLUSION_ZONES}.`
        );
      },
    },
  ];
}

/**
 * The layout suite: what every Template must be true of at every Placement it
 * declares, under every Variant it offers, run with the Template's own
 * `example` Fields.
 *
 * An entry point of its own, like `@meco/contracts/conformance`. Two of the
 * rules read takumi's measured tree and one needs a layout pass taken *with*
 * image bytes; the Plan carries neither, and should not. The Checks are the
 * same shape as contracts', so a Template author outside this package runs
 * them from their own Vitest file.
 */
export function layoutConformance(fixtures: LayoutFixtures): Check[] {
  const registry = fixtures.templates
    ? registerTemplates(fixtures.templates, LOOKS)
    : TEMPLATES;
  return [...registry.values()].flatMap((template) =>
    template.placements.flatMap((placement) =>
      variantsOf(template).flatMap((variant) =>
        checksFor(template, placement, variant, fixtures, registry)
      )
    )
  );
}
