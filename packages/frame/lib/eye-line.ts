import type { Box, Point, Region, Size } from "@meco/contracts";
import { centreOf } from "./boxes";
import { PHI_LINES } from "./framing";
import { goldenAim } from "./golden-lines";

/**
 * The Eye Line: the midpoint between a Region's two eyes, as a fraction of the
 * Source Image height.
 *
 * `undefined` for a Region carrying no landmarks, which is every Region that is
 * not a face — contracts requires a `face` to carry them and forbids nobody
 * else from doing so. That is what keeps the rule off the kart rung without the
 * kart rung knowing the rule exists.
 *
 * Only the vertical is read. The Eye Line is the one place a portrait must not
 * be framed on its centre, and that is a statement about headroom; across the
 * frame the Subject keeps the nearest-Golden-Line rule it already had.
 */
export const eyeLineOf = (region: Region): number | undefined =>
  region.landmarks === undefined
    ? undefined
    : (region.landmarks.rEye.y + region.landmarks.lEye.y) / 2;

/**
 * What an Eye Line places, and where: the eyes on the upper Golden Line.
 *
 * The point aimed is the eyes and not the Subject's centre — a head placed on
 * the middle of the frame reads as a mugshot, and the eyes are what the
 * placement is measured from. Across the frame nothing changes: an Eye Line is
 * a fraction of the Source Image height and says nothing about the other axis,
 * so the Subject's centre keeps its nearest Golden Line there.
 */
export const eyeLinePlacement = (
  subject: Box,
  eyeLine: number
): { at: Point; aim: Point } => ({
  at: { x: centreOf(subject).x, y: eyeLine },
  aim: { x: goldenAim(subject).x, y: PHI_LINES[0] },
});

/**
 * How much tighter than the cover window the Eye Line needs the window to be
 * for the eyes to reach the upper Golden Line.
 *
 * An Eye Line sizes the window as well as aiming it, because at the shapes a
 * portrait is cut to there is usually no vertical slack left to place it in
 * otherwise: a cover window touches the Source Image on one axis by
 * construction, and for a portrait cut taller that axis is the vertical one.
 * Tightening buys the slack back, and tightening is what a person cutting a
 * portrait into a story would do anyway.
 *
 * `room` is the two edges of the window at once. `PHI_LINES[0]` of its height
 * has to fit above the eyes and the rest below. The smaller of the two is what
 * the Source Image allows.
 *
 * The answer is below 1 when the picture already holds the headroom asked for.
 * Widening is refused in `tightenedWindow` and nowhere else, so that the bound
 * cannot be relaxed in one place while the other still claims it.
 *
 * `floor` is the smallest window that still holds the leading face. The target
 * shape ties the two axes together, so it is the larger of what each axis asks
 * for. Where the face then lands is the fallback ladder's question, asked after.
 *
 * The floor is the **leading** face's box, never the union of every kept
 * Subject. Why, and the 34.2 % it cost: ADR-0001, amendment of 5 Sep 2026,
 * `docs/adr/0001-analytic-solver-over-search-based-crop.md`.
 */
export function headroomZoom(
  eyeLine: number,
  face: Box,
  cover: Size,
  source: Size,
  target: Size
): number {
  const aspect = target.width / target.height;
  const eyes = eyeLine * source.height;
  const [above, below] = PHI_LINES;

  const room = Math.min(eyes / above, (source.height - eyes) / below);
  const floor = Math.max(
    face.height * source.height,
    (face.width * source.width) / aspect
  );
  const height = Math.max(floor, Math.min(cover.height, room));

  return cover.height / height;
}
