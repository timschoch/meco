import { describe, expect, it } from "vitest";
import type { AdapterRegion, ModelAdapter } from "@meco/contracts";
import { adapterConformance, cosine } from "@meco/contracts/conformance";
import { catalogue, decode, enricherConformance } from "../catalogue";
import {
  blankImage,
  expectedFaces,
  fixture,
  goldenPrint,
  matchGolden,
} from "./fixtures";

const edgeface = catalogue.enrichers.find((e) => e.model.name === "edgeface")!;
const yunet = catalogue.detectors.find((d) => d.model.name === "yunet")!;

const CREW = "artemis-2-crew.jpg";

/**
 * How alike a print and its committed reference must be. #121's number, set
 * against the spec's "Why 1600": the bound moves the smallest face's print by
 * 0.96 cosine, so a floor below that is what the general case needs.
 */
const MIN_PRINT_COSINE = 0.95;

/** The host's own decode and the Regions the Detector drew in it. */
const crew = async () => {
  const { image } = await decode(await fixture(CREW));
  return { image, regions: await yunet.run(image) };
};

/** A face whose five landmarks sit on one point: nothing to fit a warp to. */
const unalignable = (face: AdapterRegion): AdapterRegion => {
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

describe("edgeface is in the Catalogue", () => {
  it("as an Enricher on face Regions at version 1", () => {
    expect(edgeface.model).toEqual({ name: "edgeface", version: "1" });
    expect(edgeface.on).toBe("face");
    expect(edgeface.licenceId).toBe("CC-BY-NC-SA-4.0");
  });
});

// The seven checks every Enricher passes, over the host's own decode and the
// Regions the real Detector drew.
describe("edgeface passes enricherConformance", async () => {
  const { image, regions } = await crew();
  for (const check of enricherConformance(edgeface, {
    image,
    regions,
    unservable: unalignable(regions[0]!),
    unserved: {
      kind: "vehicle",
      label: "motorbike",
      box: { x: 0.1, y: 0.6, width: 0.3, height: 0.25 },
      score: 0.8,
      model: { name: "not-a-real-detector", version: "1" },
    },
  })) {
    it(check.name, check.run);
  }
});

/**
 * The two stages as one Model Adapter, so that contracts' own
 * `adapterConformance` sees Regions that carry a Face Print. Run over `yunet`
 * alone those checks are vacuous — a Detector emits no print — and the two
 * they were written for, the determinism cosine and the unit length, would
 * never fire. This is the same pipeline `POST /annotate` runs, behind
 * contracts' `run(image)`, stamped with the Model that drew the boxes.
 */
const printedFaces = (): ModelAdapter => ({
  model: yunet.model,
  licence: yunet.licence,
  kinds: yunet.kinds,
  run: async (image) => edgeface.run(image, await yunet.run(image)),
});

describe("the printed pipeline passes contracts' adapterConformance", async () => {
  const { image } = await crew();
  for (const check of adapterConformance(printedFaces(), {
    image,
    blank: blankImage(),
  })) {
    it(check.name, check.run);
  }
});

describe("edgeface prints the crew", async () => {
  const { image, regions } = await crew();
  const printed = await edgeface.run(image, regions);

  it("puts a 512-float print on every face YuNet found", () => {
    expect(printed).toHaveLength(4);
    for (const region of printed) {
      expect(region.facePrint?.vector).toHaveLength(512);
      expect(region.facePrint?.model).toEqual({
        name: "edgeface",
        version: "1",
      });
    }
  });

  it("prints nothing on an image with no face in it", async () => {
    const empty = await decode(await fixture("jezero-crater.jpg"));
    expect(await edgeface.run(empty.image, [])).toEqual([]);
    expect(await edgeface.run(blankImage(), [])).toEqual([]);
  });

  // The golden. `fixtures/faces/edgeface-reference.json` holds PyTorch's own
  // output over the committed 112px squares in `fixtures/faces/aligned/`:
  // another runtime and another aligner, so agreeing with it is a claim about
  // this adapter. (`face-prints.json` beside it is not the golden any more —
  // since #177 this repository writes it through this very Catalogue, and an
  // adapter checked against its own output asserts nothing.) Neither file
  // records a decode bound, so the bound compared at is this host's: `decode`
  // above, 1600 px. The crew fixture is 1280x1600 and passes through untouched,
  // which is why 0.95 has room to spare here. The threshold is #75's, set for
  // the general case where the bound does shrink the photograph and the spec's
  // "Why 1600" measured a 0.96 cosine on the smallest face.
  it("agrees with the golden PyTorch prints, face by face", async () => {
    const marked = (await expectedFaces()).images.find((i) => i.file === CREW)!;

    for (const { label, region } of matchGolden(marked.faces, printed)) {
      const golden = await goldenPrint(CREW, label);
      expect(golden, `a golden print for "${label}"`).toBeDefined();
      expect(
        cosine(region!.facePrint!.vector, golden!),
        `"${label}" against its golden print`
      ).toBeGreaterThanOrEqual(MIN_PRINT_COSINE);
    }
  });
});
