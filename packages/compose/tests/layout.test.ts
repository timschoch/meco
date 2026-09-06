import { describe, expect, it } from "vitest";
import { layoutConformance, type LayoutFixtures } from "../conformance";
import { decode, KART_FIXTURE } from "./fixture";

/**
 * The two pictures the Plan must be identical for, beside the no-bytes case the
 * checks measure themselves: a flat 9x16 placeholder and a real photograph of a
 * different shape. Both are resampled into the Image Slot before the layout
 * pass, so what varies between them is the content, which is the whole point.
 */
const fixtures: LayoutFixtures = {
  images: [
    {
      width: 900,
      height: 1600,
      channels: 3,
      data: new Uint8Array(900 * 1600 * 3).fill(128),
    },
    await decode(KART_FIXTURE),
  ],
};

/** The rules of `docs/specs/compose.md`, in the order they run. */
const RULES = [
  "places exactly one Image Slot",
  "keeps every Occlusion Zone inside the Image Slot",
  "needs no Occlusion Zone clipped",
  "keeps every text run inside its own box",
  "plans the same whatever the image bytes are",
  "declares a valid Subject Area or none",
  "declares no more Occlusion Zones than a FramingRequest holds",
];

const checks = layoutConformance(fixtures);

describe("the layout suite", () => {
  it("covers every Template at every Placement it declares", () => {
    // One entry per Template x declared Placement x rule. `swisshutless-story`
    // declares two Placements, so a Template added without its checks running
    // shows up here as a wrong count.
    expect(checks.length).toBe(2 * RULES.length);
    expect(checks.map((check) => check.name)).toEqual(
      ["instagram/story", "facebook/story"].flatMap((placement) =>
        RULES.map((rule) => `swisshutless-story at ${placement} ${rule}`)
      )
    );
  });

  it.each(checks)("$name", async (check) => {
    await check.run();
  });
});
