import type { FramingRequest, Match, Region } from "@meco/contracts";
import type { ComposedSubject } from "./framing";

/**
 * A Region id's number. The schema is `<kind>-<n>`, `n` from 1
 * (`packages/contracts/lib/annotation.ts`), and every candidate here is a face,
 * so the number is the whole of what "lowest Region id" means. Compared as a
 * number and not as text, which puts `face-10` before `face-2`.
 *
 * Read off the id, never off the position in `annotation.regions`.
 * `assignRegionIds` does hand the Regions over in id order, but
 * `Annotation.parse` promises nothing about the order they arrive in, and both
 * rules below name the id rather than the array.
 */
const numberIn = (regionId: string): number =>
  Number(regionId.slice(regionId.lastIndexOf("-") + 1));

/**
 * The Matches this request is allowed to use: made for its Brand, and about a
 * face this picture actually holds.
 *
 * `identify` guarantees the Brand already. frame checks anyway, because a Match
 * crossing the Brand wall would show as a stranger leading somebody else's
 * Crop, and that is a leak rather than a wrong rectangle. The Region check is
 * the same argument one step down: a Match naming nothing in the picture has no
 * box to frame, so there is nothing to do with it but ignore it — and it is
 * what leaves the leader's own Region certain to exist.
 */
const matchesFrameMayUse = (
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
 */
const leadingMatch = (candidates: Match[]): Match | undefined =>
  candidates.reduce<Match | undefined>((best, candidate) => {
    if (best === undefined) return candidate;
    if (candidate.similarity !== best.similarity) {
      return candidate.similarity > best.similarity ? candidate : best;
    }

    return numberIn(candidate.regionId) < numberIn(best.regionId)
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
  const usable = matchesFrameMayUse(faces, matches, request.brand);

  const { persons } = request;
  const mayLead =
    persons === undefined
      ? usable
      : usable.filter((match) => persons.includes(match.personId));

  const leader = leadingMatch(mayLead);
  if (leader === undefined) return undefined;

  const lead = faces.find((face) => face.id === leader.regionId)!;

  // The three tiers, and the order is all there is to them: the Leading
  // Subject, a matched non-leading face, every other face. Only the drop rung
  // (#108) consults them, and it sacrifices from the end. Every Match counts as
  // a matched face here whatever `persons` said, because `persons` decides who
  // leads and not who is kept.
  const matched = new Set(usable.map((match) => match.regionId));
  const behind = faces
    .filter((face) => face.id !== lead.id)
    .sort((a, b) => numberIn(a.id) - numberIn(b.id));

  return {
    resolvedBy: "match",
    leadRegionId: lead.id,
    subject: lead.box,
    keptRegionIds: [
      lead.id,
      ...behind.filter((face) => matched.has(face.id)).map((face) => face.id),
      ...behind.filter((face) => !matched.has(face.id)).map((face) => face.id),
    ],
  };
};
