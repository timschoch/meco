/**
 * Face Blur — hiding the faces a Crop is not allowed to show.
 *
 * Two halves, and the split is the point. `unknownFaces` decides *which* faces
 * are hidden and is one sentence of policy; `blurFaces` decides *how* and is all
 * of the pixels. Person matching changes the first and must not touch the
 * second.
 *
 * It runs on the finished frame rather than on the Source Image, after the
 * window has been cut and scaled. That is what makes "faces outside the solved
 * window are not counted" true by construction — a face the window cut out has
 * no rectangle in the frame to blur — and it is what keeps a Crop that asked for
 * no blur byte-identical outside the masks, since resampling a blurred Source
 * Image would smear the mask across its own edge.
 */
import sharp, { type Sharp } from "sharp";

import type { PixelSize } from "./crop-solver.js";
import type { DetectedFace, FaceBox } from "./faces.js";

/** A rectangle of an image, in that image's own pixels. */
export interface PixelRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * How strong the blur is, as a multiple of the face's width in the frame.
 *
 * Scaled rather than fixed, because a radius that erases a face 60 pixels wide
 * leaves one of 600 perfectly readable. A quarter of the width puts the Gaussian
 * radius well past the eye spacing at every size, which is the distance that has
 * to disappear.
 */
const SIGMA_PER_FACE_WIDTH = 0.25;

/** sharp refuses a Gaussian outside this range, so a tiny face is clamped up. */
const SIGMA_MIN = 0.3;
const SIGMA_MAX = 1000;

/**
 * How much of the ellipse's radius fades out, rather than ending at an edge.
 *
 * A hard-edged ellipse announces itself: the eye finds the outline before it
 * finds the blur. Fading the last sixth of the radius hides the mask and costs
 * nothing, because the fade is inside the ellipse and the face is already gone
 * by the time it starts.
 */
const FEATHER = 1 / 6;

/**
 * Which faces a Crop has to hide.
 *
 * Every one of them, because with no Person enrolled no face is known. That
 * single sentence is the whole of the rule, and it is a function of its own
 * because replacing it is exactly what Person matching does: a face matched to a
 * Person is known and stays sharp, whatever size it is. Nothing below here knows
 * how the choice was made — it is handed rectangles.
 */
export function unknownFaces(faces: readonly DetectedFace[]): readonly DetectedFace[] {
  return faces;
}

/**
 * Where each face lands in the finished frame, in output pixels.
 *
 * A face the window cut out yields nothing at all, and a face the window cut in
 * half yields the half that shows: the caller counts what comes back, so a face
 * that is not in the picture cannot be counted as blurred, and a face that is
 * partly in the picture is still hidden. Rounding is done on both edges before
 * the width is taken, so the rectangle never drifts a pixel wider than the face.
 */
export function facesInFrame(
  faces: readonly DetectedFace[],
  source: PixelSize,
  window: PixelRect,
  out: PixelSize,
): PixelRect[] {
  const scaleX = out.width / window.width;
  const scaleY = out.height / window.height;
  const rects: PixelRect[] = [];

  for (const face of faces) {
    const box: FaceBox = face.box;
    const left = Math.round((box.x * source.width - window.left) * scaleX);
    const top = Math.round((box.y * source.height - window.top) * scaleY);
    const right = Math.round(((box.x + box.width) * source.width - window.left) * scaleX);
    const bottom = Math.round(((box.y + box.height) * source.height - window.top) * scaleY);

    const clipped = {
      left: Math.max(0, left),
      top: Math.max(0, top),
      width: Math.min(out.width, right) - Math.max(0, left),
      height: Math.min(out.height, bottom) - Math.max(0, top),
    };
    if (clipped.width > 0 && clipped.height > 0) rects.push(clipped);
  }
  return rects;
}

/**
 * One byte of coverage per pixel: opaque inside the ellipse, clear outside it.
 *
 * The ellipse is the one inscribed in the rectangle, so it follows the shape of
 * the face box a detector reports rather than a square approximation of it.
 * Coverage is computed from the normalised radius, which is what lets one
 * expression cover both axes at once.
 */
function ellipseMask(width: number, height: number): Uint8Array {
  const mask = new Uint8Array(width * height);
  const rx = width / 2;
  const ry = height / 2;
  for (let y = 0; y < height; y++) {
    const dy = (y + 0.5 - ry) / ry;
    for (let x = 0; x < width; x++) {
      const dx = (x + 0.5 - rx) / rx;
      const r = Math.hypot(dx, dy);
      mask[y * width + x] =
        r >= 1 ? 0 : r <= 1 - FEATHER ? 255 : Math.round((255 * (1 - r)) / FEATHER);
    }
  }
  return mask;
}

/**
 * The frame with every named rectangle blurred behind an elliptical mask.
 *
 * The blend is done here, over the raw frame, rather than by handing sharp a
 * masked overlay to composite. Compositing would run the whole frame through an
 * alpha blend for the sake of a few rectangles, and the promise this function
 * makes is exactly that it does not: a pixel outside every rectangle is the byte
 * it was. That promise is what a caller reading the answer needs — a Crop that
 * hid four faces changed four ellipses and nothing else.
 */
export async function blurFaces(framed: Sharp, faces: readonly PixelRect[]): Promise<Sharp> {
  const { data, info } = await framed.raw().toBuffer({ resolveWithObject: true });
  const frame = { width: info.width, height: info.height, channels: info.channels };

  for (const face of faces) {
    const sigma = Math.min(SIGMA_MAX, Math.max(SIGMA_MIN, SIGMA_PER_FACE_WIDTH * face.width));
    const patch = await sharp(data, { raw: frame }).extract(face).blur(sigma).raw().toBuffer();
    const mask = ellipseMask(face.width, face.height);

    for (let y = 0; y < face.height; y++) {
      for (let x = 0; x < face.width; x++) {
        const coverage = mask[y * face.width + x]!;
        if (coverage === 0) continue;
        const alpha = coverage / 255;
        const into = ((face.top + y) * frame.width + face.left + x) * frame.channels;
        const from = (y * face.width + x) * frame.channels;
        for (let c = 0; c < frame.channels; c++) {
          data[into + c] = Math.round(data[into + c]! * (1 - alpha) + patch[from + c]! * alpha);
        }
      }
    }
  }

  return sharp(data, { raw: frame });
}
