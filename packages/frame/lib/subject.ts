import type { Annotation, Box, FramingRequest, Region } from "@meco/contracts";
import type { ResolvedBy } from "./framing";

/**
 * What a rung of `pinTo` answers with when it composes something. The rung
 * that answers decides all four fields at once, so no caller can pair a
 * `resolvedBy` with another rung's Subject.
 */
export interface ComposedSubject {
  resolvedBy: ResolvedBy;
  leadRegionId: string;
  /** The composed Subject, in source fractions. */
  subject: Box;
  /** Every Region this rung keeps in frame, the leader included. */
  keptRegionIds: string[];
}

const area = (box: Box): number => box.width * box.height;

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
  const lead = faces.reduce<Region | undefined>(
    (best, face) =>
      best === undefined || area(face.box) > area(best.box) ? face : best,
    undefined
  );

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
 * Walks `pinTo` in order. The first rung that composes a Subject wins and
 * decides `resolvedBy`; nothing composed leaves frame's own last resorts, the
 * Crop Anchor and the centre, to answer.
 *
 * `match` (#104) and `kart` (#105) compose nothing yet, so a ladder naming them
 * walks past them to whatever follows.
 */
export function composeSubject(
  annotation: Annotation,
  request: FramingRequest
): ComposedSubject | undefined {
  for (const rung of request.pinTo) {
    const composed =
      rung === "face" ? faceSubject(annotation.regions) : undefined;
    if (composed !== undefined) return composed;
  }

  return undefined;
}
