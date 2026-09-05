import { describe, expect, it } from "vitest";
import { isComplete } from "../index";
import { annotation, detector, objects, printer } from "./samples";

describe("isComplete", () => {
  it("is true when every required Model ran", () => {
    expect(isComplete(annotation, [detector, printer, objects])).toBe(true);
  });

  it("is true when the Annotation names Models nobody required", () => {
    expect(isComplete(annotation, [detector])).toBe(true);
  });

  it("is false when a required name ran at a different version", () => {
    const swapped = { ...printer, version: "s-gamma-05-2" };
    expect(isComplete(annotation, [detector, swapped])).toBe(false);
  });

  it("is false when a required Model never ran", () => {
    expect(isComplete(annotation, [{ name: "yolo", version: "1" }])).toBe(
      false
    );
  });

  it("is true for an empty requirement", () => {
    expect(isComplete(annotation, [])).toBe(true);
  });
});
