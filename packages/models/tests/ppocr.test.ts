import { describe, expect, it } from "vitest";
import { adapterConformance } from "@meco/contracts/conformance";
import { Annotation } from "@meco/contracts";
import { createApp } from "../app";
import { catalogue, decode } from "../catalogue";
import {
  blankImage,
  centreDistance,
  expectedNumbers,
  kartFixture,
} from "./fixtures";

const ppocr = catalogue.detectors.find((d) => d.model.name === "ppocr")!;

const GRID = "kart-grid-24.jpg";

/** The host's own decode of one kart fixture, the pixels every adapter gets. */
const pixels = async (file: string) =>
  (await decode(await kartFixture(file))).image;

describe("ppocr is in the Catalogue", () => {
  it("as a number Detector at version 1, after dfine and before the Enricher", () => {
    expect(ppocr.model).toEqual({ name: "ppocr", version: "1" });
    expect(ppocr.kinds).toEqual(["number"]);
    expect(ppocr.licenceId).toBe("Apache-2.0");
    expect(catalogue.detectors.map((d) => d.model.name)).toEqual([
      "yunet",
      "dfine",
      "ppocr",
    ]);
  });
});

// The eight checks every Detector passes, over the host's own decode.
describe("ppocr passes adapterConformance", async () => {
  for (const check of adapterConformance(ppocr, {
    image: await pixels(GRID),
    blank: blankImage(),
  })) {
    it(check.name, check.run);
  }
});

/**
 * The reads against `numbers.json`. Every image in the file, so the two
 * Commons fixtures with a number in them are read too, and a photograph with
 * nothing to read (the crew) is not in the file and not asserted on.
 */
describe("ppocr against the expected reads", async () => {
  const { images, tolerance } = await expectedNumbers();

  for (const image of images) {
    const found = await ppocr.run(await pixels(image.file));
    const allowed = new Set([
      ...image.numbers.map((n) => n.label),
      ...(image.others ?? []),
    ]);

    it(`${image.file}: reads ${image.numbers.map((n) => n.label).join(", ") || "nothing"}`, () => {
      for (const expected of image.numbers) {
        const match = found.find(
          (r) =>
            r.label === expected.label &&
            centreDistance(r.box, expected.box) <= tolerance
        );
        expect(
          match,
          `${expected.label} at ${JSON.stringify(expected.box)} in ${found.map((r) => r.label).join(", ") || "no reads"}`
        ).toBeDefined();
        expect(match!.kind).toBe("number");
        expect(match!.model).toEqual({ name: "ppocr", version: "1" });
      }
    });

    it(`${image.file}: reads no number that is not in the photograph`, () => {
      for (const region of found) {
        expect(
          allowed.has(region.label),
          `${region.label} at ${String(region.score)} is a false read`
        ).toBe(true);
      }
    });

    if (image.misses.length > 0) {
      it(`${image.file}: still misses ${image.misses.map((m) => m.label).join(", ")}, until numbers.json says otherwise`, () => {
        // A reader that finds one of these is better than the file: the
        // entry moves to `numbers` on purpose, and this is what makes that
        // a visible decision rather than a silent improvement.
        for (const miss of image.misses) {
          expect(
            found.some((r) => r.label === miss.label),
            `${miss.label} was read; move it from misses to numbers`
          ).toBe(false);
        }
      });
    }
  }

  it("every label is one to three digits and nothing else", async () => {
    for (const image of images) {
      for (const region of await ppocr.run(await pixels(image.file))) {
        expect(region.label).toMatch(/^[0-9]{1,3}$/);
      }
    }
  });
});

describe("?models= names ppocr on the real Catalogue", async () => {
  const app = createApp(catalogue);
  const post = async (query: string) =>
    Annotation.parse(
      await (
        await app.request(`/annotate${query}`, {
          method: "POST",
          body: await kartFixture(GRID),
        })
      ).json()
    );

  it("runs only ppocr when only ppocr is named, and numbers the Regions by position", async () => {
    const { producedBy, regions } = await post("?models=ppocr");
    expect(producedBy).toEqual([{ name: "ppocr", version: "1" }]);
    // Sorted on kind, then y, then x: the 227 sits highest in the frame.
    expect(regions.map((r) => [r.id, r.label])).toEqual([
      ["number-1", "227"],
      ["number-2", "24"],
      ["number-3", "66"],
      ["number-4", "21"],
    ]);
  });

  it("lists ppocr third when the whole Catalogue runs", async () => {
    const { producedBy, regions } = await post("");
    expect(producedBy.map((m) => m.name)).toEqual([
      "yunet",
      "dfine",
      "ppocr",
      "edgeface",
    ]);
    expect(regions.filter((r) => r.kind === "number")).toHaveLength(4);
    expect(regions.some((r) => r.kind === "vehicle")).toBe(true);
  });
});
