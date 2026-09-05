import { describe, expect, it } from "vitest";
import type { Box } from "@meco/contracts";
import { frameCrop, projectIntoFrame } from "../index";
import { emptyAnnotation, requestFor } from "./samples";

/** The inverse of `projectIntoFrame`, written out so the round trip is a real trip. */
const projectBack = (windowFraction: Box, box: Box): Box => ({
  x: windowFraction.x + box.x * windowFraction.width,
  y: windowFraction.y + box.y * windowFraction.height,
  width: box.width * windowFraction.width,
  height: box.height * windowFraction.height,
});

describe("projectIntoFrame", () => {
  // 1200x800 at 1:1 cuts an 800x800 window centred at x 200, so the window is
  // x 1/6 .. 5/6 of the source and full height.
  const framing = frameCrop({
    annotation: emptyAnnotation({ width: 1200, height: 800 }),
    request: requestFor({ width: 1080, height: 1080 }),
  });

  it("maps a Box inside the window into the frame", () => {
    const middle = projectIntoFrame(framing, {
      x: framing.windowFraction.x,
      y: 0.25,
      width: framing.windowFraction.width / 2,
      height: 0.5,
    });

    expect(middle.x).toBeCloseTo(0, 12);
    expect(middle.y).toBeCloseTo(0.25, 12);
    expect(middle.width).toBeCloseTo(0.5, 12);
    expect(middle.height).toBeCloseTo(0.5, 12);
  });

  it("round-trips a Box inside the window, into [0, 1] and back", () => {
    const boxes: Box[] = [
      { x: 0.2, y: 0.1, width: 0.3, height: 0.4 },
      { x: 1 / 6, y: 0, width: 2 / 3, height: 1 },
      { x: 0.5, y: 0.5, width: 0.2, height: 0.2 },
    ];

    for (const box of boxes) {
      const inFrame = projectIntoFrame(framing, box);

      for (const value of [
        inFrame.x,
        inFrame.y,
        inFrame.x + inFrame.width,
        inFrame.y + inFrame.height,
      ]) {
        expect(value).toBeGreaterThanOrEqual(-1e-9);
        expect(value).toBeLessThanOrEqual(1 + 1e-9);
      }

      const back = projectBack(framing.windowFraction, inFrame);
      expect(back.x).toBeCloseTo(box.x, 9);
      expect(back.y).toBeCloseTo(box.y, 9);
      expect(back.width).toBeCloseTo(box.width, 9);
      expect(back.height).toBeCloseTo(box.height, 9);
    }
  });

  it("reports a Box the window cut away as outside the frame", () => {
    const clipped = projectIntoFrame(framing, {
      x: 0,
      y: 0,
      width: 0.1,
      height: 0.1,
    });

    expect(clipped.x).toBeLessThan(0);
    expect(clipped.x + clipped.width).toBeLessThan(0);
  });
});
