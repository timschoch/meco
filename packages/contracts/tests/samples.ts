// Fixtures for the contracts tests. Private to tests/ by the boundary rules.
import type { Annotation } from "../index";

export const detector = { name: "scrfd", version: "10g-bnkps-1" };
export const printer = { name: "edgeface", version: "s-gamma-05-1" };
export const objects = { name: "dfine", version: "s-coco-1" };

const point = (x: number, y: number) => ({ x, y });

/** A 512-value unit vector, the shape a Face Print really has. */
const unitVector = (seed: number): number[] => {
  const raw = Array.from({ length: 512 }, (_, i) => Math.sin(seed + i));
  const length = Math.hypot(...raw);
  return raw.map((v) => v / length);
};

/** One valid Annotation: one face Region with a print, one vehicle Region. */
export const annotation: Annotation = {
  schema: 1,
  hash: "9f".repeat(32),
  mime: "image/jpeg",
  width: 4000,
  height: 3000,
  producedBy: [detector, printer, objects],
  regions: [
    {
      id: "face-1",
      kind: "face",
      label: "face",
      box: { x: 0.42, y: 0.18, width: 0.12, height: 0.16 },
      score: 0.97,
      model: detector,
      landmarks: {
        rEye: point(0.45, 0.23),
        lEye: point(0.51, 0.23),
        nose: point(0.48, 0.26),
        rMouth: point(0.46, 0.29),
        lMouth: point(0.5, 0.29),
      },
      facePrint: { model: printer, vector: unitVector(1) },
    },
    {
      id: "vehicle-1",
      kind: "vehicle",
      label: "motorbike",
      box: { x: 0.3, y: 0.4, width: 0.4, height: 0.5 },
      score: 0.89,
      model: objects,
    },
  ],
};

/** The face Region of {@link annotation}. The base for a Region sample. */
export const face = annotation.regions[0]!;

/** The vehicle Region of {@link annotation}: a Region with no landmarks or print. */
export const vehicle = annotation.regions[1]!;

/**
 * One named sample per field rule the ticket calls out. The name is what a red
 * run prints, so it says which rule broke, not which array index.
 */
export const invalidAnnotations: { name: string; value: unknown }[] = [
  {
    name: "a box spelled w and h",
    value: {
      ...annotation,
      regions: [{ ...face, box: { x: 0.42, y: 0.18, w: 0.12, h: 0.16 } }],
    },
  },
  {
    name: "a box whose x + width is above 1",
    value: {
      ...annotation,
      regions: [{ ...face, box: { ...face.box, x: 0.95, width: 0.12 } }],
    },
  },
  {
    name: "a negative score",
    value: { ...annotation, regions: [{ ...face, score: -0.01 }] },
  },
  {
    name: "a face without landmarks",
    value: { ...annotation, regions: [{ ...face, landmarks: undefined }] },
  },
  {
    name: "a mime outside the closed set",
    value: { ...annotation, mime: "image/gif" },
  },
  {
    name: "a hash of 63 chars",
    value: { ...annotation, hash: "9f".repeat(31) + "9" },
  },
  {
    name: "a duplicate in producedBy",
    value: {
      ...annotation,
      producedBy: [...annotation.producedBy, annotation.producedBy[0]!],
    },
  },
  { name: "an unknown schema number", value: { ...annotation, schema: 2 } },
  {
    name: "two regions sharing an id",
    value: { ...annotation, regions: [face, { ...face, score: 0.5 }] },
  },
  {
    name: "a face print vector that is not unit length",
    value: {
      ...annotation,
      regions: [
        { ...face, facePrint: { model: printer, vector: [0.6, 0.8, 0.1] } },
      ],
    },
  },
];
