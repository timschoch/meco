import type { Annotation, FramingRequest, Region } from "@meco/contracts";
import { regionWithLargestBox } from "./boxes";
import type { ComposedSubject } from "./framing";
import { kartSubject } from "./kart";

/**
 * The `face` rung: every face Region is kept and the largest box leads.
 *
 * The Subject is that box alone. frame never grows it to the `person` Region
 * containing it: the Eye Line criterion was measured on face boxes, and
 * framing on a body is a different composition with no measurement behind it.
 *
 * Two faces of exactly equal area leave the first one leading. That is the
 * lowest Region id without a rule of its own to say so: contracts hands over
 * the Regions in the order it numbered them, so the array order and the id
 * order are the same order.
 */
const faceSubject = (regions: Region[]): ComposedSubject | undefined => {
  const faces = regions.filter((region) => region.kind === "face");
  const lead = regionWithLargestBox(faces);

  return lead === undefined
    ? undefined
    : {
        resolvedBy: "face",
        leadRegionId: lead.id,
        subject: lead.box,
        keptRegionIds: faces.map((face) => face.id),
      };
};

/**
 * One rung, asked what it composes. `match` (#104) composes nothing yet, so a
 * ladder naming it walks past it to whatever follows.
 */
const composeRung = (
  rung: FramingRequest["pinTo"][number],
  regions: Region[]
): ComposedSubject | undefined => {
  switch (rung) {
    case "face":
      return faceSubject(regions);
    case "kart":
      return kartSubject(regions);
    default:
      return undefined;
  }
};

/**
 * Walks `pinTo` in order. The first rung that composes a Subject wins and
 * decides `resolvedBy`; nothing composed leaves frame's own last resorts, the
 * Crop Anchor and the centre, to answer.
 */
export function composeSubject(
  annotation: Annotation,
  request: FramingRequest
): ComposedSubject | undefined {
  for (const rung of request.pinTo) {
    const composed = composeRung(rung, annotation.regions);
    if (composed !== undefined) return composed;
  }

  return undefined;
}
