import { describe, expect, it } from "vitest";
import type { CropAnchor } from "@meco/contracts";
import { MAX_OCCLUSION_ZONES, frameCrop } from "../index";
import { emptyAnnotation, requestFor } from "./samples";

// Both sources cut a 800x800 window at a 1:1 target, so one of the two axes
// has 400 px of slack and the other none. The expected offsets are written out
// rather than re-derived, so a mutation of the anchor table cannot mutate the
// expectation with it.
const LANDSCAPE = { width: 1200, height: 800 };
const PORTRAIT = { width: 800, height: 1200 };
const SQUARE_TARGET = { width: 1080, height: 1080 };

const PLACEMENTS: { anchor: CropAnchor; x: number; y: number }[] = [
  { anchor: "top-left", x: 0, y: 0 },
  { anchor: "top", x: 200, y: 0 },
  { anchor: "top-right", x: 400, y: 0 },
  { anchor: "left", x: 0, y: 200 },
  { anchor: "center", x: 200, y: 200 },
  { anchor: "right", x: 400, y: 200 },
  { anchor: "bottom-left", x: 0, y: 400 },
  { anchor: "bottom", x: 200, y: 400 },
  { anchor: "bottom-right", x: 400, y: 400 },
];

describe("nothing composed, no anchor named", () => {
  const framing = frameCrop({
    annotation: emptyAnnotation(LANDSCAPE),
    request: requestFor(SQUARE_TARGET),
  });

  it("centres the largest window of the target shape", () => {
    expect(framing.window).toEqual({ x: 200, y: 0, width: 800, height: 800 });
  });

  it("says the centre answered, and names no leading Region", () => {
    expect(framing.resolvedBy).toBe("center");
    expect(framing.leadRegionId).toBeUndefined();
  });

  it("is satisfied, on no rung of the fallback ladder", () => {
    expect(framing.satisfied).toBe(true);
    expect(framing.fallback).toBeUndefined();
  });

  it("keeps and drops no Region, because there is none", () => {
    expect(framing.keptRegionIds).toEqual([]);
    expect(framing.droppedRegionIds).toEqual([]);
  });

  // Nothing was composed, so everything the window holds is the Subject. The
  // spec's words are "a zero-extent Subject placed at its own point", which no
  // contracts `Box` can be: `width` and `height` are `> 0`. Ledgered on #101.
  it("reports the window itself as the Subject", () => {
    expect(framing.subject).toEqual(framing.windowFraction);
  });

  it("claims nothing about a Subject Area or an Occlusion Zone nobody named", () => {
    expect(framing.subjectAreaSatisfied).toBeUndefined();
    expect(framing.subjectAreaShortfall).toBeUndefined();
    expect(framing.occlusionClear).toBeUndefined();
  });
});

describe("each of the nine Crop Anchors", () => {
  for (const { anchor, x, y } of PLACEMENTS) {
    it(`puts the window where "${anchor}" says, on the axis with slack`, () => {
      const across = frameCrop({
        annotation: emptyAnnotation(LANDSCAPE),
        request: requestFor(SQUARE_TARGET, { anchor }),
      });
      const down = frameCrop({
        annotation: emptyAnnotation(PORTRAIT),
        request: requestFor(SQUARE_TARGET, { anchor }),
      });

      expect(across.window).toEqual({ x, y: 0, width: 800, height: 800 });
      expect(down.window).toEqual({ x: 0, y, width: 800, height: 800 });
    });

    it(`says the anchor answered for "${anchor}"`, () => {
      const framing = frameCrop({
        annotation: emptyAnnotation(LANDSCAPE),
        request: requestFor(SQUARE_TARGET, { anchor }),
      });

      expect(framing.resolvedBy).toBe("anchor");
      expect(framing.leadRegionId).toBeUndefined();
    });
  }
});

// The wall is the contracts schema's, which the gateway enforces at the edge.
// This is the defensive invariant underneath it: the Free Area sweep is
// polynomial in the zone count, so an unbounded list is work to refuse.
describe("the Occlusion Zone cap", () => {
  it("refuses more zones than the sweep can afford", () => {
    const zones = Array.from({ length: MAX_OCCLUSION_ZONES + 1 }, (_, i) => ({
      x: 0,
      y: i / 100,
      width: 0.1,
      height: 0.01,
    }));

    expect(() =>
      frameCrop({
        annotation: emptyAnnotation(LANDSCAPE),
        // Past the contracts cap, so the schema would refuse it first: built
        // here by hand to reach the guard the gateway is meant to keep frame
        // from ever seeing.
        request: { ...requestFor(SQUARE_TARGET), occlusion: zones },
      })
    ).toThrow(RangeError);
  });
});
