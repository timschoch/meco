// The Enricher role itself: the seven checks and the mutation each one is
// named for. `tests/edgeface.test.ts` runs the same suite over the real Model;
// here a fake Enricher stands in, so a red run points at the check and not at
// a network.
import { describe, expect, it } from "vitest";
import type { AdapterRegion } from "@meco/contracts";
import {
  type Enricher,
  type EnricherFixtures,
  enricherConformance,
} from "../catalogue";
import { fakeEnricher, fakeFace, fakeVehicle } from "./fakes";
import { blankImage } from "./fixtures";

const FAKE = { name: "fake-print", version: "1" };

const CHECKS = {
  determinism: "the same image and regions twice give the same face prints",
  model: "every face print carries the Enricher's own model",
  refused: "a region it cannot serve comes back unchanged and unprinted",
  unserved: "a region of a kind it does not serve is untouched",
  order: "the output holds the input's regions, in the input's order",
  unit: "every face print is unit length",
  licence: "the licence text is not empty",
} as const;

/** A face whose five landmarks sit on one point: nothing to fit a warp to. */
const flatFace = (): AdapterRegion => {
  const face = fakeFace(FAKE);
  const point = { x: 0.5, y: 0.5 };
  return {
    ...face,
    landmarks: {
      rEye: point,
      lEye: point,
      nose: point,
      rMouth: point,
      lMouth: point,
    },
  };
};

// Two faces, not one: an order mutation that swaps two Regions of the served
// kind is invisible against a single face.
const fixtures = (): EnricherFixtures => ({
  image: blankImage(),
  regions: [fakeFace(FAKE), fakeFace(FAKE, 0.2)],
  unservable: flatFace(),
  unserved: fakeVehicle(FAKE),
});

/** Run the suite and report which checks threw, by name. */
const redChecks = async (
  enricher: Enricher,
  fixed: EnricherFixtures = fixtures()
): Promise<string[]> => {
  const red: string[] = [];
  for (const check of enricherConformance(enricher, fixed)) {
    await check.run().catch(() => red.push(check.name));
  }
  return red;
};

describe("enricherConformance", () => {
  it("names seven checks, in a stable order", () => {
    const names = enricherConformance(fakeEnricher(FAKE), fixtures()).map(
      (c) => c.name
    );
    expect(names).toEqual(Object.values(CHECKS));
  });

  it("passes an Enricher that plays by the rules", async () => {
    expect(await redChecks(fakeEnricher(FAKE))).toEqual([]);
  });
});

// One mutation per check, as `docs/specs/models.md` names them. Each must turn
// its own check red: a check nothing can break is not a check. Two names mean
// the mutation genuinely breaks two rules — dropping a Region it could not
// serve also shortens the answer — and never that a check is too broad.
describe("each check goes red on its own mutation", () => {
  const cases: [string, Enricher, string[]][] = [
    [
      "drift: a second run answers with another vector",
      fakeEnricher(FAKE, { drift: true }),
      [CHECKS.determinism],
    ],
    [
      "stamp: the print carries another version",
      fakeEnricher(FAKE, { stamp: { name: "fake-print", version: "2" } }),
      [CHECKS.model],
    ],
    [
      "drop it: a face it could not align is left out",
      fakeEnricher(FAKE, { dropRefused: true }),
      [CHECKS.refused, CHECKS.order],
    ],
    [
      "touch a vehicle: a print on a kind it does not serve",
      fakeEnricher(FAKE, { touchUnserved: true }),
      [CHECKS.unserved],
    ],
    [
      "reorder: the last two regions come back the other way round",
      fakeEnricher(FAKE, { reorder: true }),
      [CHECKS.order],
    ],
    [
      "skip normalisation: the vector is left at the network's own scale",
      fakeEnricher(FAKE, { raw: true }),
      [CHECKS.unit],
    ],
    [
      "empty it: the Model ships without a licence",
      fakeEnricher(FAKE, { licence: "  " }),
      [CHECKS.licence],
    ],
  ];

  for (const [mutation, mutated, red] of cases) {
    it(mutation, async () => {
      expect(await redChecks(mutated)).toEqual(red);
    });
  }
});

describe("the fixtures are proved too", () => {
  it("refuses fixtures that yield no Face Print at all", async () => {
    const red = await redChecks(fakeEnricher(FAKE), {
      ...fixtures(),
      regions: [],
    });
    expect(red).toEqual([CHECKS.determinism]);
  });
});
