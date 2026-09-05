// Fixtures for the frame tests. Private to tests/ by the boundary rules.
//
// Every fixture is parsed by the contracts schema before it reaches
// `frameCrop`, so a fixture that drifts from the contract fails frame's suite
// rather than rotting quietly.
import {
  Annotation,
  DEFAULT_PIN_TO,
  FramingRequest,
  type Box,
  type Landmarks,
  type ModelId,
  type Size,
} from "@meco/contracts";
import artemis2Crew from "./fixtures/artemis-2-crew.json";
import astronautPortrait from "./fixtures/astronaut-portrait.json";
import soyuzCrew from "./fixtures/soyuz-crew.json";

const HASH = "7c".repeat(32);

/** The Model the synthetic Annotations below name. Nothing reads it. */
const MODEL: ModelId = { name: "yunet", version: "prototype" };

/**
 * An Annotation of a source of the given size with no Regions at all: the one
 * input this ticket answers, since no rung of `pinTo` can compose a Subject
 * from nothing.
 */
export const emptyAnnotation = (source: Size): Annotation =>
  Annotation.parse({
    schema: 1,
    hash: HASH,
    mime: "image/jpeg",
    width: source.width,
    height: source.height,
    producedBy: [],
    regions: [],
  });

/** A request for one target size, everything optional left out. */
export const requestFor = (
  target: Size,
  extra: Record<string, unknown> = {}
): FramingRequest =>
  FramingRequest.parse({
    brand: "hope-family",
    source: { hash: HASH },
    target,
    pinTo: DEFAULT_PIN_TO,
    occlusion: [],
    redaction: { blurUnknownFaces: false },
    ...extra,
  });

/**
 * Landmarks placed inside a box by proportion. A face Region must carry them,
 * and no test in this ticket reads one: the Eye Line arrives on #103.
 */
const landmarksIn = (box: Box): Landmarks => ({
  rEye: { x: box.x + 0.3 * box.width, y: box.y + 0.4 * box.height },
  lEye: { x: box.x + 0.7 * box.width, y: box.y + 0.4 * box.height },
  nose: { x: box.x + 0.5 * box.width, y: box.y + 0.55 * box.height },
  rMouth: { x: box.x + 0.35 * box.width, y: box.y + 0.75 * box.height },
  lMouth: { x: box.x + 0.65 * box.width, y: box.y + 0.75 * box.height },
});

/**
 * An Annotation carrying one face at a box the test chose. For the geometry no
 * recording happens to contain — a Subject exactly on the frame centre, say.
 */
export const oneFaceAnnotation = (source: Size, box: Box): Annotation =>
  Annotation.parse({
    schema: 1,
    hash: HASH,
    mime: "image/jpeg",
    width: source.width,
    height: source.height,
    producedBy: [MODEL],
    regions: [
      {
        id: "face-1",
        kind: "face",
        label: "face",
        box,
        score: 0.9,
        model: MODEL,
        landmarks: landmarksIn(box),
      },
    ],
  });

/**
 * An Annotation with Regions but no face among them, so the face rung has
 * nothing to compose and the ladder must walk past it.
 */
export const vehicleAnnotation = (source: Size): Annotation =>
  Annotation.parse({
    schema: 1,
    hash: HASH,
    mime: "image/jpeg",
    width: source.width,
    height: source.height,
    producedBy: [MODEL],
    regions: [
      {
        id: "vehicle-1",
        kind: "vehicle",
        label: "motorbike",
        box: { x: 0.2, y: 0.3, width: 0.5, height: 0.4 },
        score: 0.88,
        model: MODEL,
      },
    ],
  });

/**
 * The three photographs with faces in them, converted from
 * `fixtures/faces/detected.json` — real YuNet output — into contracts
 * Annotations. Held as the JSON that is checked in, so every test parses it and
 * a fixture that drifts from the contract fails frame's suite.
 *
 * `leadRegionId` is the largest face box, written out rather than re-derived:
 * a mutation of the largest-face rule must not be able to mutate the
 * expectation with it.
 */
export const FACE_FIXTURES: {
  name: string;
  raw: unknown;
  leadRegionId: string;
}[] = [
  {
    name: "astronaut-portrait.jpg",
    raw: astronautPortrait,
    leadRegionId: "face-1",
  },
  { name: "artemis-2-crew.jpg", raw: artemis2Crew, leadRegionId: "face-4" },
  { name: "soyuz-crew.jpg", raw: soyuzCrew, leadRegionId: "face-2" },
];

/** The four Placement shapes meco renders, as target sizes. */
export const TARGETS: { name: string; target: Size }[] = [
  { name: "1:1", target: { width: 1080, height: 1080 } },
  { name: "4:5", target: { width: 1080, height: 1350 } },
  { name: "9:16", target: { width: 1080, height: 1920 } },
  { name: "16:9", target: { width: 1920, height: 1080 } },
];

/** Source sizes, including odd ones, so rounding is exercised and not assumed. */
export const SOURCES: Size[] = [
  { width: 4000, height: 3000 },
  { width: 3000, height: 4000 },
  { width: 1280, height: 1600 },
  { width: 1001, height: 667 },
  { width: 999, height: 1777 },
  { width: 512, height: 512 },
];
