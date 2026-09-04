/**
 * Face Blur — hiding the faces a Crop is not allowed to show. See CONTEXT.md.
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
import type { Match } from "./people.js";

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
 * Which faces a Crop has to hide: every face that is not a Match.
 *
 * That single sentence is the whole of the rule, and it is a function of its own
 * so that the rule and the pixels can be wrong separately. Nothing below here
 * knows how the choice was made — it is handed rectangles.
 *
 * `matches` runs parallel to `faces`, an entry per face in the same order, and a
 * missing entry means unknown. So a request that did no matching at all passes
 * nothing and every face is hidden, which is the same answer as before Persons
 * existed and the right one: a face meco cannot name is a face it must not show.
 *
 * A Match is spared whatever its score above the threshold and whatever its
 * size. That is the point of matching rather than a heuristic — the person who
 * agreed to be in the picture stays in it.
 */
export function unknownFaces(
  faces: readonly DetectedFace[],
  matches: readonly (Match | null)[] = [],
): readonly DetectedFace[] {
  return faces.filter((_, i) => !matches[i]);
}

/**
 * Where each face lands in the finished frame, in output pixels.
 *
 * A face the window cut out yields nothing at all — the caller counts what comes
 * back, so a face that is not in the picture cannot be counted as blurred.
 *
 * A face the window cut in half yields the *whole* face, rectangle hanging off
 * the edge of the frame and all. That is deliberate and it is why the clipping
 * is not done here: the mask has to be the ellipse of the real face, and only
 * then be cut off by the frame. Inscribing an ellipse in the visible sliver
 * instead would draw a different, smaller ellipse in the wrong place and leave
 * the face sharp along the frame edge — which on a half-cropped face is exactly
 * the part still showing. `blurFaces` paints only what is in the picture.
 *
 * Rounding is done on both edges before the width is taken, so the rectangle
 * never drifts a pixel wider than the face.
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

    // Any overlap at all is a face in the picture. A face showing one pixel is
    // still a face showing, so the test is intersection and not containment.
    const shows = right > 0 && left < out.width && bottom > 0 && top < out.height;
    if (shows) rects.push({ left, top, width: right - left, height: bottom - top });
  }
  return rects;
}

/** The part of a rectangle that is inside a frame of `size`, empty if none is. */
function clipToFrame(rect: PixelRect, size: PixelSize): PixelRect {
  const left = Math.max(0, rect.left);
  const top = Math.max(0, rect.top);
  return {
    left,
    top,
    width: Math.min(size.width, rect.left + rect.width) - left,
    height: Math.min(size.height, rect.top + rect.height) - top,
  };
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
    // Both the radius and the ellipse come from the whole face, even when the
    // frame holds only part of it: a face cut in half is half a face at full
    // size, not a small whole one, and blurring it as if it were the latter
    // would under-blur it and miss the part against the edge.
    const sigma = Math.min(SIGMA_MAX, Math.max(SIGMA_MIN, SIGMA_PER_FACE_WIDTH * face.width));
    const mask = ellipseMask(face.width, face.height);

    const shown = clipToFrame(face, frame);
    if (shown.width <= 0 || shown.height <= 0) continue;
    const patch = await sharp(data, { raw: frame }).extract(shown).blur(sigma).raw().toBuffer();

    // Where the visible part starts inside the face's own mask.
    const offsetX = shown.left - face.left;
    const offsetY = shown.top - face.top;

    for (let y = 0; y < shown.height; y++) {
      for (let x = 0; x < shown.width; x++) {
        const coverage = mask[(offsetY + y) * face.width + offsetX + x]!;
        if (coverage === 0) continue;
        const alpha = coverage / 255;
        const into = ((shown.top + y) * frame.width + shown.left + x) * frame.channels;
        const from = (y * shown.width + x) * frame.channels;
        for (let c = 0; c < frame.channels; c++) {
          data[into + c] = Math.round(data[into + c]! * (1 - alpha) + patch[from + c]! * alpha);
        }
      }
    }
  }

  return sharp(data, { raw: frame });
}
