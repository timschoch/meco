// Fixtures for the frame tests. Private to tests/ by the boundary rules.
//
// Every fixture is parsed by the contracts schema before it reaches
// `frameCrop`, so a fixture that drifts from the contract fails frame's suite
// rather than rotting quietly.
import {
  Annotation,
  DEFAULT_PIN_TO,
  FramingRequest,
  Match,
  type Box,
  type Landmarks,
  type ModelId,
  type Size,
} from "@meco/contracts";
import artemis2Crew from "./fixtures/artemis-2-crew.json";
import astronautPortrait from "./fixtures/astronaut-portrait.json";
import onTrackDarkVisor from "./fixtures/on-track-dark-visor.json";
import onTrackRearHelmet from "./fixtures/on-track-rear-helmet.json";
import onTrackVisorOpen from "./fixtures/on-track-visor-open.json";
import paddockMixed from "./fixtures/paddock-mixed.json";
import podiumTrophy from "./fixtures/podium-trophy.json";
import podiumTrophy2 from "./fixtures/podium-trophy-2.json";
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

/**
 * The Brand every request below is made for. Named once, so a Match built for
 * another Brand has to say so and cannot become one by a typo.
 */
export const BRAND = "hope-family";

/**
 * A Match, parsed by the contracts schema like every other fixture here. For
 * this Brand unless the test names another: crossing the Brand wall is
 * something a check states out loud.
 */
export const matchOf = (
  regionId: string,
  personId: string,
  similarity: number,
  brand: string = BRAND
): Match => Match.parse({ regionId, personId, brand, similarity });

/** A request for one target size, everything optional left out. */
export const requestFor = (
  target: Size,
  extra: Record<string, unknown> = {}
): FramingRequest =>
  FramingRequest.parse({
    brand: BRAND,
    source: { hash: HASH },
    target,
    pinTo: DEFAULT_PIN_TO,
    occlusion: [],
    redaction: { blurUnknownFaces: false },
    ...extra,
  });

/**
 * Where {@link oneFaceAnnotation} puts the eyes, as a fraction of the Source
 * Image height. Exported so an Eye Line check reads the proportion off the
 * fixture rather than restating it, which would let the two drift apart.
 */
export const eyeLineOfSample = (box: Box): number => box.y + 0.4 * box.height;

/** Landmarks placed inside a box by proportion. A face Region must carry them. */
const landmarksIn = (box: Box): Landmarks => ({
  rEye: { x: box.x + 0.3 * box.width, y: eyeLineOfSample(box) },
  lEye: { x: box.x + 0.7 * box.width, y: eyeLineOfSample(box) },
  nose: { x: box.x + 0.5 * box.width, y: box.y + 0.55 * box.height },
  rMouth: { x: box.x + 0.35 * box.width, y: box.y + 0.75 * box.height },
  lMouth: { x: box.x + 0.65 * box.width, y: box.y + 0.75 * box.height },
});

/**
 * An Annotation carrying one face at a box the test chose. For the geometry no
 * recording happens to contain — a Subject exactly on the frame centre, say, or
 * a head tilted far enough that its two eyes sit at different heights.
 */
export const oneFaceAnnotation = (
  source: Size,
  box: Box,
  landmarks: Landmarks = landmarksIn(box)
): Annotation =>
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
        landmarks,
      },
    ],
  });

/**
 * An Annotation with Regions but no face among them, so the face rung has
 * nothing to compose and the ladder must walk past it. Carrying no landmarks it
 * also carries no Eye Line, which is what makes it the quiet fixture for a rule
 * that must be read off the aim alone: the window is the cover window and
 * nothing zooms it.
 */
export const vehicleAnnotation = (
  source: Size,
  box: Box = { x: 0.2, y: 0.3, width: 0.5, height: 0.4 }
): Annotation =>
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
        box,
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

/**
 * The six karting photographs, converted from `fixtures/karts/objects.json` —
 * real D-FINE output — into contracts Annotations by the Region Kind table in
 * `CONTEXT.md`, models: `person` becomes `person`, `motorbike` becomes
 * `vehicle`, and every other COCO Label draws no Region. `boat`, `handbag` and
 * `baseball bat` are dropped there and never reach frame.
 *
 * `subject` is what the prototype's rule composed, recorded beside the
 * detections in that file and verified by rendering it over the photograph. It
 * is the regression target, so it is copied here rather than re-derived: a
 * mutation of the rule must not be able to mutate the expectation with it. The
 * same holds for `leadRegionId` and `keptRegionIds`.
 *
 * `keptRegionIds` is in tier order, so the seed leads and the Regions it joined
 * follow by Region id. No Match names a `person` or a `vehicle`, so the kart
 * rung has no middle tier and these are its two.
 */
export const KART_FIXTURES: {
  name: string;
  raw: unknown;
  leadRegionId: string;
  keptRegionIds: string[];
  subject: Box;
}[] = [
  {
    name: "on-track-dark-visor.jpg",
    raw: onTrackDarkVisor,
    leadRegionId: "vehicle-1",
    keptRegionIds: ["vehicle-1", "person-1", "person-2", "vehicle-2"],
    subject: { x: 0.4008, y: 0.0973, width: 0.4337, height: 0.4956 },
  },
  {
    name: "on-track-rear-helmet.jpg",
    raw: onTrackRearHelmet,
    leadRegionId: "vehicle-1",
    keptRegionIds: ["vehicle-1", "person-1"],
    subject: { x: 0.1408, y: 0.2578, width: 0.5878, height: 0.5205 },
  },
  {
    name: "on-track-visor-open.jpg",
    raw: onTrackVisorOpen,
    leadRegionId: "vehicle-2",
    keptRegionIds: ["vehicle-2", "person-1", "person-2"],
    subject: { x: 0.0077, y: 0.2626, width: 0.9481, height: 0.6218 },
  },
  {
    name: "paddock-mixed.jpg",
    raw: paddockMixed,
    leadRegionId: "vehicle-1",
    keptRegionIds: [
      "vehicle-1",
      "person-1",
      "person-6",
      "person-18",
      "person-19",
      "person-22",
      "person-23",
      "person-24",
      "person-25",
      "vehicle-2",
    ],
    subject: { x: 0.2703, y: 0, width: 0.4951, height: 0.7614 },
  },
  {
    name: "podium-trophy.jpg",
    raw: podiumTrophy,
    leadRegionId: "person-1",
    keptRegionIds: ["person-1"],
    subject: { x: 0.237, y: 0.0908, width: 0.4067, height: 0.8969 },
  },
  {
    name: "podium-trophy-2.jpg",
    raw: podiumTrophy2,
    leadRegionId: "person-1",
    keptRegionIds: ["person-1", "person-2"],
    subject: { x: 0.1465, y: 0.1108, width: 0.6732, height: 0.8823 },
  },
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
