// Fixtures for the contracts tests. Private to tests/ by the boundary rules.
import {
  DEFAULT_ANCHOR,
  DEFAULT_PIN_TO,
  type Annotation,
  type FramingRequest,
  type Match,
} from "../index";

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

/** The Brand every FramingRequest and Match sample below is cut for. */
export const brand = "hope-family";

/** A full FramingRequest: named persons, an anchor, a Subject Area, two zones. */
export const framingRequest: FramingRequest = {
  brand,
  source: { hash: annotation.hash },
  target: { width: 1080, height: 1350, format: "jpeg", quality: 82 },
  pinTo: ["match", "face"],
  persons: ["p-nino", "p-lea"],
  anchor: "top",
  subjectArea: { x: 0.05, y: 0.05, width: 0.9, height: 0.55 },
  occlusion: [
    { x: 0, y: 0.72, width: 1, height: 0.28 },
    { x: 0.7, y: 0, width: 0.3, height: 0.14 },
  ],
  redaction: { blurUnknownFaces: true },
};

/** Every optional field left out, and `anchor` at its default. */
export const minimalFramingRequest: FramingRequest = {
  brand,
  source: { hash: annotation.hash },
  target: { width: 1080, height: 1080 },
  pinTo: DEFAULT_PIN_TO,
  anchor: DEFAULT_ANCHOR,
  occlusion: [],
  redaction: { blurUnknownFaces: false },
};

/** One named sample per rule the ticket calls out. The name is what a red run prints. */
export const invalidFramingRequests: { name: string; value: unknown }[] = [
  {
    name: "a template id, which belongs to the gateway and not here",
    value: { ...framingRequest, template: "story-1" },
  },
  {
    name: "a source given as a URL instead of a Content Hash",
    value: { ...framingRequest, source: "https://example.com/a.jpg" },
  },
  { name: "an empty pinTo", value: { ...framingRequest, pinTo: [] } },
  {
    name: "a duplicate in pinTo",
    value: { ...framingRequest, pinTo: ["match", "face", "match"] },
  },
  {
    name: "the British spelling of the centre anchor",
    value: { ...framingRequest, anchor: "centre" },
  },
  {
    name: "a target width of half a pixel",
    value: {
      ...framingRequest,
      target: { ...framingRequest.target, width: 1080.5 },
    },
  },
  {
    name: "a quality of 0",
    value: {
      ...framingRequest,
      target: { ...framingRequest.target, quality: 0 },
    },
  },
  {
    name: "an occlusion zone whose x + width is above 1",
    value: {
      ...framingRequest,
      occlusion: [{ x: 0.9, y: 0.1, width: 0.2, height: 0.2 }],
    },
  },
  {
    name: "more occlusion zones than the free-area sweep can afford",
    value: {
      ...framingRequest,
      // One past the cap of 16 the schema sets.
      occlusion: Array.from({ length: 17 }, (_, i) => ({
        x: 0,
        y: i / 100,
        width: 0.1,
        height: 0.01,
      })),
    },
  },
  { name: "an empty brand", value: { ...framingRequest, brand: "" } },
  {
    name: "a persons list with an empty id",
    value: { ...framingRequest, persons: [""] },
  },
];

/** One Match: this face Region is this Person, for this Brand, on this call. */
export const match: Match = {
  regionId: face.id,
  personId: "p-nino",
  brand,
  similarity: 0.71,
};

export const invalidMatches: { name: string; value: unknown }[] = [
  {
    name: "a similarity above 1",
    value: { ...match, similarity: 1.0001 },
  },
  {
    name: "a similarity below -1",
    value: { ...match, similarity: -1.0001 },
  },
  { name: "an empty brand", value: { ...match, brand: "" } },
  { name: "an empty person id", value: { ...match, personId: "" } },
  {
    name: "a region id that is not <kind>-<n>",
    value: { ...match, regionId: "face_1" },
  },
];
