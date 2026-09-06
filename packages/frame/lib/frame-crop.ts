import { DEFAULT_ANCHOR, type Annotation, type Region } from "@meco/contracts";
import { centreOf } from "./boxes";
import { eyeLineOf, eyeLinePlacement, headroomZoom } from "./eye-line";
import {
  aimWithin,
  clampIntoFreeArea,
  clearOfZones,
  freeArea,
} from "./free-area";
import { MAX_OCCLUSION_ZONES, type FrameInput, type Framing } from "./framing";
import { goldenAim } from "./golden-lines";
import { composeSubject } from "./subject";
import { fillsSubjectArea, solveSubjectArea } from "./subject-area";
import {
  coverWindow,
  placeAtAim,
  placeAtAnchor,
  tightenedWindow,
  toFraction,
} from "./window";

/** The Region a rung led on, when a rung led at all. */
const leadRegion = (
  annotation: Annotation,
  leadRegionId: string | undefined
): Region | undefined =>
  leadRegionId === undefined
    ? undefined
    : annotation.regions.find((region) => region.id === leadRegionId);

/**
 * The whole module. Subject composition, the ladder, the Golden Lines, the Eye
 * Line, the Free Area and the fallback rungs all sit behind this one call.
 *
 * Today it composes on the `match`, `face` and `kart` rungs, sizes and aims on
 * a declared Subject Area or else on the leading face's Eye Line, keeps the
 * Subject inside the Free Area an overlay leaves, and falls back to frame's own
 * last resorts, the Crop Anchor the request named and then the centre. The
 * fallback ladder arrives on a later ticket and adds no field this
 * signature does not already declare.
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
  const placement =
    composition === undefined || composed === undefined || free === undefined
      ? composition
      : {
          at: composition.at,
          aim: clampIntoFreeArea(
            // A declared area names a place, a Golden Line a proportion. The
            // first moves to the centre of what is left of it; the second is
            // measured off the Free Area instead of off the frame.
            declaredArea === undefined
              ? aimWithin(free, composition.aim)
              : centreOf(free),
            composition.at,
            composed.subject,
            free,
            size,
            source
          ),
        };

  const cropWindow = placement
    ? placeAtAim(placement.at, size, source, placement.aim)
    : placeAtAnchor(
        size,
        source,
        // The two last resorts place identically when the caller named the
        // centre; what differs is what frame reports, and that is the caller's
        // word for it.
        request.anchor ?? DEFAULT_ANCHOR
      );

  return {
    window: cropWindow,
    windowFraction: toFraction(cropWindow, source),
    resolvedBy:
      composed?.resolvedBy ??
      (request.anchor === undefined ? "center" : "anchor"),
    // Both absent when nothing was composed. The window standing in for a
    // Subject would be held by every rung of the ladder without meaning it,
    // and the point the anchor stands at is not a contracts `Box`, whose sides
    // are above zero.
    leadRegionId: composed?.leadRegionId,
    subject: composed?.subject,
    keptRegionIds: composed?.keptRegionIds ?? [],
    droppedRegionIds: [],
    satisfied: true,
    // Only when the request named an area, and measured on the window actually
    // cut rather than the one first asked for: the Source Image can clamp the
    // aim off the area, and that is a miss the window it first asked for would
    // not have shown. #108 adds the other half — a Subject its drop rung
    // sacrificed is a miss too — with the rung that can turn the check red.
    ...(declaredArea === undefined
      ? {}
      : {
          subjectAreaSatisfied:
            composed !== undefined &&
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
    // Only when a Template declared a zone, and measured on the window actually
    // cut: the Source Image can clamp the aim back onto a zone, and that is the
    // miss worth reporting. Never a refusal — frame answers every geometry it
    // is given, and a zone nothing could clear still gets a window.
    //
    // Vacuously true when nothing was composed. The anchor and the centre
    // compose no Subject, so no Subject landed on a zone.
    ...(request.occlusion.length === 0
      ? {}
      : {
          occlusionClear:
            composed === undefined ||
            clearOfZones(
              composed.subject,
              request.occlusion,
              cropWindow,
              source
            ),
        }),
  };
}
