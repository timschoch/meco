import { describe, expect, it } from "vitest";
import { Region, assignRegionIds } from "../index";
import {
  expectedIds,
  orderedAdapterRegions,
  sameBoxFromTwoModels,
  shuffledAdapterRegions,
} from "./adapter-regions";

describe("assignRegionIds", () => {
  it("numbers each kind from 1 in sorted order", () => {
    const ids = assignRegionIds(orderedAdapterRegions()).map((r) => r.id);
    expect(ids).toEqual(expectedIds);
  });

  it("gives shuffled input the same Regions as sorted input", () => {
    expect(assignRegionIds(shuffledAdapterRegions())).toEqual(
      assignRegionIds(orderedAdapterRegions())
    );
  });

  it("returns Regions that parse", () => {
    for (const region of assignRegionIds(shuffledAdapterRegions())) {
      expect(Region.parse(region)).toEqual(region);
    }
  });

  it("does not mutate its input", () => {
    const input = shuffledAdapterRegions();
    const before = structuredClone(input);
    assignRegionIds(input);
    expect(input).toEqual(before);
    expect(input[0]).not.toHaveProperty("id");
  });

  it("orders two Models that found the same box the same way round", () => {
    const [first, second] = sameBoxFromTwoModels();
    expect(assignRegionIds([first!, second!])).toEqual(
      assignRegionIds([second!, first!])
    );
  });

  it("returns an empty array for no regions", () => {
    expect(assignRegionIds([])).toEqual([]);
  });
});
