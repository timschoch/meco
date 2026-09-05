import sharp from "sharp";
import { fromJsx } from "@takumi-rs/helpers/jsx";
import type { RgbaImage } from "@takumi-rs/helpers";
import type { Box } from "@meco/contracts";
import type { Look, Template } from "../template";
import { placement as placementById, type Placement } from "../placements";
import type { DecodedImage } from "./decoded-image";
import { ComposeError } from "./errors";
import { LOOKS } from "./looks/registry";
import { findMarked, IMAGE_SLOT_MARKER, type MeasuredBox } from "./marker";
import { lookImages, sharedRenderer } from "./renderer";
import { TEMPLATES } from "./templates/registry";

/** The formats compose encodes, the same set as the contracts `Target`. */
export type RenderFormat = "png" | "jpeg" | "webp";

const MIME: Record<RenderFormat, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

/** A photograph under a Template: JPEG at 90 unless the caller says otherwise. */
const DEFAULT_FORMAT: RenderFormat = "jpeg";
const DEFAULT_QUALITY = 90;

/**
 * How far the window's aspect may sit from the Image Slot's before compose
 * refuses, in **source** pixels. One pixel, because frame's window already has
 * the slot's shape up to the rounding that turned fractions into whole pixels.
 *
 * Source pixels and not slot pixels: a 1000 px tall source cannot express 9:16
 * exactly, so the honest question is whether the window frame chose is the
 * nearest whole-pixel box to the slot's shape — which is a question about the
 * source's own grid. Measuring in slot pixels would amplify that same rounding
 * by the scale factor and refuse windows that are already the best available.
 */
const ASPECT_TOLERANCE_PX = 1;

export interface RenderInput {
  readonly template: string;
  readonly placement: string;
  readonly brand: string;
  readonly fields: unknown;
  /** The redacted Source Image, at the resolution the Annotation describes. */
  readonly source: DecodedImage;
  /** What frame chose, in Source Image fractions. */
  readonly window: Box;
  readonly format?: RenderFormat;
  readonly quality?: number;
}

export interface RenderResult {
  readonly bytes: Uint8Array;
  readonly mime: string;
  /** What was rendered, in pixels. The Placement's size. */
  readonly width: number;
  readonly height: number;
}

interface Resolved {
  readonly template: Template;
  readonly look: Look;
  readonly placement: Placement;
  readonly fields: unknown;
}

function resolve(input: {
  template: string;
  placement: string;
  brand: string;
  fields: unknown;
}): Resolved {
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

/**
 * The Image Slot's box in canvas pixels, measured from a tree laid out with no
 * image bytes. Whole pixels, because the slot is what sharp resizes into.
 *
 * The descriptor handed to the Template carries the Placement's size, not the
 * slot's: the slot is what this call is measuring. That is sound only because a
 * Template may not size itself to the picture — the same rule that lets the
 * Plan be built before any picture exists (ADR-0009, decision 2).
 */
async function measureSlot(resolved: Resolved): Promise<MeasuredBox> {
  const { template, look, placement } = resolved;
  const renderer = await sharedRenderer();
  const { node, css } = await fromJsx(
    template.render({
      fields: resolved.fields,
      look,
      placement,
      image: { width: placement.width, height: placement.height },
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
    x: Math.round(slot.x),
    y: Math.round(slot.y),
    width: Math.round(slot.width),
    height: Math.round(slot.height),
  };
}

/** The window in whole source pixels, clamped to the image. */
function windowInPixels(window: Box, source: DecodedImage) {
  const left = Math.round(window.x * source.width);
  const top = Math.round(window.y * source.height);
  const width = Math.max(1, Math.round(window.width * source.width));
  const height = Math.max(1, Math.round(window.height * source.height));
  return {
    left: Math.min(left, source.width - width),
    top: Math.min(top, source.height - height),
    width: Math.min(width, source.width),
    height: Math.min(height, source.height),
  };
}

function refuseAspectMismatch(
  cut: { width: number; height: number },
  slot: MeasuredBox
): void {
  // The box with the slot's aspect that the window should have been, at the
  // window's own scale, on each axis in turn.
  const wantedWidth = (cut.height * slot.width) / slot.height;
  const wantedHeight = (cut.width * slot.height) / slot.width;
  const off = Math.max(
    Math.abs(cut.width - wantedWidth),
    Math.abs(cut.height - wantedHeight)
  );
  if (off > ASPECT_TOLERANCE_PX) {
    throw new ComposeError(
      "framing_mismatch",
      `The window is ${cut.width}x${cut.height} source pixels, ${off.toFixed(2)} px off the ${slot.width}x${slot.height} Image Slot's aspect; the tolerance is ${ASPECT_TOLERANCE_PX} px.`
    );
  }
}

/**
 * Cut the window out of the Source Image and scale it into the Image Slot.
 *
 * `fit: "fill"`, never `cover`: frame's window already has the slot's shape up
 * to one pixel, and `cover` would crop it a second time and undo the framing.
 * lanczos3 and sharp rather than takumi's own scaling, on the numbers in
 * ADR-0009 decision 4.
 */
async function fitToSlot(
  source: DecodedImage,
  window: Box,
  slot: MeasuredBox
): Promise<RgbaImage> {
  const cut = windowInPixels(window, source);
  refuseAspectMismatch(cut, slot);

  const data = await sharp(source.data, {
    raw: { width: source.width, height: source.height, channels: 3 },
  })
    .extract(cut)
    .resize(slot.width, slot.height, { fit: "fill", kernel: "lanczos3" })
    .ensureAlpha()
    .raw()
    .toBuffer();

  return { width: slot.width, height: slot.height, data };
}

/**
 * Draw a Template over a photograph and encode the result.
 *
 * compose is the last stage that touches pixels and the only one that encodes:
 * it resamples once, into the Image Slot, and hands back bytes. It fetches
 * nothing and stores nothing.
 */
export async function render(input: RenderInput): Promise<RenderResult> {
  const resolved = resolve(input);
  const { template, look, placement } = resolved;

  const slot = await measureSlot(resolved);
  const src = await fitToSlot(input.source, input.window, slot);

  const renderer = await sharedRenderer();
  const { node, css } = await fromJsx(
    template.render({
      fields: resolved.fields,
      look,
      placement,
      image: { src, width: slot.width, height: slot.height },
    })
  );

  const format = input.format ?? DEFAULT_FORMAT;
  const bytes = await renderer.render(node, {
    width: placement.width,
    height: placement.height,
    format,
    quality: input.quality ?? DEFAULT_QUALITY,
    images: lookImages(look),
    css,
  });

  return {
    bytes,
    mime: MIME[format],
    width: placement.width,
    height: placement.height,
  };
}
