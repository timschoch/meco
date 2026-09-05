import { describe, expect, it } from "vitest";
import { assignRegionIds, Region } from "../index";
import { adapterConformance, type AdapterFixtures } from "../conformance";
import {
  blankImage,
  brokenAdapters,
  driftingAdapter,
  jitteryAdapter,
  passingAdapter,
  patternImage,
  printOnAVehicleAdapter,
  shufflingAdapter,
} from "./fake-adapters";

const fixtures: AdapterFixtures = {
  image: patternImage(),
  blank: blankImage(),
};

/** The eight checks of `docs/specs/contracts.md`, in the order they run. */
const CHECK_NAMES = [
  "every region parses as an Adapter Region",
  "every region carries the adapter's own model",
  "every region's kind is one the adapter declares",
  "the licence text is not empty",
  "the same image twice gives the same regions",
  "a blank image gives no regions and no throw",
  "every face region has landmarks",
  "every face print is unit length",
];

/** Runs every check and answers with the names of the ones that rejected. */
const rejectedBy = async (
  adapter: Parameters<typeof adapterConformance>[0]
) => {
  const rejected: string[] = [];
  for (const check of adapterConformance(adapter, fixtures)) {
    try {
      await check.run();
    } catch {
      rejected.push(check.name);
    }
  }
  return rejected;
};

// The way an adapter author consumes the checks: one `it` per returned Check.
describe("adapterConformance over a passing fake adapter", () => {
  for (const check of adapterConformance(passingAdapter, fixtures)) {
    it(check.name, check.run);
  }
});

describe("adapterConformance", () => {
  const checks = adapterConformance(passingAdapter, fixtures);

  it("returns the eight checks of the spec, in that order", () => {
    expect(checks.map((c) => c.name)).toEqual(CHECK_NAMES);
  });

  it("names every check once", () => {
    expect(new Set(checks.map((c) => c.name)).size).toBe(checks.length);
  });

  for (const { defect, check, adapter } of brokenAdapters) {
    it(`rejects ${defect} by "${check}" and by nothing else`, async () => {
      expect(await rejectedBy(adapter)).toEqual([check]);
    });
  }

  it("rejects a face print on a region that is not a face", async () => {
    expect(await rejectedBy(printOnAVehicleAdapter)).toEqual([
      "every region parses as an Adapter Region",
    ]);
  });

  it("rejects a box that drifts past the 1e-4 tolerance between runs", async () => {
    expect(await rejectedBy(driftingAdapter)).toEqual([
      "the same image twice gives the same regions",
    ]);
  });

  it("accepts a box that differs only in the last bits of a float", async () => {
    expect(await rejectedBy(jitteryAdapter)).toEqual([]);
  });

  it("rejects an adapter that shuffles its output between two runs", async () => {
    expect(await rejectedBy(shufflingAdapter)).toEqual([
      "the same image twice gives the same regions",
    ]);
  });
});

// The host pipeline the fake mirrors: run the adapters, then number the union.
describe("an adapter's regions through assignRegionIds", () => {
  it("become Regions that parse", async () => {
    const regions = assignRegionIds(await passingAdapter.run(fixtures.image));
    expect(regions.map((r) => r.id)).toEqual(["face-1", "vehicle-1"]);
    for (const region of regions) expect(Region.parse(region)).toEqual(region);
  });
});
