import type { Box, Size } from "@meco/contracts";
import { containsWithSlack } from "./boxes";
import { SLACK_PX, type CropWindow } from "./framing";
import { coverWindow } from "./window";

/**
 * What a declared Subject Area asks of the window, and what it cost to give it.
 *
 * Only the size. Where the Subject then aims is the centre of the Free Area,
 * which is the area itself until a Template covers part of it — so the aim is
 * settled in `lib/frame-crop.ts` where both are in hand, and an area cannot
 * answer it alone.
 */
export interface SubjectAreaSolve {
  /**
   * Never larger than the cover window: the Source Image has no more to give,
   * and a window past its edge is not a window.
   */
  size: Size;
  /** 1 when the Source Image could fill the area, the factor short otherwise. */
  shortfall: number;
}

/**
 * The window of the target shape that fits the Subject inside the area, in
 * whole pixels.
 *
 * Rounded up and never down. `needed` is the *smallest* window that holds the
 * Subject inside the area, so a window one rounding narrower puts the Subject
 * over the area's edge — and the half pixel of containment slack is already
 * spent on the rounding of the window's own origin.
 *
 * The longer axis is derived from the shorter one and never the reverse. The
 * rounding up is then divided by the aspect on the axis it was not applied to,
 * rather than multiplied by it, which is what keeps the window within a pixel
 * of the target shape on both axes at 16:9 and at 9:16 alike.
 *
 * Capped at the cover window, which the caller has already established the
 * picture can hold: the rounding up must not ask for a pixel the Source Image
 * has not got.
 */
const windowForArea = (needed: number, aspect: number, cover: Size): Size => {
  const wide = aspect >= 1;
  const shorter = Math.ceil(wide ? needed / aspect : needed);
  const longer = Math.ceil(wide ? shorter * aspect : shorter / aspect);

  return {
    width: Math.min(cover.width, wide ? longer : shorter),
    height: Math.min(cover.height, wide ? shorter : longer),
  };
};

/**
 * The window a Subject Area asks for.
 *
 * An area is a statement about proportions: a Subject `sw` wide filling a
 * fraction `area.width` of the frame fixes the frame at `sw / area.width`. Both
 * axes propose a window and the larger one wins, since the other then has room
 * to spare. The target shape ties the two together, so the proposals are
 * compared as widths and the height follows from the aspect.
 *
 * The prototype threw when the Source Image was too small for what it asked
 * (ADR-0001, `areaZoom`). frame answers every geometry it is given: the cover
 * window is the best there is, and `shortfall` says by what factor the picture
 * fell short of the one the area wanted.
 */
export function solveSubjectArea(
  area: Box,
  subject: Box,
  source: Size,
  target: Size
): SubjectAreaSolve {
  const aspect = target.width / target.height;
  const cover = coverWindow(source, target);

  const needed = Math.max(
    (subject.width * source.width) / area.width,
    ((subject.height * source.height) / area.height) * aspect
  );

  // The same half pixel the containment allows: a window one rounding wider
  // than the picture is not a Source Image that fell short, and a shortfall of
  // 1.0001 would read as a miss where the arithmetic only rounded.
  const sourceTooSmall = needed > cover.width + SLACK_PX;

  return {
    size: sourceTooSmall ? cover : windowForArea(needed, aspect, cover),
    shortfall: sourceTooSmall ? needed / cover.width : 1,
  };
}

/**
 * Whether the Subject fills the Subject Area on the window actually cut, rather
 * than on the one the area first asked for. The two differ whenever something
 * moved the window afterwards: the Source Image clamping the aim, or a rung of
 * the fallback ladder rescuing the Subject.
 *
 * The area is a fraction of the output frame, so it maps onto the window before
 * anything is compared, and both sides are then Source Image pixels.
 */
export function fillsSubjectArea(
  area: Box,
  subject: Box,
  window: CropWindow,
  source: Size
): boolean {
  return containsWithSlack(
    {
      x: window.x + area.x * window.width,
      y: window.y + area.y * window.height,
      width: area.width * window.width,
      height: area.height * window.height,
    },
    {
      x: subject.x * source.width,
      y: subject.y * source.height,
      width: subject.width * source.width,
      height: subject.height * source.height,
    }
  );
}
