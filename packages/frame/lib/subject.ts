import type {
  Annotation,
  FramingRequest,
  Match,
  Region,
} from "@meco/contracts";
import { regionWithLargestBox } from "./boxes";
import type { ComposedSubject } from "./framing";
import { kartSubject } from "./kart";
import { matchSubject } from "./match";
import { inTierOrder, matchesForBrand } from "./tiers";

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
 * One rung, asked what it composes. A rung that yields nothing is walked past,
 * and the next entry of `pinTo` is asked instead.
 *
 * Only `match` reads the Matches, and it is the only rung that reads the
 * request at all. The other two compose from the bytes alone, which is why they
 * take Regions and nothing else.
 */
const composeRung = (
  rung: FramingRequest["pinTo"][number],
  regions: Region[],
  matches: Match[],
  request: FramingRequest
): ComposedSubject | undefined => {
  switch (rung) {
    case "match":
      return matchSubject(regions, matches, request);
    case "face":
      return faceSubject(regions);
    case "kart":
      return kartSubject(regions);
  }
};

/**
 * Walks `pinTo` in order. The first rung that composes a Subject wins and
 * decides `resolvedBy`; nothing composed leaves frame's own last resorts, the
 * Crop Anchor and the centre, to answer.
 *
 * The Brand wall is applied once, for the whole ladder, and whatever the
 * answering rung kept comes back in tier order. Both rules belong to the ladder
 * rather than to a rung: a rung that kept its own tier order would make
 * "cheapest last" three promises for the drop rung (#108) to check instead of
 * one.
 */
export function composeSubject(
  annotation: Annotation,
  matches: Match[],
  request: FramingRequest
): ComposedSubject | undefined {
  const ours = matchesForBrand(matches, request.brand);
  const matched = new Set(ours.map((match) => match.regionId));

  for (const rung of request.pinTo) {
    const composed = composeRung(rung, annotation.regions, ours, request);
    if (composed !== undefined) return inTierOrder(composed, matched);
  }

  return undefined;
}
