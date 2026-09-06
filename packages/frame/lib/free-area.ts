import type { Box, Point, Size } from "@meco/contracts";
import { area, centreOf } from "./boxes";
import { SLACK_PX, type CropWindow } from "./framing";

/**
 * The whole output frame. What is left when a Template covers nothing, and the
 * identity of {@link aimWithin} — which is why an Occlusion Zone re-expresses
 * the composition rule instead of switching it off.
 */
const WHOLE_FRAME: Box = { x: 0, y: 0, width: 1, height: 1 };

/**
 * How near two fractions of a frame have to be to count as the same one.
 *
 * The sweep below compares areas and distances that are equal by construction —
 * two quadrants of a cross, three strips between two bands — and arrive by
 * different sums of the same coordinates. Without a tolerance the tie-break
 * order would be decided by the last bit of a float rather than by the rule
 * `docs/specs/frame.md` writes down.
 */
const TIE = 1e-9;

/** The rectangle both hold, or nothing when they only touch. */
const intersection = (a: Box, b: Box): Box | undefined => {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const width = Math.min(a.x + a.width, b.x + b.width) - x;
  const height = Math.min(a.y + a.height, b.y + b.height) - y;

  return width > 0 && height > 0 ? { x, y, width, height } : undefined;
};

/** How far a rectangle's centre sits from the frame's. The second tie-break. */
const offCentre = (box: Box): number => {
  const centre = centreOf(box);

  return Math.hypot(centre.x - 0.5, centre.y - 0.5);
};

/**
 * Whether one candidate beats another, by the whole tie-break order in
 * `docs/specs/frame.md`: the largest area, then the rectangle nearest the frame
 * centre, then the lowest `y`, then the lowest `x`.
 *
 * A full tie leaves the incumbent, and the sweep visits candidates in
 * increasing `x` then `y`, so the two agree about which rectangle that is.
 */
const beats = (candidate: Box, best: Box): boolean => {
  const byArea = area(candidate) - area(best);
  if (Math.abs(byArea) > TIE) return byArea > 0;

  const byCentre = offCentre(candidate) - offCentre(best);
  if (Math.abs(byCentre) > TIE) return byCentre < 0;

  if (Math.abs(candidate.y - best.y) > TIE) return candidate.y < best.y;

  if (Math.abs(candidate.x - best.x) > TIE) return candidate.x < best.x;

  return false;
};

/** Every distinct cut on one axis: the frame's two edges and each zone's. */
const cuts = (edges: number[]): number[] =>
  [...new Set([0, 1, ...edges])].sort((a, b) => a - b);

/**
 * The largest rectangle of the frame no Occlusion Zone touches.
 *
 * Each edge of that rectangle is either an edge of the frame or flush with an
 * edge of a zone — any other edge could be pushed outwards without meeting a
 * zone, and the rectangle was not the largest. So the sweep only has to try the
 * rectangles those cuts span, which is what bounds the work and why the zone
 * count is capped rather than the geometry refused.
 *
 * `undefined` when the zones cover the frame between them and there is no
 * rectangle left to aim at.
 */
const largestFreeRectangle = (zones: readonly Box[]): Box | undefined => {
  const xs = cuts(zones.flatMap((zone) => [zone.x, zone.x + zone.width]));
  const ys = cuts(zones.flatMap((zone) => [zone.y, zone.y + zone.height]));

  let best: Box | undefined;

  for (let i = 0; i < xs.length - 1; i += 1) {
    for (let j = i + 1; j < xs.length; j += 1) {
      const x = xs[i]!;
      const right = xs[j]!;
      // The zones this column of candidates could possibly meet, taken once
      // for the whole column rather than once per candidate.
      const column = zones.filter(
        (zone) => zone.x < right - TIE && zone.x + zone.width > x + TIE
      );

      for (let k = 0; k < ys.length - 1; k += 1) {
        for (let l = k + 1; l < ys.length; l += 1) {
          const y = ys[k]!;
          const bottom = ys[l]!;
          const touched = column.some(
            (zone) => zone.y < bottom - TIE && zone.y + zone.height > y + TIE
          );
          if (touched) continue;

          const candidate = { x, y, width: right - x, height: bottom - y };
          if (best === undefined || beats(candidate, best)) best = candidate;
        }
      }
    }
  }

  return best;
};

