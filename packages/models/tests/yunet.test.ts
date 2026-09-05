import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { adapterConformance } from "@meco/contracts/conformance";
import { catalogue, decode, type Detector } from "../catalogue";
import {
  blankImage,
  expectedFaces,
  fixture,
  MIN_IOU,
  matchGolden,
} from "./fixtures";

const yunet = catalogue.detectors.find((d) => d.model.name === "yunet")!;

describe("yunet is in the Catalogue", () => {
  it("as a face Detector at version 1", () => {
    expect(yunet).toBeDefined();
    expect(yunet.model).toEqual({ name: "yunet", version: "1" });
    expect(yunet.kinds).toEqual(["face"]);
  });
});

// The eight checks every Detector passes, over the host's own decode.
describe("yunet passes adapterConformance", async () => {
  const { image } = await decode(await fixture("artemis-2-crew.jpg"));
  for (const check of adapterConformance(yunet, {
    image,
    blank: blankImage(),
  })) {
    it(check.name, check.run);
  }
});

describe("yunet against the hand-marked fixtures", async () => {
  const expected = await expectedFaces();

  for (const { file, note, faces } of expected.images) {
    it(`${file}: ${note}`, async () => {
      const { image } = await decode(await fixture(file));
      const found = await yunet.run(image);

      expect(found, "one Region per hand-marked face").toHaveLength(
        faces.length
      );
      for (const match of matchGolden(faces, found)) {
        expect(match.iou, `${match.label} IoU`).toBeGreaterThanOrEqual(MIN_IOU);
        expect(match.centre, `${match.label} centre`).toBeLessThanOrEqual(
          expected.tolerance
        );
      }
    });
  }

  it("puts the eyes in the upper part of the face, the right eye on the viewer's left", async () => {
    const { image } = await decode(await fixture("soyuz-crew.jpg"));
    for (const region of await yunet.run(image)) {
      const { rEye, lEye } = region.landmarks!;
      const { y, height } = region.box;
      expect(rEye.x).toBeLessThan(lEye.x);
      for (const eye of [rEye, lEye]) {
        expect(eye.y).toBeGreaterThan(y);
        expect(eye.y).toBeLessThan(y + height * 0.6);
      }
    }
  });
});

describe("every adapter folder", async () => {
  const adapters = new URL("../lib/adapters/", import.meta.url);
  const folders = (await readdir(adapters, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  it("is in the Catalogue", () => {
    expect(folders.sort()).toEqual(
      catalogue.detectors.map((d) => d.model.name).sort()
    );
  });

  for (const folder of folders) {
    const dir = new URL(`${folder}/`, adapters);

    it(`${folder}: the weights hash to weights.sha256`, async () => {
      const pins = (await readFile(new URL("weights.sha256", dir), "utf8"))
        .trim()
        .split("\n")
        .map((line) => line.trim().split(/\s+/) as [string, string]);
      expect(pins.length).toBeGreaterThan(0);
      for (const [sha256, file] of pins) {
        const bytes = await readFile(new URL(file, dir));
        expect(createHash("sha256").update(bytes).digest("hex"), file).toBe(
          sha256
        );
      }
    });
  }
});

describe.each(
  catalogue.detectors.map((d): [string, Detector] => [d.model.name, d])
)("%s ships its licence", (_name, detector) => {
  it("as non-empty text that names its declared id", () => {
    expect(detector.licence.trim()).not.toBe("");
    expect(detector.licence).toContain(detector.licenceId);
  });
});
