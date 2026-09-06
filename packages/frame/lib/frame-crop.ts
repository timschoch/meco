import {
  DEFAULT_ANCHOR,
  type Annotation,
  type Region,
  type Size,
} from "@meco/contracts";
import { centreOf } from "./boxes";
import { eyeLineOf, eyeLinePlacement, headroomZoom } from "./eye-line";
import {
  aimWithin,
  clampIntoFreeArea,
  clearOfZones,
  freeArea,
} from "./free-area";
import {
  MAX_OCCLUSION_ZONES,
  type CropWindow,
  type FrameInput,
  type Framing,
} from "./framing";
import { goldenAim } from "./golden-lines";
import { climbLadder, type KeptRegion, type LadderOutcome } from "./ladder";
import { composeSubject } from "./subject";
import { fillsSubjectArea, solveSubjectArea } from "./subject-area";
import {
  coverWindow,
  placeAtAim,
  placeAtAnchor,
  tightenedWindow,
  toFraction,
} from "./window";

/**
 * The kept Regions with their boxes, in the tier order `composeSubject` put
 * their ids in. What the fallback ladder measures containment on: the Subject
 * is one box and the kept Regions are their own, and #105 recorded that the two
 * do not coincide — `person-5` of `paddock-mixed.jpg` sits inside the composed
 * Subject without being kept.
 */
const keptRegions = (
  annotation: Annotation,
  keptRegionIds: readonly string[]
): KeptRegion[] =>
  keptRegionIds.flatMap((id) => {
    const region = annotation.regions.find((candidate) => candidate.id === id);

    return region === undefined ? [] : [{ id, box: region.box }];
  });

/** The Region a rung led on, when a rung led at all. */
const leadRegion = (
  annotation: Annotation,
  leadRegionId: string | undefined
): Region | undefined =>
  leadRegionId === undefined
    ? undefined
    : annotation.regions.find((region) => region.id === leadRegionId);

/**
 * How much the window is resampled by to fill the target. The two axes agree
 * up to the window's whole-pixel rounding; the larger ratio is the one a
 * resampler has to make up, so it is the one reported.
 */
const scaleOf = (window: CropWindow, target: Size): number =>
  Math.max(target.width / window.width, target.height / window.height);

/**
 * The whole module. Subject composition, the ladder, the Golden Lines, the Eye
 * Line, the Free Area and the fallback rungs all sit behind this one call.
 *
 * It composes on the `match`, `face` and `kart` rungs, sizes and aims on a
 * declared Subject Area or else on the leading face's Eye Line, keeps the
 * Subject inside the Free Area an overlay leaves, climbs the fallback ladder
 * when the window it first asked for cannot hold every Subject the rung kept,
 * and falls back to frame's own last resorts, the Crop Anchor the request
 * named and then the centre.
 */
