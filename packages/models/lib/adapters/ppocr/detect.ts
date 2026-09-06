/**
 * Turning the DB text detector's probability map into text boxes.
 *
 * PP-OCR's detector answers one float per input pixel: how likely that pixel
 * is inside text. The boxes are not in the graph; they are the post-processing
 * PaddleOCR calls `DBPostProcess`, which this file ports for the one case a
 * Region needs — an axis-aligned rectangle. PaddleOCR takes the minimum-area
 * rotated rectangle of each contour and offsets its polygon; contracts' Box is
 * axis-aligned, so the rectangle here is the component's bounding box and the
 * offset grows its four sides. On a horizontal number the two agree; on a
 * slanted one this box is the box around the slant, which is what the Region
 * should be anyway.
 *
 * Nothing here touches sharp or ONNX Runtime: a typed array in, plain numbers
 * out, in fractions of the map. The map is the same shape as the detector's
 * input, and the input is the Decoded Image stretched to multiples of 32, so a
 * fraction of the map is a fraction of the photograph with no offset to undo.
 */

import type { Box } from "@meco/contracts";

/** One run of text as the detector saw it. */
export interface TextBox {
  /** In fractions of the map, after the unclip. */
  box: Box;
  /** The mean probability inside the box before the unclip. */
  score: number;
}

export interface DetectOptions {
  /** A pixel above this is text. PaddleOCR's `thresh`. */
  pixelThreshold: number;
  /** A component whose mean probability is under this is dropped. PaddleOCR's `box_thresh`. */
  boxThreshold: number;
  /** How far the box grows: `area * ratio / perimeter` on every side. PaddleOCR's `unclip_ratio`. */
  unclipRatio: number;
  /** A component with a side under this many pixels is noise. PaddleOCR's `min_size`. */
  minSidePx: number;
}

/**
 * Text boxes from one probability map of `width` by `height`.
 *
 * The binary map is dilated by one pixel up and left first (rapidocr's
 * `use_dilation`, a 2x2 kernel), so the glyphs of one number that the map
 * separates by a pixel gap still land in one component; without it a `24` can
 * come back as a `2` and a `4`. Components are found by 8-connected flood
 * fill on an explicit stack, because a recursive fill on a 1600 x 1000 map
 * overflows the call stack.
 */
export function textBoxes(
  prob: Float32Array,
  width: number,
  height: number,
  opts: DetectOptions
): TextBox[] {
  const size = width * height;
  const bin = new Uint8Array(size);
  for (let i = 0; i < size; i++) bin[i] = prob[i]! > opts.pixelThreshold ? 1 : 0;

  const mask = new Uint8Array(size);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      mask[i] =
        bin[i]! |
        (x > 0 ? bin[i - 1]! : 0) |
        (y > 0 ? bin[i - width]! : 0) |
        (x > 0 && y > 0 ? bin[i - width - 1]! : 0);
    }
  }

  const seen = new Uint8Array(size);
  const stack: number[] = [];
  const found: TextBox[] = [];

  for (let start = 0; start < size; start++) {
    if (!mask[start] || seen[start]) continue;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    seen[start] = 1;
    stack.push(start);
    while (stack.length > 0) {
      const i = stack.pop()!;
      const x = i % width;
      const y = (i - x) / width;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const n = ny * width + nx;
          if (mask[n] && !seen[n]) {
            seen[n] = 1;
            stack.push(n);
          }
        }
      }
    }

    const boxWidth = maxX - minX + 1;
    const boxHeight = maxY - minY + 1;
    if (Math.min(boxWidth, boxHeight) < opts.minSidePx) continue;

    let sum = 0;
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) sum += prob[y * width + x]!;
    }
    const score = sum / (boxWidth * boxHeight);
    if (score < opts.boxThreshold) continue;

    // DB's unclip: the polygon is offset outwards by area * ratio / perimeter.
    // The detector is trained to predict a shrunken text core, and this is
    // the inverse of that shrink; without it every crop cuts the digits' edges.
    const grow = (boxWidth * boxHeight * opts.unclipRatio) / (2 * (boxWidth + boxHeight));
    const left = Math.max(0, minX - grow);
    const top = Math.max(0, minY - grow);
    const right = Math.min(width, maxX + 1 + grow);
    const bottom = Math.min(height, maxY + 1 + grow);
    if (right - left <= opts.minSidePx + 2 || bottom - top <= opts.minSidePx + 2) continue;

    found.push({
      box: {
        x: left / width,
        y: top / height,
        width: (right - left) / width,
        height: (bottom - top) / height,
      },
      score,
    });
  }

  return found;
}
