// Fixtures for the frame tests. Private to tests/ by the boundary rules.
//
// Every fixture is parsed by the contracts schema before it reaches
// `frameCrop`, so a fixture that drifts from the contract fails frame's suite
// rather than rotting quietly.
import {
  Annotation,
  DEFAULT_PIN_TO,
  FramingRequest,
  type Size,
} from "@meco/contracts";

const HASH = "7c".repeat(32);

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
