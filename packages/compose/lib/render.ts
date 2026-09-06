import { createElement } from "react";
import sharp from "sharp";
import { Bitmap, fromJsx } from "@takumi-rs/helpers/jsx";
import type { RgbaImage } from "@takumi-rs/helpers";
import type { Node } from "@takumi-rs/core";
import type { Box, DecodedImage, Size } from "@meco/contracts";
import { ComposeError } from "./errors";
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

function refuseAspectMismatch(windowPx: Size, slot: Size): void {
  // The box with the slot's aspect the window should have been, holding each
  // axis fixed in turn.
  const wantedWidth = (windowPx.height * slot.width) / slot.height;
  const wantedHeight = (windowPx.width * slot.height) / slot.width;
  // The smaller of the two, because they are one deviation seen at two scales,
  // not two independent errors: the height figure is the width figure times the
  // slot's aspect ratio, so `Math.max` would always read the long axis and make
  // the real tolerance 1/1.78 of a pixel for a story. The smaller number is the
  // question worth asking — how far is this window from a correct one, moving
  // whichever axis is cheaper to move.
  const off = Math.min(
    Math.abs(windowPx.width - wantedWidth),
    Math.abs(windowPx.height - wantedHeight)
  );
  if (off > ASPECT_TOLERANCE_PX) {
    throw new ComposeError(
      "framing_mismatch",
      `The window is ${windowPx.width}x${windowPx.height} source pixels, ${off.toFixed(2)} px off the ${slot.width}x${slot.height} Image Slot's aspect; the tolerance is ${ASPECT_TOLERANCE_PX} px.`
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
  slot: Size
): Promise<RgbaImage> {
  const windowPx = windowInPixels(window, source);
  refuseAspectMismatch(windowPx, slot);

  const data = await sharp(source.data, {
    raw: { width: source.width, height: source.height, channels: 3 },
  })
    .extract(windowPx)
    .resize(slot.width, slot.height, { fit: "fill", kernel: "lanczos3" })
    .ensureAlpha()
    .raw()
    .toBuffer();

  return { width: slot.width, height: slot.height, data };
}

/** What both callers hand takumi: a laid-out tree and the canvas to draw it on. */
interface Drawing {
  readonly node: Node;
  readonly css: string[];
  readonly canvas: Size;
  /** The table an `<img src>` resolves against. Empty for a picture on its own. */
  readonly images: { src: string; data: Uint8Array }[];
}

/**
 * Draw a tree on a canvas and encode it.
 *
 * The one encoder in compose, so a bare Crop and a Render cannot drift into two
 * JPEGs of the same picture at two qualities. Not sharp: takumi already holds
 * the drawn canvas, and handing the pixels back to sharp to encode would be a
 * second library's idea of quality 90.
 */
async function encode(
  drawing: Drawing,
  format: RenderFormat | undefined,
  quality: number | undefined
): Promise<RenderResult> {
  const renderer = await sharedRenderer();
  const chosen = format ?? DEFAULT_FORMAT;
  const bytes = await renderer.render(drawing.node, {
    width: drawing.canvas.width,
    height: drawing.canvas.height,
    format: chosen,
    quality: quality ?? DEFAULT_QUALITY,
    images: drawing.images,
    css: drawing.css,
  });
  return { bytes, mime: MIME[chosen] };
}

/** A bare Crop: the window at a size, with no Template over it. */
export interface CutInput {
  /** The redacted Source Image, at the resolution the Annotation describes. */
  readonly source: DecodedImage;
  /** What frame chose, in Source Image fractions. */
  readonly window: Box;
  /** The output, in whole pixels. The Image Slot's part, with no Template. */
  readonly target: Size;
  readonly format?: RenderFormat;
  readonly quality?: number;
}

/**
 * Cut the window out of the Source Image and encode it at the target size.
 *
 * The bare Crop route: the same extract, the same lanczos3 resize and the same
 * encoder a Render goes through, with nothing drawn over the picture. compose
 * owns pixels, so no caller has to reach for sharp to skip a Template
 * (gateway design, #88).
 */
export async function cut(input: CutInput): Promise<RenderResult> {
  const src = await fitToSlot(input.source, input.window, input.target);
  // The picture is already the canvas's size, so takumi draws it 1:1 and the
  // bytes are the same pixels a Template's Image Slot would have held.
  const { node, css } = await fromJsx(
    createElement(Bitmap, { ...src, style: { width: "100%", height: "100%" } })
  );

  return encode(
    { node, css, canvas: input.target, images: [] },
    input.format,
    input.quality
  );
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

  const { node, css } = await fromJsx(
    template.render({
      fields: resolved.fields,
      look,
      placement,
      image: { src, width: slot.width, height: slot.height },
    })
  );

  return encode(
    { node, css, canvas: placement, images: lookImages(look) },
    input.format,
    input.quality
  );
}
