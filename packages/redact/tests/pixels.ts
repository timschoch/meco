// Pixel measurements for the mask checks. Private to tests/ by the boundary
// rules.
//
// The rectangle rule, the ellipse and its feather are restated here from
// `docs/specs/redact.md` rather than imported from `lib/`. A check that read
// the module's own geometry would compare the code against itself; this one
// compares it against the sentence it was built from, so an implementation
// that drifts a pixel has nothing to agree with.
import type { Box, DecodedImage } from "@meco/contracts";

/** A rectangle in Source Image pixels. `left`/`top`/`width`/`height`, per ADR-0002. */
export interface Rectangle {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The Region's box in Source Image pixels.
 *
 * Both edges are rounded before the width is taken, so the rectangle never
 * drifts a pixel wider than the Region. On this fixture the rule bites twice:
 * `round(width x 1280)` is 101 for `face-1` against 100 here, and
 * `round(height x 1600)` is 133 for `face-2` against 134.
 */
export const rectangleOf = (
  box: Box,
  image: Pick<DecodedImage, "width" | "height">
): Rectangle => {
  const left = Math.round(box.x * image.width);
  const top = Math.round(box.y * image.height);
  return {
    left,
    top,
    width: Math.round((box.x + box.width) * image.width) - left,
    height: Math.round((box.y + box.height) * image.height) - top,
  };
};

/**
 * The part of `rect` that lies on the image, or `undefined` when none of it
 * does.
 *
 * Restated here rather than imported, like the rectangle rule above. This is
 * the sentence the module is built from: the write is clipped and the ellipse
 * is not.
 */
export const clipOf = (
  rect: Rectangle,
  image: Pick<DecodedImage, "width" | "height">
): Rectangle | undefined => {
  const left = Math.min(image.width, Math.max(0, rect.left));
  const top = Math.min(image.height, Math.max(0, rect.top));
  const width =
    Math.min(image.width, Math.max(0, rect.left + rect.width)) - left;
  const height =
    Math.min(image.height, Math.max(0, rect.top + rect.height)) - top;

  return width > 0 && height > 0 ? { left, top, width, height } : undefined;
};

/**
 * Where a pixel centre falls in the ellipse inscribed in `rect`, as a fraction
 * of the ellipse's own radius. 1 is the ellipse's edge; above 1 is outside it.
 */
export const radiusAt = (rect: Rectangle, x: number, y: number): number => {
  const rx = rect.width / 2;
  const ry = rect.height / 2;
  return Math.hypot(
    (x + 0.5 - (rect.left + rx)) / rx,
    (y + 0.5 - (rect.top + ry)) / ry
  );
};

/** The mask fades over the outer sixth of its radius, so the opaque core ends here. */
export const CORE_RADIUS = 5 / 6;

/** A predicate over pixel coordinates. */
export type Where = (x: number, y: number) => boolean;

/** Inside the opaque core of the ellipse inscribed in `rect`. */
export const insideCore =
  (rect: Rectangle): Where =>
  (x, y) =>
    radiusAt(rect, x, y) <= CORE_RADIUS;

/** Between two fractions of the radius of the ellipse inscribed in `rect`. */
export const inBand =
  (rect: Rectangle, from: number, to: number): Where =>
  (x, y) => {
    const radius = radiusAt(rect, x, y);
    return radius >= from && radius < to;
  };

/** Outside every one of these ellipses. */
export const outsideEvery =
  (rects: readonly Rectangle[]): Where =>
  (x, y) =>
    rects.every((rect) => radiusAt(rect, x, y) >= 1);

/** The whole image, as a rectangle to sweep. */
export const boundsOf = (
  image: Pick<DecodedImage, "width" | "height">
): Rectangle => ({ left: 0, top: 0, width: image.width, height: image.height });

/**
 * `rect` grown by `margin` pixels on every side, clipped to the image.
 *
 * A sweep that stops at the rectangle cannot see a mask that ran past it, so
 * the check for "never a pixel wider than the Region" has to look outside the
 * rectangle it is defending.
 */
export const grownBy = (
  rect: Rectangle,
  margin: number,
  image: Pick<DecodedImage, "width" | "height">
): Rectangle => {
  const left = Math.max(0, rect.left - margin);
  const top = Math.max(0, rect.top - margin);
  return {
    left,
    top,
    width: Math.min(image.width, rect.left + rect.width + margin) - left,
    height: Math.min(image.height, rect.top + rect.height + margin) - top,
  };
};

const sweep = (
  over: Rectangle,
  visit: (x: number, y: number) => void
): void => {
  for (let y = over.top; y < over.top + over.height; y += 1) {
    for (let x = over.left; x < over.left + over.width; x += 1) visit(x, y);
  }
};

/** How many pixels of `over` satisfy `where`. */
export const countPixels = (over: Rectangle, where: Where): number => {
  let total = 0;
  sweep(over, (x, y) => {
    if (where(x, y)) total += 1;
  });
  return total;
};

/** How many of the three channels differ, summed over the pixels `where` covers. */
export const changedChannels = (
  before: DecodedImage,
  after: DecodedImage,
  over: Rectangle,
  where: Where
): number => {
  let changed = 0;
  sweep(over, (x, y) => {
    if (!where(x, y)) return;
    const at = (y * before.width + x) * 3;
    for (let channel = 0; channel < 3; channel += 1) {
      if (before.data[at + channel] !== after.data[at + channel]) changed += 1;
    }
  });
  return changed;
};

/** Mean absolute change per channel over the pixels of `over` that `where` covers. */
export const meanChange = (
  before: DecodedImage,
  after: DecodedImage,
  over: Rectangle,
  where: Where
): number => {
  let total = 0;
  let counted = 0;
  sweep(over, (x, y) => {
    if (!where(x, y)) return;
    const at = (y * before.width + x) * 3;
    for (let channel = 0; channel < 3; channel += 1) {
      total += Math.abs(before.data[at + channel]! - after.data[at + channel]!);
    }
    counted += 3;
  });
  if (counted === 0) throw new Error("the band covered no pixel");
  return total / counted;
};

/** The smallest rectangle holding every pixel of `over` that `after` changed. */
export const changedBounds = (
  before: DecodedImage,
  after: DecodedImage,
  over: Rectangle
): Rectangle | undefined => {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  sweep(over, (x, y) => {
    const at = (y * before.width + x) * 3;
    const same =
      before.data[at] === after.data[at] &&
      before.data[at + 1] === after.data[at + 1] &&
      before.data[at + 2] === after.data[at + 2];
    if (same) return;
    left = Math.min(left, x);
    top = Math.min(top, y);
    right = Math.max(right, x + 1);
    bottom = Math.max(bottom, y + 1);
  });
  return left === Infinity
    ? undefined
    : { left, top, width: right - left, height: bottom - top };
};

const luma = (image: DecodedImage, x: number, y: number): number => {
  const at = (y * image.width + x) * 3;
  return (
    0.299 * image.data[at]! +
    0.587 * image.data[at + 1]! +
    0.114 * image.data[at + 2]!
  );
};

/** Where along `row` the red channel first reaches `level`, to sub-pixel accuracy. */
const crossing = (image: DecodedImage, row: number, level: number): number => {
  const at = (x: number): number => image.data[(row * image.width + x) * 3]!;
  for (let x = 1; x < image.width; x += 1) {
    if (at(x - 1) < level && at(x) >= level) {
      return x - 1 + (level - at(x - 1)) / (at(x) - at(x - 1));
    }
  }
  throw new Error(`no crossing of ${level} on row ${row}`);
};

/**
 * The 25 % to 75 % rise of a step edge along `row`, in pixels.
 *
 * The sigma of the Gaussian that produced it, times 1.349. This is how a check
 * reads a blur strength back out of the pixels: detail measures stop
 * discriminating once ADR-0008's plateau is reached, but a step edge's rise
 * stays proportional to the sigma at any strength.
 */
export const riseAcross = (image: DecodedImage, row: number): number =>
  crossing(image, row, 0.75 * 255) - crossing(image, row, 0.25 * 255);

/** A rise of this many pixels was made by a Gaussian of about this sigma. */
export const sigmaBehind = (rise: number): number => rise / 1.349;

/**
 * Mean |Laplacian| over the pixels of `over` that `where` covers together with
 * all four of their neighbours. Detail, in one number: a four-neighbour
 * Laplacian answers near zero on a smooth patch and large on an eye or a
 * hairline. Neighbours have to pass the same predicate so the sharp pixels
 * just outside the core cannot be counted as detail inside it.
 */
export const meanLaplacian = (
  image: DecodedImage,
  over: Rectangle,
  where: Where
): number => {
  let total = 0;
  let counted = 0;
  sweep(over, (x, y) => {
    if (
      !where(x, y) ||
      !where(x - 1, y) ||
      !where(x + 1, y) ||
      !where(x, y - 1) ||
      !where(x, y + 1)
    ) {
      return;
    }
    total += Math.abs(
      4 * luma(image, x, y) -
        luma(image, x - 1, y) -
        luma(image, x + 1, y) -
        luma(image, x, y - 1) -
        luma(image, x, y + 1)
    );
    counted += 1;
  });
  if (counted === 0) throw new Error("no pixel had all four neighbours inside");
  return total / counted;
};
