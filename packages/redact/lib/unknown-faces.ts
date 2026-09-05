import type { Match, Region } from "@meco/contracts";

/**
 * The Unknown Faces of one call: every face Region that no Match names.
 *
 * Its own function, away from the pixels, per
 * [ADR-0008](../../../docs/adr/0008-redact-blurs-the-source-before-the-cut.md).
 * No threshold and no Person reach it: a similarity identify refused arrives as
 * the absence of a Match, so an empty `matches` hides every face.
 *
 * Sorted by `id` as a string, so two runs report the same Records in the same
 * order.
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
