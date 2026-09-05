import { describe, expect, it } from "vitest";
import { Region } from "../index";
import { face, printer, vehicle } from "./samples";

describe("Region", () => {
  it("parses a face region", () => {
    expect(Region.parse(face)).toEqual(face);
  });

  it("parses a vehicle region, which carries no landmarks", () => {
    expect(Region.parse(vehicle)).toEqual(vehicle);
  });

  it("refuses an id whose prefix is not its kind", () => {
    expect(Region.safeParse({ ...face, id: "person-1" }).success).toBe(false);
  });

  it("refuses an id that is not numbered from 1", () => {
    expect(Region.safeParse({ ...face, id: "face-0" }).success).toBe(false);
  });

  it("refuses a face print on a region that is not a face", () => {
    const print = { model: printer, vector: [0.6, 0.8] };
    expect(Region.safeParse({ ...vehicle, facePrint: print }).success).toBe(
      false
    );
  });

  it("accepts a face print vector that is unit length within 1e-3", () => {
    const print = { model: printer, vector: [0.6, 0.8] };
    expect(Region.safeParse({ ...face, facePrint: print }).success).toBe(true);
  });
});
