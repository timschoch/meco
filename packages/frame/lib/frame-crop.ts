import { DEFAULT_ANCHOR } from "@meco/contracts";
import { MAX_OCCLUSION_ZONES, type FrameInput, type Framing } from "./framing";
import { coverWindow, placeAtAnchor, toFraction } from "./window";

/**
 * The whole module. Subject composition, the ladder, the Golden Lines, the Eye
 * Line, the Free Area and the fallback rungs all sit behind this one call.
 *
 * Today it answers on frame's own last resorts alone: the Crop Anchor the
 * request named, then the centre. The `pinTo` rungs that compose a Subject
 * from Regions arrive on later tickets and add no field this signature does
 * not already declare.
 */
export function frameCrop(input: FrameInput): Framing {
  const { annotation, request } = input;

  if (request.occlusion.length > MAX_OCCLUSION_ZONES) {
    throw new RangeError(
      `a FramingRequest may declare at most ${MAX_OCCLUSION_ZONES} occlusion zones, not ${request.occlusion.length}`
    );
  }

  const source = { width: annotation.width, height: annotation.height };
  const cropWindow = placeAtAnchor(
    coverWindow(source, request.target),
    source,
    // The two rungs place identically when the caller named the centre; what
    // differs is what frame reports, and that is the caller's word for it.
    request.anchor ?? DEFAULT_ANCHOR
  );
  const windowFraction = toFraction(cropWindow, source);

  return {
    window: cropWindow,
    windowFraction,
    resolvedBy: request.anchor === undefined ? "center" : "anchor",
    // Nothing was composed, so everything the window holds is the Subject. A
    // point would say it better and cannot be said: a contracts `Box` has
    // `width` and `height` above zero.
    subject: windowFraction,
    keptRegionIds: [],
    droppedRegionIds: [],
    satisfied: true,
  };
}
