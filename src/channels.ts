/**
 * Channels and Placements. See CONTEXT.md.
 *
 * A Channel is a place a Render is published. A Placement is a way of posting
 * within a Channel, and is the thing that fixes the output size. Naming a bare
 * Channel fans out to every Placement it offers.
 */

export type PlacementId = `${string}/${string}`;

export interface Placement {
  /** `<channel>/<placement>`, e.g. `instagram/story`. */
  id: PlacementId;
  channel: string;
  name: string;
  width: number;
  height: number;
  /** Shown in the discovery endpoint so callers know what they are asking for. */
  description: string;
}

const PLACEMENT_LIST: Placement[] = [
  {
    id: "linkedin/post",
    channel: "linkedin",
    name: "post",
    width: 1200,
    height: 1200,
    description: "LinkedIn square feed image",
  },
  {
    id: "linkedin/wide",
    channel: "linkedin",
    name: "wide",
    width: 1200,
    height: 627,
    description: "LinkedIn landscape link/feed image",
  },
  {
    id: "instagram/post",
    channel: "instagram",
    name: "post",
    width: 1080,
    height: 1350,
    description: "Instagram portrait feed post",
  },
  {
    id: "instagram/story",
    channel: "instagram",
    name: "story",
    width: 1080,
    height: 1920,
    description: "Instagram story, full screen vertical",
  },
  {
    id: "x/post",
    channel: "x",
    name: "post",
    width: 1600,
    height: 900,
    description: "X (Twitter) landscape post image",
  },
  {
    id: "facebook/post",
    channel: "facebook",
    name: "post",
    width: 1200,
    height: 630,
    description: "Facebook landscape feed image",
  },
  {
    id: "facebook/story",
    channel: "facebook",
    name: "story",
    width: 1080,
    height: 1920,
    description: "Facebook story, full screen vertical",
  },
];

export const PLACEMENTS: ReadonlyMap<PlacementId, Placement> = new Map(
  PLACEMENT_LIST.map((p) => [p.id, p]),
);

export const CHANNELS: ReadonlyArray<string> = [
  ...new Set(PLACEMENT_LIST.map((p) => p.channel)),
];

/**
 * Resolve what the caller asked for into concrete Placements.
 *
 * A bare channel (`"instagram"`) fans out to all of its Placements; a full id
 * (`"instagram/story"`) resolves to exactly that one.
 */
export function resolvePlacements(refs: readonly string[]): Placement[] {
  const out: Placement[] = [];
  const seen = new Set<string>();

  for (const ref of refs) {
    const matches = ref.includes("/")
      ? PLACEMENT_LIST.filter((p) => p.id === ref)
      : PLACEMENT_LIST.filter((p) => p.channel === ref);

    if (matches.length === 0) {
      throw new Error(
        `Unknown channel or placement: "${ref}". ` +
          `Known channels: ${CHANNELS.join(", ")}. ` +
          `Known placements: ${PLACEMENT_LIST.map((p) => p.id).join(", ")}.`,
      );
    }

    for (const p of matches) {
      if (!seen.has(p.id)) {
        seen.add(p.id);
        out.push(p);
      }
    }
  }

  return out;
}

/** Aspect ratio, used to pick a Crop for a Placement's Image Slot. */
export function aspectRatio(p: Placement): number {
  return p.width / p.height;
}
