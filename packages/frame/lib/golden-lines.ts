import type { Box, Size } from "@meco/contracts";
import { PHI_LINES, type CropWindow } from "./framing";

/**
 * The Golden Line nearest to where the Subject already sat, `subjectCentre`
 * being its centre as a fraction of the Source Image along one axis. Nearest
 * rather than fixed, so the photographer's composition moves as little as
 * possible and the window is less likely to run out of Source Image.
 *
 * A Subject halfway along the axis is equally near both and takes the
 * upper-left line. Written as `<=` and not `<` so that tie is decided here, in
 * the open, rather than by whichever comparison happens to be evaluated first.
 */
const nearestGoldenLine = (subjectCentre: number): number => {
  const [upperLeft, lowerRight] = PHI_LINES;

  return Math.abs(subjectCentre - upperLeft) <=
    Math.abs(subjectCentre - lowerRight)
    ? upperLeft
    : lowerRight;
};

/**
 * Where the window starts on one axis, in whole Source Image pixels: the
 * offset that puts the Subject's centre on its nearest Golden Line, clamped to
 * the Source Image.
 *
 * An axis with no slack clamps to 0, which is the shape's answer rather than
 * this one's: a cover window touches the Source Image on one axis by
 * construction. An axis with slack can still run out of it, and then the
 * window sits against the edge and the line is simply out of reach.
 */
const originOnAxis = (
  subjectCentre: number,
  sourceExtent: number,
  windowExtent: number
): number => {
  const wanted =
    subjectCentre * sourceExtent -
    nearestGoldenLine(subjectCentre) * windowExtent;

  return Math.min(sourceExtent - windowExtent, Math.max(0, Math.round(wanted)));
};

/**
 * Puts a window of a given size where the Subject lands on its Golden Lines.
 * Each axis is solved on its own: the two are independent, and the Golden Line
 * a Subject is nearest to across says nothing about the one it is nearest to
 * down.
 */
export function placeOnGoldenLines(
  subject: Box,
  size: Size,
  source: Size
): CropWindow {
  return {
    x: originOnAxis(subject.x + subject.width / 2, source.width, size.width),
    y: originOnAxis(subject.y + subject.height / 2, source.height, size.height),
    width: size.width,
    height: size.height,
  };
}
