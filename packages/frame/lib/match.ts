import type { FramingRequest, Match, Region } from "@meco/contracts";
import type { ComposedSubject } from "./framing";

/**
 * The Matches this request is allowed to see: made for its Brand, and about a
 * face this picture actually holds.
 *
 * `identify` guarantees the Brand already. frame checks anyway, because a Match
 * crossing the Brand wall would show as a stranger leading somebody else's
 * Crop, and that is a leak rather than a wrong rectangle. The Region check is
 * the same argument one step down: a Match naming nothing in the picture has no
 * box to frame, so there is nothing to do with it but ignore it.
 */
const matchesAboutTheseFaces = (
  faces: Region[],
  matches: Match[],
  brand: string
): Match[] => {
  const faceIds = new Set(faces.map((face) => face.id));

  return matches.filter(
    (match) => match.brand === brand && faceIds.has(match.regionId)
  );
};

/**
 * The Match that leads: the highest `similarity`, then the lowest Region id.
 *
 * Similarity and not the largest face, because it says who meco is surest of
 * and does not move as people walk about — largest would let the framing wobble
 * across a burst of photographs.
 *
 * "Lowest Region id" is read off `order`, the position contracts numbered the
 * Regions in, rather than off the id string: `face-10` sorts before `face-2` as
 * text and after it as a Region. The comparison is strict, so the first of
 * equals in that order wins.
 */
const leadingMatch = (
  candidates: Match[],
  order: Map<string, number>
): Match | undefined =>
  candidates.reduce<Match | undefined>((best, candidate) => {
    if (best === undefined) return candidate;
    if (candidate.similarity !== best.similarity) {
      return candidate.similarity > best.similarity ? candidate : best;
    }

    return order.get(candidate.regionId)! < order.get(best.regionId)!
      ? candidate
      : best;
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
 */
export const matchSubject = (
  regions: Region[],
  matches: Match[],
  request: FramingRequest
): ComposedSubject | undefined => {
  const faces = regions.filter((region) => region.kind === "face");
  const ours = matchesAboutTheseFaces(faces, matches, request.brand);

  const { persons } = request;
  const mayLead =
    persons === undefined
      ? ours
      : ours.filter((match) => persons.includes(match.personId));

  const order = new Map(regions.map((region, at) => [region.id, at]));
  const leader = leadingMatch(mayLead, order);
  if (leader === undefined) return undefined;

  const lead = faces.find((face) => face.id === leader.regionId)!;

  // The three tiers, and the order is all there is to them: the Leading
  // Subject, a matched non-leading face, every other face. Only the drop rung
  // (#108) consults them, and it sacrifices from the end. Every Match is a
  // matched face here whatever `persons` said, because `persons` decides who
  // leads and not who is kept.
  const matched = new Set(ours.map((match) => match.regionId));
  const others = faces.filter((face) => face.id !== lead.id);

  return {
    resolvedBy: "match",
    leadRegionId: lead.id,
    subject: lead.box,
    keptRegionIds: [
      lead.id,
      ...others.filter((face) => matched.has(face.id)).map((face) => face.id),
      ...others.filter((face) => !matched.has(face.id)).map((face) => face.id),
    ],
  };
};
