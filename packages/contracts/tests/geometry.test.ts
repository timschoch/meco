import { describe, expect, it } from "vitest";
import { Box } from "../index";

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
});
