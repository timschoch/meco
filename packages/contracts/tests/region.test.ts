import { describe, expect, it } from "vitest";
import { Region } from "../index";

const box = { x: 0.1, y: 0.1, width: 0.2, height: 0.2 };
const point = { x: 0.15, y: 0.15 };
const landmarks = {
  rEye: point,
  lEye: point,
  nose: point,
  rMouth: point,
  lMouth: point,
};
const model = { name: "scrfd", version: "10g-bnkps-1" };

const face = {
  id: "face-1",
  kind: "face",
  label: "face",
  box,
  score: 0.98,
  model,
  landmarks,
};

describe("Region", () => {
  it("parses a face region", () => {
    expect(Region.parse(face)).toEqual(face);
  });

  it("refuses a face without landmarks", () => {
    const { landmarks: _dropped, ...noLandmarks } = face;
    expect(Region.safeParse(noLandmarks).success).toBe(false);
  });

  it("refuses a negative score", () => {
    expect(Region.safeParse({ ...face, score: -0.1 }).success).toBe(false);
  });

  it("refuses an id whose prefix is not its kind", () => {
    expect(Region.safeParse({ ...face, id: "person-1" }).success).toBe(false);
  });

  it("refuses an embedding vector that is not unit length", () => {
    const vector = [0.6, 0.8, 0.1];
    expect(
      Region.safeParse({ ...face, embedding: { model, vector } }).success
    ).toBe(false);
  });

  it("accepts an embedding vector that is unit length within 1e-3", () => {
    const vector = [0.6, 0.8];
    expect(
      Region.safeParse({ ...face, embedding: { model, vector } }).success
    ).toBe(true);
  });
});
