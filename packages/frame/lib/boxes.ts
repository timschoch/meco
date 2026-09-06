import type { Box, Region } from "@meco/contracts";

/** A Box's area, in the square of the source fraction. Never a pixel count. */
export const area = (box: Box): number => box.width * box.height;

/**
 * How much of the smaller of two boxes lies inside the other, from 0 to 1.
 *
 * Deliberately not intersection over union. A driver's box is a fraction of the
 * kart's, so their IoU is small even when the driver sits entirely inside the
 * kart — measured on `on-track-rear-helmet.jpg`, 0.173 against 0.559 — and IoU
 * would reject exactly the pair the kart rung exists to join.
 */
export const overlapOfSmaller = (a: Box, b: Box): number => {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  if (width <= 0 || height <= 0) return 0;

  return (width * height) / Math.min(area(a), area(b));
};

/**
 * The smallest Box holding every one of them. The first is taken on its own so
 * that the type carries the one thing a union needs: a union of no boxes is not
 * a `Box`, whose sides are above zero.
 */
export const union = (first: Box, ...rest: Box[]): Box => {
  const boxes = [first, ...rest];
  const x = Math.min(...boxes.map((box) => box.x));
  const y = Math.min(...boxes.map((box) => box.y));

  return {
    x,
    y,
    width: Math.max(...boxes.map((box) => box.x + box.width)) - x,
    height: Math.max(...boxes.map((box) => box.y + box.height)) - y,
  };
};

/**
 * The Region with the largest box. The first of equals wins, which is the
 * lowest Region id without a rule of its own to say so: contracts hands the
 * Regions over in the order it numbered them.
 */
export const regionWithLargestBox = (
  candidates: Region[]
): Region | undefined =>
  candidates.reduce<Region | undefined>(
    (best, candidate) =>
      best === undefined || area(candidate.box) > area(best.box)
        ? candidate
        : best,
    undefined
  );
