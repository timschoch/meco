import { DEFAULT_ANCHOR } from "@meco/contracts";
import { MAX_OCCLUSION_ZONES, type FrameInput, type Framing } from "./framing";
import { goldenAim } from "./golden-lines";
import { composeSubject } from "./subject";
import { fillsSubjectArea, solveSubjectArea } from "./subject-area";
import { coverWindow, placeAtAim, placeAtAnchor, toFraction } from "./window";

/**
 * The whole module. Subject composition, the ladder, the Golden Lines, the Eye
 * Line, the Free Area and the fallback rungs all sit behind this one call.
 *
 * Today it composes on the `face` rung, sizes and aims on a declared Subject
 * Area, and falls back to frame's own last resorts, the Crop Anchor the request
 * named and then the centre. The rungs that lead on a Match or compose a kart,
 * the Eye Line's zoom and the Free Area arrive on later tickets and add no
 * field this signature does not already declare.
 */
export function frameCrop(input: FrameInput): Framing {
  const { annotation, request } = input;

  if (request.occlusion.length > MAX_OCCLUSION_ZONES) {
    throw new RangeError(
      `a FramingRequest may declare at most ${MAX_OCCLUSION_ZONES} occlusion zones, not ${request.occlusion.length}`
    );
  }

  const source = { width: annotation.width, height: annotation.height };
  const composed = composeSubject(annotation, request);
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

  // The cover window is the size for every other rung, and the ceiling for this
  // one: nothing grows the window past the largest one the picture holds.
  const size = area?.size ?? coverWindow(source, request.target);

  const cropWindow = composed
    ? placeAtAim(
        composed.subject,
        size,
        source,
        area?.aim ?? goldenAim(composed.subject)
      )
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
  };
}
