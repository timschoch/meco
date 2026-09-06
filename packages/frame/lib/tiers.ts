import type { Match } from "@meco/contracts";
import type { ComposedSubject } from "./framing";

/**
 * A Region id split the way the schema writes it: `<kind>-<n>`, `n` from 1
 * (`packages/contracts/lib/annotation.ts`).
 */
const partsOf = (regionId: string): [kind: string, n: number] => {
  const at = regionId.lastIndexOf("-");

  return [regionId.slice(0, at), Number(regionId.slice(at + 1))];
};

/**
 * Region id order: the kind as text, then the number as a number. The number
 * has to be compared as one, or `vehicle-10` sorts before `vehicle-2`.
 *
 * Read off the id, never off the position in `annotation.regions`.
 * `assignRegionIds` does hand the Regions over in id order, but
 * `Annotation.parse` promises nothing about the order they arrive in, and every
 * rule here names the id rather than the array.
 */
export const byRegionId = (a: string, b: string): number => {
  const [kindA, nA] = partsOf(a);
  const [kindB, nB] = partsOf(b);

  return kindA === kindB ? nA - nB : kindA.localeCompare(kindB, "en");
};

/**
 * The Matches this request may see. `identify` scopes them to one Brand
 * already; frame checks anyway, because a Match crossing the Brand wall would
 * show as a stranger leading somebody else's Crop, and that is a leak rather
 * than a wrong rectangle.
 *
 * Applied once for the whole ladder rather than inside the `match` rung, since
 * the tiers below are every rung's answer and they need the same set. Whether a
 * Match names a Region worth leading on is the `match` rung's question and is
 * asked there.
 */
export const matchesForBrand = (matches: Match[], brand: string): Match[] =>
  matches.filter((match) => match.brand === brand);

/**
 * The kept Regions in tier order: the Leading Subject, then a matched
 * non-leading Region, then every other kept Region, each group by Region id.
 *
 * One rule for every rung rather than one the `match` rung alone kept, so that
 * the drop rung has a single promise to read: the cheapest Subject to sacrifice
 * is the last one. A Match keeps its middle tier whichever rung
 * answered — the `face` rung can answer a request whose Matches were all
 * excluded by `persons`, and those faces are still the ones worth keeping.
 *
 * `kart` keeps `person` and `vehicle` Regions, which no Match names, so its
 * middle tier is empty and its answer is the leader followed by the rest.
 */
export const inTierOrder = (
  composed: ComposedSubject,
  matched: Set<string>
): ComposedSubject => {
  const behind = composed.keptRegionIds
    .filter((id) => id !== composed.leadRegionId)
    .sort(byRegionId);

  return {
    ...composed,
    keptRegionIds: [
      composed.leadRegionId,
      ...behind.filter((id) => matched.has(id)),
      ...behind.filter((id) => !matched.has(id)),
    ],
  };
};
