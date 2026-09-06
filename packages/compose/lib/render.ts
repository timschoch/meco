import sharp from "sharp";
import { fromJsx } from "@takumi-rs/helpers/jsx";
import type { RgbaImage } from "@takumi-rs/helpers";
import type { Box, DecodedImage } from "@meco/contracts";
import { ComposeError } from "./errors";
import type { MeasuredBox } from "./measured-tree";
import { layout, resolve, type PlanInput } from "./plan";
import { lookImages, sharedRenderer } from "./renderer";

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

/** A Plan's four inputs plus the picture and the window frame chose. */
export interface RenderInput extends PlanInput {
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
  // The box with the slot's aspect the window should have been, holding each
  // axis fixed in turn.
  const wantedWidth = (cut.height * slot.width) / slot.height;
  const wantedHeight = (cut.width * slot.height) / slot.width;
  // The smaller of the two, because they are one deviation seen at two scales,
  // not two independent errors: the height figure is the width figure times the
  // slot's aspect ratio, so `Math.max` would always read the long axis and make
  // the real tolerance 1/1.78 of a pixel for a story. The smaller number is the
  // question worth asking — how far is this window from a correct one, moving
  // whichever axis is cheaper to move.
  const off = Math.min(
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

  // Re-planned rather than carried over from the caller's own `plan` call:
  // the layout costs 0.6–3.6 ms (ADR-0009 decision 1), and a handle passed
  // between two calls would be a Plan that no longer matches these Fields.
  const { slot } = await layout(resolved);
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

  return { bytes, mime: MIME[format] };
}
