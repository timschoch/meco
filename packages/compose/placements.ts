// Entry point. The closed catalogue of output sizes, owned by compose.
//
// The gateway imports this file directly so it can offer the catalogue without
// pulling the renderer in. `index.ts` re-exports the same object.

/** The Placements compose knows. Closed: a Channel size is a fact, not a knob. */
export const PLACEMENT_IDS = [
  "linkedin/post",
  "linkedin/wide",
  "instagram/post",
  "instagram/story",
  "x/post",
  "facebook/post",
  "facebook/story",
] as const;

export type PlacementId = (typeof PLACEMENT_IDS)[number];

/** One row of the catalogue: what a Channel's name means in pixels. */
export interface Placement {
  readonly id: PlacementId;
  readonly width: number;
  readonly height: number;
}

/**
 * The seven Placements, carried over from the prototype on the measurement that
 * nothing in them was wrong. Each row is a fact about a Channel.
 */
export const PLACEMENTS: readonly Placement[] = [
  { id: "linkedin/post", width: 1200, height: 1200 },
  { id: "linkedin/wide", width: 1200, height: 627 },
  { id: "instagram/post", width: 1080, height: 1350 },
  { id: "instagram/story", width: 1080, height: 1920 },
  { id: "x/post", width: 1600, height: 900 },
  { id: "facebook/post", width: 1200, height: 630 },
  { id: "facebook/story", width: 1080, height: 1920 },
];

const BY_ID = new Map<string, Placement>(PLACEMENTS.map((p) => [p.id, p]));

/** The Placement with this id, or `undefined` when the id is not in the catalogue. */
export function placement(id: string): Placement | undefined {
  return BY_ID.get(id);
}
