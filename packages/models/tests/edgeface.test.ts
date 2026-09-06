import { describe, expect, it } from "vitest";
import type { AdapterRegion } from "@meco/contracts";
import { catalogue, decode, enricherConformance } from "../catalogue";
import {
  blankImage,
  cosine,
  expectedFaces,
  fixture,
  matchGolden,
  referencePrints,
} from "./fixtures";

const edgeface = catalogue.enrichers.find((e) => e.model.name === "edgeface")!;
const yunet = catalogue.detectors.find((d) => d.model.name === "yunet")!;

const CREW = "artemis-2-crew.jpg";

/** How alike a print and its committed reference must be. #75's number. */
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

  // The golden. `fixtures/faces/face-prints.json` holds the prototype's own
  // ONNX prints of every fixture face, one per hand-marked position; neither
  // it nor `edgeface-reference.json` (PyTorch, over the committed 112px
  // squares) records a decode bound, so the bound this compares at is this
  // host's: `decode` above, 1600 px. The crew fixture is 1280x1600, so it
  // passes through the bound untouched and the two paths see the same pixels
  // — which is why 0.95 has room to spare here. The threshold is #75's, set
  // for the general case where the bound does shrink the photograph and the
  // spec's "Why 1600" measured a 0.96 cosine on the smallest face.
  it("agrees with the committed reference prints, face by face", async () => {
    const marked = (await expectedFaces()).images.find((i) => i.file === CREW)!;
    const reference = await referencePrints();

    for (const { label, region } of matchGolden(marked.faces, printed)) {
      const committed = reference.find(
        (p) => p.file === CREW && p.label === label
      );
      expect(committed, `a committed print for "${label}"`).toBeDefined();
      expect(
        cosine(region!.facePrint!.vector, committed!.print),
        `"${label}" against its committed print`
      ).toBeGreaterThanOrEqual(MIN_PRINT_COSINE);
    }
  });
});
