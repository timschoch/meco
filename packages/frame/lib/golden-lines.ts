import type { Box, Point } from "@meco/contracts";
import { PHI_LINES } from "./framing";

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
 * Where the Subject aims when nobody declared a Subject Area: its nearest
 * Golden Line on each axis, as a fraction of the window.
 *
 * Each axis is chosen on its own. The two are independent, and the Golden Line
 * a Subject is nearest to across says nothing about the one it is nearest to
 * down.
 */
export function goldenAim(subject: Box): Point {
  return {
    x: nearestGoldenLine(subject.x + subject.width / 2),
    y: nearestGoldenLine(subject.y + subject.height / 2),
  };
}
