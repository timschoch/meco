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

/**
 * A face Region on a hand-built box.
 *
 * The four recorded faces span 100 to 114 pixels, which is too narrow a range
 * to tell a sigma that scales from one that does not. A check that needs two
 * sizes builds the second one.
 */
export const facesOn = (...boxes: Region["box"][]): Region[] =>
  assignRegionIds(
    boxes.map((box) => ({
      kind: "face" as const,
      label: "face",
      box,
      score: 0.9,
      model: detector,
    }))
  );

export const faceOn = (box: Region["box"]): Region => facesOn(box)[0]!;

/** The size of `stepEdge`. Wide enough to hold a 400 px mask clear of the sides. */
export const STEP_EDGE_SIZE = { width: 1024, height: 512 };

/**
 * Black on the left, white on the right, with the step down the middle.
 *
 * A photograph cannot say what sigma was used; this can. A Gaussian of sigma s
 * turns a step into a profile whose 25 % to 75 % rise spans 1.349 s, so a mask
 * drawn over the step measures its own blur strength.
 */
export const stepEdge = (): RedactRequest["image"] => {
  const { width, height } = STEP_EDGE_SIZE;
  const data = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    const row = y * width * 3;
    data.fill(255, row + (width / 2) * 3, row + width * 3);
  }
  return { width, height, channels: 3, data };
};

/** A face box `widthInPixels` wide, centred on `stepEdge`'s step. */
export const faceOnTheStep = (widthInPixels: number): Region =>
  faceOn({
    x: 0.5 - widthInPixels / 2 / STEP_EDGE_SIZE.width,
    y: 0.25,
    width: widthInPixels / STEP_EDGE_SIZE.width,
    height: 0.5,
  });

/** The size of `checkerboard`. The 4:5 of the photograph, small enough to be quick. */
export const CHECKERBOARD_SIZE = { width: 640, height: 800 };

/** The side of one square of `checkerboard`, in pixels. */
const CHECK = 4;

/**
 * Black and white squares, edge to edge.
 *
 * The corners of `artemis-2-crew.jpg` are featureless: mean |Laplacian| in its
 * top-left 256x320 is 0.200 against 11.0 to 13.9 inside the four face cores.
 * A detail ratio measured there measures the sensor noise, and no mutation
 * moves it — skipping the blur leaves it under any bound worth writing. So a
 * check that needs detail *at the boundary* builds an image that has it
 * everywhere.
 */
export const checkerboard = (): RedactRequest["image"] => {
  const { width, height } = CHECKERBOARD_SIZE;
  const data = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const white =
        (Math.floor(x / CHECK) + Math.floor(y / CHECK)) % 2 === 0 ? 255 : 0;
      data.fill(white, (y * width + x) * 3, (y * width + x) * 3 + 3);
    }
  }
  return { width, height, channels: 3, data };
};

/** A Match for one Region. The similarity is the caller's to choose. */
export const matchOf = (regionId: string, similarity: number): Match => ({
  regionId,
  personId: "person-reid-wiseman",
  brand: "nasa",
  by: "face",
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
