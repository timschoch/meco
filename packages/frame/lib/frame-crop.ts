import { DEFAULT_ANCHOR } from "@meco/contracts";
import { MAX_OCCLUSION_ZONES, type FrameInput, type Framing } from "./framing";
import { placeOnGoldenLines } from "./golden-lines";
import { composeSubject } from "./subject";
import { coverWindow, placeAtAnchor, toFraction } from "./window";

/**
 * The whole module. Subject composition, the ladder, the Golden Lines, the Eye
 * Line, the Free Area and the fallback rungs all sit behind this one call.
 *
 * Today it composes on the `face` rung and falls back to frame's own last
 * resorts, the Crop Anchor the request named and then the centre. The rungs
 * that lead on a Match or compose a kart, the Eye Line's zoom, the Subject
 * Area and the Free Area arrive on later tickets and add no field this
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
  // The cover window is the size for every rung here. A Subject Area (#106)
  // and the Eye Line (#103) are the only things that grow it, and neither is
  // built yet.
  const size = coverWindow(source, request.target);
  const composed = composeSubject(annotation, request);

  const cropWindow = composed
    ? placeOnGoldenLines(composed.subject, size, source)
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
  };
}
