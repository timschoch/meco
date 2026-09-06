import type { Box, Point, Size } from "@meco/contracts";
import { centreOf, containsWithSlack } from "./boxes";
import { type CropWindow, type FallbackRung } from "./framing";
import { placeAtAim } from "./window";

/** The middle of the frame: where `relax` slides the aim to, and where `clip` puts the Subject. */
const CENTRE: Point = { x: 0.5, y: 0.5 };

/** Halfway from an aim point to the middle of the frame, on each axis. */
const halfwayToCentre = (aim: Point): Point => ({
  x: (aim.x + CENTRE.x) / 2,
  y: (aim.y + CENTRE.y) / 2,
});

/** A kept Region reduced to what the ladder reads: its id and its box. */
export interface KeptRegion {
  id: string;
  /** Source fractions, as the Annotation holds it. */
  box: Box;
}

/** What the ladder needs from the composition it is rescuing. */
export interface LadderInput {
  /** The window the composition first asked for. */
  firstWindow: CropWindow;
  /** The point the window was placed on, in source fractions: the Subject's centre, or the eyes. */
  at: Point;
  /** Where that point was aimed, as a fraction of the window. */
  aim: Point;
  /** The composed Subject, in source fractions. What `clip` centres on. */
  subject: Box;
  /** The largest window of the target shape the Source Image holds. */
  cover: Size;
  /**
   * Every Region the answering rung kept, in tier order — the leader first and
   * the cheapest last, as `lib/tiers.ts` ordered them. Never empty: the leader
   * is always among them.
   */
  kept: readonly KeptRegion[];
  source: Size;
}

/** Which rung answered, with the window and the Subjects it cost. */
export interface LadderOutcome {
  window: CropWindow;
  keptRegionIds: string[];
  droppedRegionIds: string[];
  satisfied: boolean;
  fallback?: FallbackRung;
}

/**
 * Whether a Region's box lies inside the window. Compared in Source Image
 * pixels, since that is the one place the window and the box are the same kind
 * of number, and `lib/boxes.ts` owns the half pixel of slack.
 */
const holds = (window: CropWindow, box: Box, source: Size): boolean =>
  containsWithSlack(window, {
    x: box.x * source.width,
    y: box.y * source.height,
    width: box.width * source.width,
    height: box.height * source.height,
  });

/**
 * The fallback ladder. What each rung gives up and in what order:
 * `docs/specs/frame.md`, "The fallback ladder".
 *
 * The loop is the spec's "cumulative, and the sacrifices counted first" made
 * literal: the outer loop counts how many Subjects have been given up and the
 * inner one how far the window has moved, so nothing is sacrificed while any
 * window still holds them all, and a sacrifice buys back the tightest window
 * that holds whoever is left.
 */
export function climbLadder(input: LadderInput): LadderOutcome {
  const { firstWindow, at, aim, subject, cover, kept, source } = input;
  const ids = kept.map((region) => region.id);

  // The four windows, cheapest repair first. The first is what was asked for,
  // so it is the only one that can leave the Framing satisfied.
  const rungs: { rung?: FallbackRung; window: CropWindow }[] = [
    { window: firstWindow },
    { rung: "zoom-out", window: placeAtAim(at, cover, source, aim) },
    {
      rung: "relax",
      window: placeAtAim(at, cover, source, halfwayToCentre(aim)),
    },
    { rung: "relax", window: placeAtAim(at, cover, source, CENTRE) },
  ];

  // `keep` counts down from every Subject to the leader alone, and the tier
  // order is what makes the prefix the right survivors: cheapest last.
  for (let keep = kept.length; keep >= 1; keep--) {
    const survivors = kept.slice(0, keep);

    for (const { rung, window } of rungs) {
      if (!survivors.every((region) => holds(window, region.box, source))) {
        continue;
      }

      const droppedRegionIds = ids.slice(keep);

      return {
        window,
        keptRegionIds: ids.slice(0, keep),
        droppedRegionIds,
        satisfied: droppedRegionIds.length === 0 && rung === undefined,
        // A sacrifice names the drop rung whichever window bought it back:
        // the ladder reports what it gave up, and a Subject outranks a pixel.
        ...(droppedRegionIds.length > 0
          ? { fallback: "drop" as const }
          : rung === undefined
            ? {}
            : { fallback: rung }),
      };
    }
  }

  return {
    window: placeAtAim(centreOf(subject), cover, source, CENTRE),
    // Nothing was sacrificed: `clip` is reached with the leader alone still
    // unheld, and the leader is never sacrificed. Everything kept is reported
    // as kept, and `satisfied: false` is the honest word for what it holds.
    keptRegionIds: ids,
    droppedRegionIds: [],
    satisfied: false,
    fallback: "clip",
  };
}