export function frameCrop(input: FrameInput): Framing {
  const { annotation, request } = input;

  if (request.occlusion.length > MAX_OCCLUSION_ZONES) {
    throw new RangeError(
      `a FramingRequest may declare at most ${MAX_OCCLUSION_ZONES} occlusion zones, not ${request.occlusion.length}`
    );
  }

  const source = { width: annotation.width, height: annotation.height };
  // No Matches is the same input as none that this Brand may see, and the
  // `match` rung answers both the same way: it composes nothing and the ladder
  // walks on.
  const composed = composeSubject(annotation, input.matches ?? [], request);
  const declaredArea = request.subjectArea;

  // A Subject Area does two jobs and needs a Subject for both: it sizes the
  // window so the Subject fills it, and it supplies the aim point in place of a
  // Golden Line. The anchor and the centre compose no Subject, so an area has
  // nothing there to size or aim and the window is placed as it would have
  // been. The Eye Line (#103) is the only other thing that sizes, and a
  // declared area turns it off.
  const area =
    declaredArea === undefined || composed === undefined
      ? undefined
      : solveSubjectArea(
          declaredArea,
          composed.subject,
          source,
          request.target
        );

  // The Eye Line, read where the size and the aim meet, because it settles
  // both. Only a face carries one, so the kart rung never sees it; and a
  // declared Subject Area turns it off, so the two sizing rules can never
  // disagree about one window.
  const lead = leadRegion(annotation, composed?.leadRegionId);
  const eyeLine =
    declaredArea === undefined && lead !== undefined
      ? eyeLineOf(lead)
      : undefined;

  // The cover window is the size for every other rung, and the ceiling for
  // both of these: nothing grows the window past the largest one the picture
  // holds.
  const cover = coverWindow(source, request.target);
  const size =
    area?.size ??
    (eyeLine === undefined || lead === undefined
      ? cover
      : tightenedWindow(
          cover,
          // Floored on the leading face's own box, never on the union of every
          // kept Subject. `lib/eye-line.ts` says what the union costs.
          headroomZoom(eyeLine, lead.box, cover, source, request.target),
          request.target,
          source
        ));

  // Where the Subject aims before an overlay has its say: the centre of a
  // declared Subject Area, the eyes' Golden Line, or the Subject's own nearest
  // Golden Line. All three are fractions of the output frame.
  const composition =
    composed === undefined
      ? undefined
      : eyeLine === undefined
        ? {
            at: centreOf(composed.subject),
            aim:
              declaredArea === undefined
                ? goldenAim(composed.subject)
                : centreOf(declaredArea),
          }
        : eyeLinePlacement(composed.subject, eyeLine);

  // The Free Area, and only when a Template declared a zone. Not an
  // optimisation: with no zone there is no Free Area and no clamp, so an empty
  // `occlusion` list changes nothing because there is nothing for it to change
  // — and #106's Subject Area windows keep the placement they were pinned at.
  const free =
    request.occlusion.length === 0
      ? undefined
      : freeArea(request.occlusion, declaredArea);

  // What an Occlusion Zone does, and all it does. The rule is re-expressed
  // inside what the overlay leaves, then the aim is clamped so the Subject
  // lands there. The size is already settled above and no line here touches it:
  // no zoom clears an overlay (ADR-0006, "Why occlusion aims but does not
  // size").
  //
  // A Golden Line names a proportion, so it is measured off the Free Area
  // instead of off the frame. A declared Subject Area names a place, so it
  // keeps the place it named and only the clamp may move it — an overlay that
  // leaves the Subject where the caller put it moves nothing.
  //
  // `composed` is undefined exactly when `composition` is; the test is repeated
  // only so `composed.subject` narrows.
  const placement =
    composition === undefined || composed === undefined || free === undefined
      ? composition
      : {
          at: composition.at,
          aim: clampIntoFreeArea(
            declaredArea === undefined
              ? aimWithin(free, composition.aim)
              : composition.aim,
            composition.at,
            composed.subject,
            free,
            size,
            source
          ),
        };

  const firstWindow = placement
    ? placeAtAim(placement.at, size, source, placement.aim)
    : placeAtAnchor(
        size,
        source,
        // The two last resorts place identically when the caller named the
        // centre; what differs is what frame reports, and that is the caller's
        // word for it.
        request.anchor ?? DEFAULT_ANCHOR
      );

  // The fallback ladder, and only when a rung composed something for it to
  // hold. The anchor and the centre compose no Subject, so there is nothing a
  // rung could fail to hold and nothing to rescue: the window they placed is
  // the answer and it is satisfied. `lib/ladder.ts` holds the rungs.
  const climbed: LadderOutcome =
    composed === undefined || placement === undefined
      ? {
          window: firstWindow,
          keptRegionIds: [],
          droppedRegionIds: [],
          satisfied: true,
        }
      : climbLadder({
          firstWindow,
          at: placement.at,
          aim: placement.aim,
          subject: composed.subject,
          cover,
          kept: keptRegions(annotation, composed.keptRegionIds),
          source,
        });

  const cropWindow = climbed.window;
  const scale = scaleOf(cropWindow, request.target);

  return {
    window: cropWindow,
    windowFraction: toFraction(cropWindow, source),
    scale,
    ...(scale > 1 ? { lowResolution: true as const } : {}),
    resolvedBy:
      composed?.resolvedBy ??
      (request.anchor === undefined ? "center" : "anchor"),
    // Both absent when nothing was composed. The window standing in for a
    // Subject would be held by every rung of the ladder without meaning it,
    // and the point the anchor stands at is not a contracts `Box`, whose sides
    // are above zero.
    leadRegionId: composed?.leadRegionId,
    subject: composed?.subject,
    // What the ladder ended on, not what the rung composed: a Subject a rung
    // sacrificed moves from one list to the other, and the two partition what
    // the rung composed on.
    keptRegionIds: climbed.keptRegionIds,
    droppedRegionIds: climbed.droppedRegionIds,
    satisfied: climbed.satisfied,
    ...(climbed.fallback === undefined ? {} : { fallback: climbed.fallback }),
    // Only when the request named an area, and measured on the window actually
    // cut rather than the one first asked for: the Source Image can clamp the
    // aim off the area, and a rung of the ladder can move the window off it
    // altogether.
    //
    // A sacrifice is a miss, whatever the window then holds. The area asked
    // for the Subject the rung composed, and a Subject the drop rung gave up
    // is not part of it any more — so the area was not filled, however well the
    // survivors sit in it.
    ...(declaredArea === undefined
      ? {}
      : {
          subjectAreaSatisfied:
            composed !== undefined &&
            climbed.droppedRegionIds.length === 0 &&
            fillsSubjectArea(
              declaredArea,
              composed.subject,
              cropWindow,
              source
            ),
          // A size ratio, so it is 1 whenever the picture was big enough — an
          // area missed for any other reason is an unsatisfied area at no
          // shortfall.
          subjectAreaShortfall: area?.shortfall ?? 1,
        }),
    // Only when a Template declared a zone and a rung composed something to
    // keep off it. Measured on the window actually cut: the Source Image can
    // clamp the aim back onto a zone, and that is the miss worth reporting.
    // Never a refusal — frame answers every geometry it is given, and a zone
    // nothing could clear still gets a window.
    //
    // Absent, not vacuously true, when the anchor or the centre answered. The
    // flag says something about a Subject, and those two rungs compose none —
    // the same reason `subject` and `leadRegionId` are absent there, and the
    // same lie #136 took out: a `true` every rung holds without meaning it.
    ...(request.occlusion.length === 0 || composed === undefined
      ? {}
      : {
          occlusionClear: clearOfZones(
            composed.subject,
            request.occlusion,
            cropWindow,
            source
          ),
        }),
  };
}
