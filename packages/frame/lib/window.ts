import type { Box, CropAnchor, Point, Size } from "@meco/contracts";
import type { CropWindow } from "./framing";

/**
 * Where each Crop Anchor sits along an axis with slack, as a fraction of that
 * slack. The one place the nine names turn into arithmetic.
 */
const ANCHOR_OFFSETS: Record<CropAnchor, { x: number; y: number }> = {
  "top-left": { x: 0, y: 0 },
  top: { x: 0.5, y: 0 },
  "top-right": { x: 1, y: 0 },
  left: { x: 0, y: 0.5 },
  center: { x: 0.5, y: 0.5 },
  right: { x: 1, y: 0.5 },
  "bottom-left": { x: 0, y: 1 },
  bottom: { x: 0.5, y: 1 },
  "bottom-right": { x: 1, y: 1 },
};

/** The nearest whole pixel, never below one and never past the source axis. */
const roundOntoAxis = (value: number, limit: number): number =>
  Math.min(limit, Math.max(1, Math.round(value)));

/**
 * The largest window of the target shape that fits the Source Image. It
 * touches the source on one axis by construction, so only the other axis is
 * rounded and the shape survives to within half a pixel.
 */
export function coverWindow(source: Size, target: Size): Size {
  const aspect = target.width / target.height;
  const heightAtFullWidth = source.width / aspect;

  return heightAtFullWidth <= source.height
    ? {
        width: source.width,
        height: roundOntoAxis(heightAtFullWidth, source.height),
      }
    : {
        width: roundOntoAxis(source.height * aspect, source.width),
        height: source.height,
      };
}

/**
 * The cover window tightened by a zoom.
 *
 * A zoom of 1 or below is the cover window itself. Nothing widens a window past
 * the largest one of that shape the Source Image holds — and this is the only
 * place that says so, which is what makes an Eye Line a convention about where
 * a head looks best rather than a licence to widen a Crop the caller asked to
 * be tight.
 *
 * The shorter axis is rounded and the longer one derived from it, so neither
 * residual against the target shape can pass half a pixel. Rounding the longer
 * axis first would scale its half-pixel up by the aspect ratio, and rounding
 * both independently would add the two errors together. The same reasoning, and
 * the same order, as `windowForArea` in `lib/subject-area.ts`.
 */
export function tightenedWindow(
  cover: Size,
  zoom: number,
  target: Size,
  source: Size
): Size {
  if (zoom <= 1) return cover;

  const aspect = target.width / target.height;

  if (aspect >= 1) {
    const height = roundOntoAxis(cover.height / zoom, source.height);
    return { width: roundOntoAxis(height * aspect, source.width), height };
  }

  const width = roundOntoAxis(cover.width / zoom, source.width);
  return { width, height: roundOntoAxis(width / aspect, source.height) };
}

/**
 * Where the window starts on one axis, in whole Source Image pixels: the offset
 * that puts `at`, a fraction of the Source Image, at `aim`, a fraction of the
 * window. Clamped to the Source Image.
 *
 * An axis with no slack clamps to 0, which is the shape's answer rather than
 * this one's: a cover window touches the Source Image on one axis by
 * construction. An axis with slack can still run out of it, and then the window
 * sits against the edge and the aim is simply out of reach.
 */
const originOnAxis = (
  at: number,
  sourceExtent: number,
  windowExtent: number,
  aim: number
): number =>
  Math.min(
    sourceExtent - windowExtent,
    Math.max(0, Math.round(at * sourceExtent - aim * windowExtent))
  );

/**
 * Puts a window of a given size where `at` — a point in Source Image fractions
 * — lands on the aim point, a fraction of the window on each axis. The one
 * placement every composed Subject goes through: a Golden Line, a Subject Area
 * and an Eye Line disagree about where to aim, and an Eye Line about which
 * point is being aimed, and about nothing else.
 *
 * Each axis is solved on its own, because the two are independent — the aim
 * across says nothing about the aim down.
 */
export function placeAtAim(
  at: Point,
  size: Size,
  source: Size,
  aim: Point
): CropWindow {
  return {
    x: originOnAxis(at.x, source.width, size.width, aim.x),
    y: originOnAxis(at.y, source.height, size.height, aim.y),
    width: size.width,
    height: size.height,
  };
}

/** Puts a window of a given size where a Crop Anchor says, in whole pixels. */
export function placeAtAnchor(
  size: Size,
  source: Size,
  anchor: CropAnchor
): CropWindow {
  const offset = ANCHOR_OFFSETS[anchor];

  return {
    x: Math.round((source.width - size.width) * offset.x),
    y: Math.round((source.height - size.height) * offset.y),
    width: size.width,
    height: size.height,
  };
}

/**
 * The window in source fractions. Divided here and nowhere else: the same
 * division re-derived downstream is another chance to round it differently.
 */
export function toFraction(window: CropWindow, source: Size): Box {
  return {
    x: window.x / source.width,
    y: window.y / source.height,
    width: window.width / source.width,
    height: window.height / source.height,
  };
}
