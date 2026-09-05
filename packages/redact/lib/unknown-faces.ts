import type { Match, Region } from "@meco/contracts";

/**
 * The Unknown Faces of one call: every face Region that no Match names.
 *
 * The whole policy of the module, in one function and away from the pixels, so
 * that a change to matching cannot break the mask and a change to the mask
 * cannot change who is hidden.
 *
 * There is no threshold here and no Person. A similarity under identify's
 * threshold arrives as the absence of a Match, so an Uncompared Face and a face
 * identify refused are the same case: hidden. An empty `matches` therefore
 * hides every face, which is the answer a caller that skipped identify must
 * get.
 *
 * Only `kind: "face"`. A `person` Region is a body and is never an Unknown
 * Face, even under a face that is one.
 *
 * Sorted by `id`, as a string: the ids are the caller's to read back against
 * the Annotation, and a fixed order is what makes the Redaction Records
 * comparable between two runs.
 */
export const unknownFaces = (
  regions: readonly Region[],
  matches: readonly Match[]
): Region[] => {
  const named = new Set(matches.map((match) => match.regionId));
  return regions
    .filter((region) => region.kind === "face" && !named.has(region.id))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
};
