import type { Region } from "./annotation";

/**
 * What an adapter returns: a Region before contracts numbers it. An adapter
 * cannot know an id, because the id depends on every other adapter's Regions.
 */
export type AdapterRegion = Omit<Region, "id">;

/**
 * The sort key behind every id. The first four entries are the rule: `kind`,
 * then `box.y`, `box.x`, `box.width`. The rest only settle Regions that share
 * all four — two adapters finding the same box — so that no id can depend on
 * the order the adapters ran in.
 *
 * `kind` sorts as a string rather than by its position in the Region Kind
 * enum, so inserting a kind into that enum never reorders anyone else's
 * Regions.
 */
const sortKey = (r: AdapterRegion): (string | number)[] => [
  r.kind,
  r.box.y,
  r.box.x,
  r.box.width,
  r.box.height,
  -r.score,
  r.label,
  r.model.name,
  r.model.version,
];

const compare = (a: AdapterRegion, b: AdapterRegion): number => {
  const left = sortKey(a);
  const right = sortKey(b);
  for (let i = 0; i < left.length; i++) {
    if (left[i]! < right[i]!) return -1;
    if (left[i]! > right[i]!) return 1;
  }
  return 0;
};

/**
 * Numbers the union of every adapter's Regions: `<kind>-<n>`, `n` from 1
 * within each kind, after sorting by {@link sortKey}. The same Regions in any
 * order give the same Regions back, in the same order, with the same ids —
 * which is what lets `identify` key on `(hash, regionId, brand)`.
 *
 * The input is not read after it is copied, and no input object is written to.
 */
export const assignRegionIds = (regions: AdapterRegion[]): Region[] => {
  const counts = new Map<string, number>();
  return [...regions].sort(compare).map((region) => {
    const n = (counts.get(region.kind) ?? 0) + 1;
    counts.set(region.kind, n);
    return { ...region, id: `${region.kind}-${n}` };
  });
};
