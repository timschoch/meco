import { describe, expect, it } from "vitest";
import { Box, Point, Size } from "../index";

describe("Box", () => {
  it("parses a rectangle given in fractions", () => {
    const box = { x: 0.1, y: 0.2, width: 0.5, height: 0.25 };
    expect(Box.parse(box)).toEqual(box);
  });

  it("refuses w and h in place of width and height", () => {
    expect(Box.safeParse({ x: 0.1, y: 0.2, w: 0.5, h: 0.25 }).success).toBe(
      false
    );
  });

  it("refuses a rectangle of no area", () => {
    expect(
      Box.safeParse({ x: 0.1, y: 0.2, width: 0, height: 0.25 }).success
    ).toBe(false);
  });
});

describe("Point", () => {
  it("refuses a coordinate outside the image", () => {
    expect(Point.safeParse({ x: 1.2, y: 0.5 }).success).toBe(false);
  });
});

describe("Size", () => {
  it("counts whole pixels, never fractions", () => {
    expect(Size.parse({ width: 1080, height: 1350 })).toEqual({
      width: 1080,
      height: 1350,
    });
    expect(Size.safeParse({ width: 0.5, height: 0.5 }).success).toBe(false);
  });
});
