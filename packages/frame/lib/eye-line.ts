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
 * `room` is the two edges of the window speaking at once: `PHI_LINES[0]` of its
 * height has to fit above the eyes and the rest below, and the smaller of the
 * two is what the Source Image actually allows.
 *
 * Below 1 when the Source Image already holds all the headroom the eyes ask
 * for. That is not a licence to widen a Crop, and `tightenedWindow` is where it
 * is refused — the bound belongs to the window arithmetic, and stating it here
 * as well would be one rule in two places, either of which could be relaxed
 * without the other noticing.
 *
 * Never so tight that the leading face would not fit: headroom that
 * cropped the face off is the opposite of the point. The required shape ties the
 * two axes together, so the height the floor asks for is the larger of what each
 * axis needs.
 *
 * The floor is the **leading** face's own box and not the union of every kept
 * Subject. Flooring on the union switches the rule off in exactly the case a
 * Match creates: in a group the faces stand wider apart than any window that
 * gives one of them headroom, so the floor exceeds the cover window and the eyes
 * never move. Measured on `soyuz-crew.jpg` at 1:1, 4:5 and 9:16 — 34.2 % on the
 * union floor against the 38.2 % the rule asks for. Whether the others still fit
 * is the fallback ladder's question, asked after; folding it in here answered it
 * twice. ADR-0001, amendment of 5 Sep 2026.
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
