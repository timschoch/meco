import sharp from "sharp";
import type { DecodedImage } from "@meco/contracts";
import type { PixelRectangle } from "./pixel-rectangle";

/** The mask fades over the outer sixth of its radius. */
const FEATHER = 1 / 6;

/** Gaussian sigma per pixel of face width. ADR-0008: on the plateau at 0.25. */
const SIGMA_PER_PIXEL = 0.25;

/** sharp's legal range for `blur`. */
const SIGMA_MIN = 0.3;
const SIGMA_MAX = 1000;

/**
 * The blur strength for a face this many Source Image pixels wide.
 *
 * Scaled and not fixed: mean |Laplacian| inside the ellipse falls to 8.3 % of
 * the untouched image at 319 px and 5.8 % at 101 px, and no single sigma
 * serves both. The curve is flat from 0.25 on, so a detector box a little
 * tight or a little loose does not move the result (ADR-0008).
 */
const maskSigma = (widthInPixels: number): number =>
  Math.min(SIGMA_MAX, Math.max(SIGMA_MIN, SIGMA_PER_PIXEL * widthInPixels));

/**
 * How much of the mask covers a point at this fraction of the ellipse's own
 * radius: opaque to the feather, nothing at the edge and beyond, linear
 * between.
 *
 * Zero outside is the byte-equality promise in one line — the blend never
 * touches a pixel this answers 0 for, so a photograph that hid four faces
 * changed four ellipses and nothing else.
 */
const maskCoverage = (radius: number): number => {
  if (radius >= 1) return 0;
  if (radius <= 1 - FEATHER) return 1;
  return (1 - radius) / FEATHER;
};

/** One mask: the face's own ellipse, and the part of it that may be written. */
export interface Mask {
  readonly ellipse: PixelRectangle;
  readonly patch: PixelRectangle;
}

const asBuffer = (data: Uint8Array): Buffer =>
  Buffer.from(data.buffer, data.byteOffset, data.byteLength);

/**
 * Paints one Redaction Mask into `target`, reading its pixels from `source`.
 *
 * The blend is hand-written over the raw buffer, with sharp used for
 * `extract`, `blur` and the raw round trip only. `sharp.composite` with an SVG
 * ellipse was measured at 179.5 ms against 6.4 and re-blends every pixel in
 * the image by construction, which is the promise above gone (ADR-0008).
 *
 * Every mask reads from the untouched `source`, so two overlapping faces
 * cannot blur each other twice and the order they arrive in does not matter.
 *
 * **`ellipse` is the face and `patch` is what may be written.** They are the
 * same rectangle for every Region contracts accepts. They part only where the
 * schema has been bypassed, and then the ellipse keeps its centre, its radii
 * and its blur strength, and the boundary decides how much of it lands. They
 * arrive named rather than as two rectangles in a row, so the two cannot be
 * swapped by a caller that reads the signature too quickly.
 */
export const paintMask = async (
  source: DecodedImage,
  target: Uint8Array,
  { ellipse, patch }: Mask
): Promise<void> => {
  const blurred = await sharp(asBuffer(source.data), {
    raw: {
      width: source.width,
      height: source.height,
      channels: source.channels,
    },
  })
    .extract(patch)
    .blur(maskSigma(ellipse.width))
    .raw()
    .toBuffer();

  const radiusX = ellipse.width / 2;
  const radiusY = ellipse.height / 2;
  const centreX = ellipse.left + radiusX;
  const centreY = ellipse.top + radiusY;

  for (let row = 0; row < patch.height; row += 1) {
    const y = patch.top + row;
    const offsetY = (y + 0.5 - centreY) / radiusY;

    for (let column = 0; column < patch.width; column += 1) {
      const x = patch.left + column;
      const offsetX = (x + 0.5 - centreX) / radiusX;
      const coverage = maskCoverage(Math.hypot(offsetX, offsetY));
      if (coverage === 0) continue;

      const into = (y * source.width + x) * 3;
      const from = (row * patch.width + column) * 3;
      for (let channel = 0; channel < 3; channel += 1) {
        const was = source.data[into + channel]!;
        target[into + channel] = Math.round(
          was + (blurred[from + channel]! - was) * coverage
        );
      }
    }
  }
};
