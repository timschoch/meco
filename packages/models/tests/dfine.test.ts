import { describe, expect, it } from "vitest";
import { adapterConformance } from "@meco/contracts/conformance";
import { Annotation, type AdapterRegion } from "@meco/contracts";
import { createApp } from "../app";
import { catalogue, decode } from "../catalogue";
import {
  blankImage,
  expectedObjects,
  kartFixture,
  matchGolden,
  MIN_IOU,
} from "./fixtures";

const dfine = catalogue.detectors.find((d) => d.model.name === "dfine")!;

/** The dark-visor fixture decoded once: every check below reads these pixels. */
const darkVisor = async () =>
  (await decode(await kartFixture(DARK_VISOR))).image;

const DARK_VISOR = "on-track-dark-visor.jpg";

/** The three on-track photographs: a kart with a driver on it, nothing else. */
const ON_TRACK = [
  DARK_VISOR,
  "on-track-rear-helmet.jpg",
  "on-track-visor-open.jpg",
];

/**
 * The label to kind table, restated from `CONTEXT.md`, models. Restated and not
 * imported: the table is the thing under test, and a test that reads it from
 * the code it checks would agree with any edit to it. A COCO Label absent here
 * emits no Region at all.
 */
const KIND_OF_LABEL: Record<string, "person" | "vehicle"> = {
  person: "person",
  motorbike: "vehicle",
  bicycle: "vehicle",
  car: "vehicle",
  bus: "vehicle",
  truck: "vehicle",
};

/** The highest-scoring recorded detection of one COCO Label in a photograph. */
const recorded = async (file: string, label: string) => {
  const { images, tolerance } = await expectedObjects();
  const image = images.find((i) => i.file === file)!;
  const best = image.objects
    .filter((o) => o.label === label)
    .sort((a, b) => b.score - a.score)[0]!;
  return { mark: { label, box: best.box }, tolerance };
};

describe("dfine is in the Catalogue", () => {
  it("as a person and vehicle Detector at version 1", () => {
    expect(dfine.model).toEqual({ name: "dfine", version: "1" });
    expect(dfine.kinds).toEqual(["person", "vehicle"]);
    expect(dfine.licenceId).toBe("Apache-2.0");
  });
});

// The eight checks every Detector passes, over the host's own decode.
describe("dfine passes adapterConformance", async () => {
  for (const check of adapterConformance(dfine, {
    image: await darkVisor(),
    blank: blankImage(),
  })) {
    it(check.name, check.run);
  }
});

describe("dfine against the recorded detections", () => {
  for (const file of ON_TRACK) {
    it(`${file}: finds the kart and its driver`, async () => {
      const found = await dfine.run(
        (await decode(await kartFixture(file))).image
      );
      const { tolerance } = await expectedObjects();

      for (const label of ["motorbike", "person"]) {
        const { mark } = await recorded(file, label);
        const peers = found.filter((r) => r.label === label);
        const [match] = matchGolden([mark], peers);
        expect(match!.iou, `${file} ${label} IoU`).toBeGreaterThanOrEqual(
          MIN_IOU
        );
        expect(match!.centre, `${file} ${label} centre`).toBeLessThanOrEqual(
          tolerance
        );
      }
    });
  }
});

describe("dfine on the dark-visor fixture", async () => {
  const found: AdapterRegion[] = await dfine.run(await darkVisor());

  it("draws no face: a Detector emits only the kinds it declares", () => {
    expect(found.filter((r) => r.kind === "face")).toEqual([]);
    expect(found.some((r) => r.kind === "vehicle")).toBe(true);
  });

  it("draws no vehicle wider than 0.9 of the frame", () => {
    // The `boat` box at 0.506 spanning 0.9239 x 0.2992 that the five-class
    // table drops. Left in, it outweighs the true `motorbike` at 0.294 by area
    // and seeds frame's kart Subject onto the whole track.
    for (const region of found.filter((r) => r.kind === "vehicle")) {
      expect(
        region.box.width,
        `${region.label} at ${region.score}`
      ).toBeLessThanOrEqual(0.9);
    }
  });

  it("keeps the Model's own word in label and maps it by the table", () => {
    for (const region of found) {
      expect(
        KIND_OF_LABEL[region.label],
        `${region.label} is not a Label the table keeps`
      ).toBe(region.kind);
    }
    expect(found.map((r) => r.label)).toContain("motorbike");
  });
});

describe("?models= names dfine on the real Catalogue", async () => {
  const app = createApp(catalogue);
  const post = async (query: string) =>
    Annotation.parse(
      await (
        await app.request(`/annotate${query}`, {
          method: "POST",
          body: await kartFixture(DARK_VISOR),
        })
      ).json()
    );

  it("runs only dfine when only dfine is named", async () => {
    const { producedBy, regions } = await post("?models=dfine");
    expect(producedBy).toEqual([{ name: "dfine", version: "1" }]);
    expect(regions.every((r) => r.kind !== "face")).toBe(true);
    expect(regions.map((r) => r.id)).toContain("vehicle-1");
  });

  it("runs both in Catalogue order, whatever order they are named in", async () => {
    expect((await post("?models=dfine,yunet")).producedBy).toEqual([
      { name: "yunet", version: "1" },
      { name: "dfine", version: "1" },
    ]);
  });
});
