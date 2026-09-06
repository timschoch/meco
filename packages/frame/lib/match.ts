import type { FramingRequest, Match, Region } from "@meco/contracts";
import type { ComposedSubject } from "./framing";
import { byRegionId } from "./tiers";

/**
 * The Match that leads: the highest `similarity`, then the lowest Region id.
 *
 * Similarity and not the largest face, because it says who meco is surest of
 * and does not move as people walk about — largest would let the framing wobble
 * across a burst of photographs.
 */
const leadingMatch = (candidates: Match[]): Match | undefined =>
  candidates.reduce<Match | undefined>((best, candidate) => {
    if (best === undefined) return candidate;
    if (candidate.similarity !== best.similarity) {
      return candidate.similarity > best.similarity ? candidate : best;
    }

    return byRegionId(candidate.regionId, best.regionId) < 0 ? candidate : best;
  }, undefined);

/**
 * The `match` rung: a Crop framed on one named individual in a crowd, which is
 * why Person matching exists at all. When a face Region carries a Match for
 * this Brand, that face leads however small it is.
 *
 * `persons` narrows who may lead and nothing else. A photograph that matched
 * somebody, but nobody on the list, composes nothing here and falls through to
 * the next `pinTo` entry rather than leading on the unlisted Match: a caller
 * who named `persons` asked for those people, and choosing the window around a
 * different named person would leak who else is in the picture. An empty list
 * is legal and means no Match may lead.
 *
 * The Subject is the leading face's box alone, on the same reasoning as the
 * `face` rung: the Eye Line criterion was measured on face boxes.
 *
 * `matches` arrives already scoped to the request's Brand, and the kept Regions
 * are put in tier order by the ladder, so neither rule is this rung's to keep.
 * Whether a Match names a face this picture actually holds is this rung's
 * question, because a Match naming anything else has no face box to frame —
 * and asking it is what leaves the leader's own Region certain to exist.
 */
export const matchSubject = (
  regions: Region[],
  matches: Match[],
  request: FramingRequest
): ComposedSubject | undefined => {
  const faces = regions.filter((region) => region.kind === "face");
  const faceIds = new Set(faces.map((face) => face.id));

  const { persons } = request;
  const mayLead = matches.filter(
    (match) =>
      faceIds.has(match.regionId) &&
      (persons === undefined || persons.includes(match.personId))
  );

  const leader = leadingMatch(mayLead);
  if (leader === undefined) return undefined;

  return {
    resolvedBy: "match",
    leadRegionId: leader.regionId,
    subject: faces.find((face) => face.id === leader.regionId)!.box,
    keptRegionIds: faces.map((face) => face.id),
  };
};
