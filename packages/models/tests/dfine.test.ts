import { describe, expect, it } from "vitest";
import { adapterConformance } from "@meco/contracts/conformance";
import { Annotation, type AdapterRegion } from "@meco/contracts";
import { createApp } from "../app";
import { catalogue, decode } from "../catalogue";
import {
  blankImage,
  expectedKartFaces,
  expectedObjects,
  kartFixture,
  matchGolden,
  MIN_IOU,
} from "./fixtures";

const dfine = catalogue.detectors.find((d) => d.model.name === "dfine")!;

const DARK_VISOR = "on-track-dark-visor.jpg";

/** The three on-track photographs: a kart with a driver on it, nothing else. */
const ON_TRACK = [
  DARK_VISOR,
  "on-track-rear-helmet.jpg",
  "on-track-visor-open.jpg",
];

/** The host's own decode of one kart fixture, the pixels every adapter gets. */
const pixels = async (file: string) =>
  (await decode(await kartFixture(file))).image;

/**
 * The label to kind table, restated from `CONTEXT.md`, models. Restated and not
 * imported: the table is the thing under test, and a test that read it from the
 * code it checks would agree with any edit to it. A COCO Label absent here
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
    image: await pixels(DARK_VISOR),
    blank: blankImage(),
  })) {
    it(check.name, check.run);
  }
});

/**
 * The golden checks, against every `person` and `motorbike` box
 * `fixtures/karts/objects.json` records for the on-track photographs — the kart
 * and its driver, and on the dark-visor fixture the second kart and the two
 * further drivers as well. Those boxes were recorded from this Model at this
 * Decode Bound by an independent implementation, so reproducing them to the
 * hand-marked tolerance is what proves the decode arithmetic and not just that
 * something plausible came back.
 */
describe("dfine against the recorded detections", async () => {
  const { images, tolerance } = await expectedObjects();

  for (const file of ON_TRACK) {
    const recorded = images.find((i) => i.file === file)!.objects;

    for (const label of ["motorbike", "person"]) {
      const marks = recorded
        .filter((o) => o.label === label)
        .map((o) => ({ label: `${label} at ${String(o.score)}`, box: o.box }));

      it(`${file}: finds all ${marks.length} recorded ${label}`, async () => {
        const found = await dfine.run(await pixels(file));
        const peers = found.filter((r) => r.label === label);

        expect(peers.length).toBeGreaterThanOrEqual(marks.length);
        for (const match of matchGolden(marks, peers)) {
          expect(
            match.iou,
            `${file} ${match.label} IoU`
          ).toBeGreaterThanOrEqual(MIN_IOU);
          expect(
            match.centre,
            `${file} ${match.label} centre`
          ).toBeLessThanOrEqual(tolerance);
        }
      });
    }
  }
});

describe("dfine on the dark-visor fixture", async () => {
  const found: AdapterRegion[] = await dfine.run(await pixels(DARK_VISOR));

  it("draws no vehicle wider than 0.9 of the frame", () => {
    // The `boat` box at 0.506 spanning 0.9239 x 0.2992 that the five-class
    // table drops. Left in, it outweighs the true `motorbike` at 0.294 by area
    // and seeds frame's kart Subject onto the whole track.
    for (const region of found.filter((r) => r.kind === "vehicle")) {
      expect(
        region.box.width,
        `${region.label} at ${String(region.score)}`
      ).toBeLessThanOrEqual(0.9);
    }
    expect(found.some((r) => r.kind === "vehicle")).toBe(true);
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
    expect(regions.map((r) => r.id)).toContain("vehicle-1");
  });

  it("runs both in Catalogue order, whatever order they are named in", async () => {
    const inOrder = [
      { name: "yunet", version: "1" },
      { name: "dfine", version: "1" },
    ];
    expect((await post("?models=yunet,dfine")).producedBy).toEqual(inOrder);
    expect((await post("?models=dfine,yunet")).producedBy).toEqual(inOrder);
  });

  it("draws the karts and no face at all, which is what this fixture is for", async () => {
    // The Not-a-Face ground truth: `fixtures/karts/expected.json` records no
    // face on this photograph, because both visors are down. The whole
    // Catalogue over the whole Annotation, so this is the claim the spec makes
    // and not dfine agreeing with itself about the kinds it declares.
    const marked = (await expectedKartFaces()).images.find(
      (i) => i.file === DARK_VISOR
    )!;
    expect(marked.faces).toEqual([]);

    const { producedBy, regions } = await post("");
    expect(producedBy.map((m) => m.name)).toEqual(["yunet", "dfine"]);
    expect(regions.filter((r) => r.kind === "face")).toEqual([]);
    expect(regions.some((r) => r.kind === "vehicle")).toBe(true);
    expect(regions.some((r) => r.kind === "person")).toBe(true);
  });
});
