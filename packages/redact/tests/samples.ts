// Fixtures for the redact tests. Private to tests/ by the boundary rules.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import {
  assignRegionIds,
  type AdapterRegion,
  type Match,
  type Region,
} from "@meco/contracts";
import type { RedactRequest } from "../index";

const fixture = (name: string): string =>
  fileURLToPath(new URL(`../../../fixtures/faces/${name}`, import.meta.url));

/** The models behind the recordings in `fixtures/faces`. */
const detector = { name: "scrfd", version: "10g-bnkps-1" };
const objectDetector = { name: "dfine", version: "s-coco-1" };

type RecordedFace = {
  box: Region["box"];
  landmarks: NonNullable<Region["landmarks"]>;
  score: number;
};

type Recording = {
  images: Record<
    string,
    { width: number; height: number; faces: RecordedFace[] }
  >;
};

const recording = JSON.parse(
  readFileSync(fixture("detected.json"), "utf8")
) as Recording;

const crew = recording.images["artemis-2-crew.jpg"]!;

/** The size `detected.json` recorded the fractions against. */
export const crewSize = { width: crew.width, height: crew.height };

const faces: AdapterRegion[] = crew.faces.map((face) => ({
  kind: "face",
  label: "face",
  box: face.box,
  score: face.score,
  model: detector,
  landmarks: face.landmarks,
}));

/**
 * A body and a kart, so a call can carry a Region kind redact must not touch.
 * Hand-made: `detected.json` records faces only, and the boxes need only be
 * legal — no check here reads their geometry.
 */
const others: AdapterRegion[] = [
  {
    kind: "person",
    label: "person",
    box: { x: 0.42, y: 0.17, width: 0.2, height: 0.6 },
    score: 0.87,
    model: objectDetector,
  },
  {
    kind: "vehicle",
    label: "motorbike",
    box: { x: 0.3, y: 0.55, width: 0.4, height: 0.4 },
    score: 0.81,
    model: objectDetector,
  },
];

/** The four faces of `artemis-2-crew.jpg`, numbered the way contracts numbers them. */
export const crewRegions: Region[] = assignRegionIds(faces);

/** The same four faces with a person and a vehicle Region beside them. */
export const crewWithOtherKinds: Region[] = assignRegionIds([
  ...faces,
  ...others,
]);

/** `face-1`: the smallest of the four, so "whatever its size" is not a claim. */
export const smallestFace: Region = [...crewRegions].sort(
  (a, b) => a.box.width - b.box.width
)[0]!;

/** A Match for one Region. The similarity is the caller's to choose. */
export const matchOf = (regionId: string, similarity: number): Match => ({
  regionId,
  personId: "person-reid-wiseman",
  brand: "nasa",
  similarity,
});

/** `artemis-2-crew.jpg` decoded to raw RGB, the way the models host decodes it. */
export const decodeCrew = async (): Promise<RedactRequest["image"]> => {
  const { data, info } = await sharp(fixture("artemis-2-crew.jpg"))
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 3) {
    throw new Error(
      `expected 3 channels from the decode, got ${info.channels}`
    );
  }
  return { width: info.width, height: info.height, channels: 3, data };
};
