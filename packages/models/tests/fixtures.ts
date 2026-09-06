// The fixture photographs and their hand-marked answers, read by path. Private
// to tests/ by the boundary rules.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Box, DecodedImage, Region } from "@meco/contracts";

const FACES = new URL("../../../fixtures/faces/", import.meta.url);

export const fixture = (file: string): Promise<Buffer> =>
  readFile(new URL(file, FACES));

export const fixturePath = (file: string): string =>
  fileURLToPath(new URL(file, FACES));

/** The shape of `fixtures/faces/expected.json`, as far as these tests read it. */
export interface Expected {
  /** The largest allowed distance between a hand-marked centre and the found one. */
  tolerance: number;
  images: {
    file: string;
    note: string;
    faces: { label: string; box: Box }[];
  }[];
}

export const expectedFaces = async (): Promise<Expected> =>
  JSON.parse(
    await readFile(new URL("expected.json", FACES), "utf8")
  ) as Expected;

/** A 4 by 4 mid-grey image: the blank the adapter checks run on. */
export const blankImage = (): DecodedImage => ({
  width: 4,
  height: 4,
  channels: 3,
  data: new Uint8Array(4 * 4 * 3).fill(128),
});

/** Share of the union two boxes have in common. */
export const iou = (a: Box, b: Box): number => {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= left || bottom <= top) return 0;
  const overlap = (right - left) * (bottom - top);
  return overlap / (a.width * a.height + b.width * b.height - overlap);
};

/** How far apart two boxes' centres are, as the larger of the two axes. */
export const centreDistance = (a: Box, b: Box): number =>
  Math.max(
    Math.abs(a.x + a.width / 2 - (b.x + b.width / 2)),
    Math.abs(a.y + a.height / 2 - (b.y + b.height / 2))
  );

/** The golden rule: a hand-marked face is found when both of these hold. */
export const MIN_IOU = 0.5;

/**
 * Pairs every hand-marked face with the found Region nearest to it, each
 * Region claimed once. Two marks collapsing onto one box is the suppression
 * bug that would otherwise pass.
 */
export function matchGolden(
  marked: { label: string; box: Box }[],
  found: Pick<Region, "box">[]
): { label: string; iou: number; centre: number }[] {
  const unclaimed = new Set(found);
  return marked.map(({ label, box }) => {
    let best: Pick<Region, "box"> | undefined;
    let bestIou = -1;
    for (const region of unclaimed) {
      const overlap = iou(box, region.box);
      if (overlap > bestIou) {
        bestIou = overlap;
        best = region;
      }
    }
    if (best) unclaimed.delete(best);
    return {
      label,
      iou: Math.max(0, bestIou),
      centre: best ? centreDistance(box, best.box) : Infinity,
    };
  });
}
