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
 * Where the window starts on one axis, in whole Source Image pixels: the offset
 * that puts the Subject's centre at `aim` of the window, clamped to the Source
 * Image.
 *
 * An axis with no slack clamps to 0, which is the shape's answer rather than
 * this one's: a cover window touches the Source Image on one axis by
 * construction. An axis with slack can still run out of it, and then the window
 * sits against the edge and the aim is simply out of reach.
 */
const originOnAxis = (
  subjectCentre: number,
  sourceExtent: number,
  windowExtent: number,
  aim: number
): number =>
  Math.min(
    sourceExtent - windowExtent,
    Math.max(0, Math.round(subjectCentre * sourceExtent - aim * windowExtent))
  );

/**
 * Puts a window of a given size where the Subject's centre lands on the aim
 * point, a fraction of the window on each axis. The one placement every
 * composed Subject goes through: a Golden Line and a Subject Area disagree
 * about where to aim and about nothing else.
 *
 * Each axis is solved on its own, because the two are independent — the aim
 * across says nothing about the aim down.
 */
export function placeAtAim(
  subject: Box,
  size: Size,
  source: Size,
  aim: Point
): CropWindow {
  return {
    x: originOnAxis(
      subject.x + subject.width / 2,
      source.width,
      size.width,
      aim.x
    ),
    y: originOnAxis(
      subject.y + subject.height / 2,
      source.height,
      size.height,
      aim.y
    ),
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