/**
 * Where the Subject may land: the largest zone-free rectangle of the frame,
 * narrowed to a declared Subject Area when there is one.
 *
 * Intersected after the sweep and not searched inside the area, which is what
 * the spec says and what makes the empty case reachable at all. An area the
 * zones leave nothing of wins outright — somebody said where the Subject goes,
 * and frame does not overrule that on its own. The miss shows up where every
 * other one does, in `occlusionClear` measured on the window actually cut.
 *
 * Zones that cover the frame between them leave the whole frame, which reads
 * backwards and is the only answer there is: there is nowhere to aim, so
 * nothing is gained by aiming somewhere arbitrary, and the composition the
 * picture asked for is a better window than a corner. The miss is reported
 * either way.
 *
 * Called only when a Template declared a zone. With none there is no Free Area
 * and no clamp, so an empty list is the absence of this whole path rather than
 * a case inside it.
 */
export function freeArea(
  zones: readonly Box[],
  declared: Box | undefined
): Box {
  const free = largestFreeRectangle(zones);
  if (free === undefined) return declared ?? WHOLE_FRAME;
  if (declared === undefined) return free;

  return intersection(free, declared) ?? declared;
}

/**
 * A Golden Line, measured off the Free Area instead of off the whole frame.
 *
 * The one line that makes an overlay re-express the composition rule rather
 * than switch it off: under a caption band from y 0.76 the Eye Line lands at
 * `0.382 x 0.76`, which is the 29.0 % of ADR-0006's table. With no zone the
 * Free Area is the whole frame and this is the identity.
 */
export const aimWithin = (free: Box, aim: Point): Point => ({
  x: free.x + aim.x * free.width,
  y: free.y + aim.y * free.height,
});

/**
 * The aim moved as little as possible so the Subject lands inside the Free
 * Area. `before` is how much of the Subject sits ahead of the point being
 * aimed and `span` its whole extent, both as fractions of the window.
 *
 * A Subject wider than the Free Area is centred in it: no aim clears the zone,
 * so there is no best-effort answer to prefer and the miss is reported instead.
 * frame answers every geometry it is given.
 */
const clampOnAxis = (
  aim: number,
  before: number,
  span: number,
  freeStart: number,
  freeExtent: number
): number => {
  const low = freeStart + before;
  const high = freeStart + freeExtent - (span - before);

  return low > high ? (low + high) / 2 : Math.min(high, Math.max(low, aim));
};

/**
 * The aim clamped so the Subject lands inside the Free Area, on each axis
 * independently.
 *
 * `at` is the point the window is placed on, which is the Subject's centre for
 * a Golden Line and the eyes for an Eye Line. Where it sits inside the Subject
 * is the only difference that matters here, so it is taken as a fraction of the
 * Subject and the two rules need no case of their own.
 */
export function clampIntoFreeArea(
  aim: Point,
  at: Point,
  subject: Box,
  free: Box,
  size: Size,
  source: Size
): Point {
  const span = {
    x: (subject.width * source.width) / size.width,
    y: (subject.height * source.height) / size.height,
  };
  const within = {
    x: (at.x - subject.x) / subject.width,
    y: (at.y - subject.y) / subject.height,
  };

  return {
    x: clampOnAxis(aim.x, within.x * span.x, span.x, free.x, free.width),
    y: clampOnAxis(aim.y, within.y * span.y, span.y, free.y, free.height),
  };
}

/**
 * Whether the Subject stays off every Occlusion Zone, in the window actually
 * cut rather than the one the aim asked for. The two differ whenever the
 * Source Image clamped the aim, and that is exactly the case worth reporting.
 *
 * Everything is compared in Source Image pixels measured from the window's own
 * origin, so the zones — fractions of the output frame — are scaled by the
 * window and nothing is divided twice. An overlap of half a pixel or less is
 * the same rounding slack containment allows.
 */
export function clearOfZones(
  subject: Box,
  zones: readonly Box[],
  window: CropWindow,
  source: Size
): boolean {
  const left = subject.x * source.width - window.x;
  const top = subject.y * source.height - window.y;
  const right = left + subject.width * source.width;
  const bottom = top + subject.height * source.height;

  return zones.every((zone) => {
    const across =
      Math.min(right, (zone.x + zone.width) * window.width) -
      Math.max(left, zone.x * window.width);
    const down =
      Math.min(bottom, (zone.y + zone.height) * window.height) -
      Math.max(top, zone.y * window.height);

    return across <= SLACK_PX || down <= SLACK_PX;
  });
}
