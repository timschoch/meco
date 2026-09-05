import { describe, expect, it } from "vitest";
import { PHI_LINES, frameCrop } from "../index";
import { SOURCES, TARGETS, requestFor, emptyAnnotation } from "./samples";

/** Every shape pair, named by what a red run should print. */
const CASES = SOURCES.flatMap((source) =>
  TARGETS.map(({ name, target }) => ({
    name: `${source.width}x${source.height} at ${name}`,
    source,
    target,
    frame: () =>
      frameCrop({
        annotation: emptyAnnotation(source),
        request: requestFor(target),
      }),
  }))
);

describe("the window, whatever the shapes", () => {
  for (const { name, source, target, frame } of CASES) {
    it(`is whole pixels: ${name}`, () => {
      const { x, y, width, height } = frame().window;
      for (const value of [x, y, width, height]) {
        expect(Number.isInteger(value)).toBe(true);
      }
      expect(width).toBeGreaterThan(0);
      expect(height).toBeGreaterThan(0);
    });

    it(`lies inside the Source Image: ${name}`, () => {
      const { x, y, width, height } = frame().window;
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(x + width).toBeLessThanOrEqual(source.width);
      expect(y + height).toBeLessThanOrEqual(source.height);
    });

    it(`is within one pixel of the target aspect, on both axes: ${name}`, () => {
      const { width, height } = frame().window;
      const aspect = target.width / target.height;
      // Both residuals, not the kinder of the two: rounding lands on one axis,
      // and asking only that axis would pass a window rounded the wrong way.
      expect(Math.abs(width - height * aspect)).toBeLessThanOrEqual(1);
      expect(Math.abs(height - width / aspect)).toBeLessThanOrEqual(1);
    });

    it(`is the largest window of that shape, so it touches an edge: ${name}`, () => {
      const { width, height } = frame().window;
      expect(width === source.width || height === source.height).toBe(true);
    });

    it(`reports windowFraction as the window over the source size: ${name}`, () => {
      const { window, windowFraction } = frame();
      expect(windowFraction).toEqual({
        x: window.x / source.width,
        y: window.y / source.height,
        width: window.width / source.width,
        height: window.height / source.height,
      });
    });
  }
});

describe("frameCrop is pure", () => {
  for (const { name, frame } of CASES) {
    it(`answers the same twice: ${name}`, () => {
      expect(frame()).toEqual(frame());
    });
  }
});

describe("PHI_LINES", () => {
  it("are the two Golden Lines, in order", () => {
    // Written out rather than re-derived from φ, so the check is independent
    // of the arithmetic it checks.
    expect(PHI_LINES[0]).toBeCloseTo(0.3819660112501051, 15);
    expect(PHI_LINES[1]).toBeCloseTo(0.6180339887498949, 15);
    expect(PHI_LINES[0] + PHI_LINES[1]).toBeCloseTo(1, 15);
  });
});
