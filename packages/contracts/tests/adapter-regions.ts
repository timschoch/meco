// Fixtures for `assignRegionIds`. Private to tests/ by the boundary rules.
import type { AdapterRegion } from "../index";
import { detector, objects } from "./samples";

/** A second face detector, so one face can be found twice. */
const otherDetector = { name: "retinaface", version: "r50-1" };

const FACE_HEIGHT = 0.16;

/** Landmarks inside the face they belong to, so a fixture stays a real face. */
const landmarksIn = (x: number, y: number, width: number) => {
  const at = (dx: number, dy: number) => ({
    x: x + width * dx,
    y: y + FACE_HEIGHT * dy,
  });
  return {
    rEye: at(0.3, 0.35),
    lEye: at(0.7, 0.35),
    nose: at(0.5, 0.55),
    rMouth: at(0.35, 0.75),
    lMouth: at(0.65, 0.75),
  };
};

const faceAt = (x: number, y: number, width: number): AdapterRegion => ({
  kind: "face",
  label: "face",
  box: { x, y, width, height: FACE_HEIGHT },
  score: 0.9,
  model: detector,
  landmarks: landmarksIn(x, y, width),
});

const vehicleAt = (x: number, y: number): AdapterRegion => ({
  kind: "vehicle",
  label: "motorbike",
  box: { x, y, width: 0.2, height: 0.2 },
  score: 0.8,
  model: objects,
});

/**
 * Five Regions in the order `assignRegionIds` must sort them, each key of
 * `(kind, box.y, box.x, box.width)` decided by a different pair:
 *
 * - `kind`, by the vehicles coming last although one sits above every face
 * - `box.y`, by the two vehicles
 * - `box.x`, by the third face against the first two
 * - `box.width`, by the first two faces, which differ in nothing else
 *
 * A function, not a constant: a test that hands the same array to a version of
 * `assignRegionIds` that sorts in place would otherwise pass on the leftovers
 * of the test before it.
 */
export const orderedAdapterRegions = (): AdapterRegion[] => [
  faceAt(0.15, 0.3, 0.05),
  faceAt(0.15, 0.3, 0.09),
  faceAt(0.6, 0.3, 0.07),
  vehicleAt(0.1, 0.2),
  vehicleAt(0.1, 0.5),
];

/** The same five Regions in an order no adapter would produce them in. */
export const shuffledAdapterRegions = (): AdapterRegion[] => {
  const [a, b, c, d, e] = orderedAdapterRegions();
  return [d!, b!, e!, a!, c!];
};

/** The ids `orderedAdapterRegions` earns, in order. */
export const expectedIds = [
  "face-1",
  "face-2",
  "face-3",
  "vehicle-1",
  "vehicle-2",
];

/**
 * The same face found by two Models: identical in `(kind, box.y, box.x,
 * box.width)`, so only the keys past the spec's four can tell them apart.
 * Without those, which one is `face-1` would depend on which adapter ran first.
 */
export const sameBoxFromTwoModels = (): AdapterRegion[] => {
  const found = faceAt(0.15, 0.3, 0.05);
  return [
    found,
    { ...found, score: 0.8, model: otherDetector, label: "visage" },
  ];
};
