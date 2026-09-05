import { z } from "zod";
import { Box, Point, pixels } from "./geometry";
import { ContentHash } from "./identifiers";

/** What a Model drew a Region around. meco's closed set; it grows by PR. */
export const RegionKind = z.enum(["face", "person", "vehicle"]);

/** A Model, named and versioned. Both halves are needed to tell two runs apart. */
export const ModelId = z.strictObject({
  name: z.string().min(1),
  /**
   * Changes whenever anything that can change the Model's output changes:
   * weights, preprocessing, class list, thresholds, ONNX runtime major. A
   * consumer names the `{ name, version }` pairs it requires and `isComplete`
   * answers; bump this for any of them, or a cached Annotation answers for a
   * Model that no longer runs.
   */
  version: z.string().min(1),
});

/** The five named face points, in fractions. Named from the subject's side. */
export const Landmarks = z.strictObject({
  rEye: Point,
  lEye: Point,
  nose: Point,
  rMouth: Point,
  lMouth: Point,
});

/** How close to unit length a Face Print vector must be. */
const UNIT_LENGTH_TOLERANCE = 1e-3;

/** Whether a Face Print vector is unit length. The rule, in one place. */
export const isUnitLength = (vector: number[]): boolean =>
  Math.abs(Math.hypot(...vector) - 1) <= UNIT_LENGTH_TOLERANCE;

/**
 * A Face Print's fields, without the unit-length rule. Private: the exported
 * {@link FacePrint} adds the rule, and the adapter Conformance Checks assert
 * it under their own name.
 */
const FacePrintFields = z.strictObject({
  model: ModelId,
  vector: z.array(z.number().finite()).min(1),
});

/**
 * A Face Print with the network that made it. Its own Model, because the print
 * comes from a different network than the box, and prints from two networks
 * are not comparable.
 */
export const FacePrint = FacePrintFields.refine((e) => isUnitLength(e.vector), {
  error: `vector must be unit length within ${UNIT_LENGTH_TOLERANCE}`,
  path: ["vector"],
});

/**
 * `<kind>-<n>`, `n` from 1. Built from {@link RegionKind}, so a kind added to
 * the enum is legal in an id without a second edit here.
 */
const REGION_ID = new RegExp(
  `^(?:${RegionKind.options.join("|")})-[1-9][0-9]*$`
);

/** The id rule alone, so a Match keys by a Region without restating the shape. */
export const RegionId = z.string().regex(REGION_ID);

/**
 * A Region's own fields, each with its own rule, and none of the rules that
 * read two fields at once. Split out because the adapter Conformance Checks
 * name those cross-field rules one by one: were they folded in here, a face
 * missing its landmarks would fail the check that parses a Region as well as
 * the check named for landmarks, and a red run would stop saying which rule
 * broke. {@link Region} layers all of them back on.
 */
export const RegionFields = z.strictObject({
  kind: RegionKind,
  /** The Model's own word (`motorbike`). Never selected on: that is `kind`. */
  label: z.string().min(1),
  box: Box,
  score: z.number().min(0).max(1),
  model: ModelId,
  landmarks: Landmarks.optional(),
  facePrint: FacePrintFields.optional(),
});

/** Whether a Region that is a face carries the landmarks a face must have. */
export const hasFaceLandmarks = (r: {
  kind: RegionKind;
  landmarks?: unknown;
}): boolean => r.kind !== "face" || r.landmarks !== undefined;

const printOnlyOnFace = (r: { kind: RegionKind; facePrint?: unknown }) =>
  r.facePrint === undefined || r.kind === "face";

const PRINT_ON_A_FACE = {
  error: "only a face region carries a face print in schema 1",
  path: ["facePrint"],
};

/**
 * What the adapter Conformance Check that parses a Region parses against: the
 * field rules, plus the one cross-field rule no check is named for. The two
 * that are named — a face's landmarks, a print's length — are left out, so a
 * defect fails the check it is named by and no other. The three checks
 * together hold everything {@link Region} holds bar its id.
 */
export const AdapterRegionRules = RegionFields.refine(
  printOnlyOnFace,
  PRINT_ON_A_FACE
);

/** One thing a Model found in the bytes. True of the bytes, so cached forever. */
export const Region = RegionFields.extend({ id: RegionId })
  .refine((r) => r.id.startsWith(`${r.kind}-`), {
    error: "id must be prefixed with its kind",
    path: ["id"],
  })
  .refine(hasFaceLandmarks, {
    error: "a face region must carry landmarks",
    path: ["landmarks"],
  })
  .refine(printOnlyOnFace, PRINT_ON_A_FACE)
  .refine(
    (r) => r.facePrint === undefined || isUnitLength(r.facePrint.vector),
    {
      error: `a face print vector must be unit length within ${UNIT_LENGTH_TOLERANCE}`,
      path: ["facePrint", "vector"],
    }
  );

export type RegionKind = z.infer<typeof RegionKind>;
export type ModelId = z.infer<typeof ModelId>;
export type Landmarks = z.infer<typeof Landmarks>;
export type FacePrint = z.infer<typeof FacePrint>;
export type Region = z.infer<typeof Region>;

/** The schema number this build writes. An unknown number means re-annotate. */
export const ANNOTATION_SCHEMA = 1;

/** The image formats the models host promises to decode. Grows by PR. */
const Mime = z.enum(["image/jpeg", "image/png", "image/webp"]);

/** One string per `{ name, version }`, so two Models compare as a whole. */
const modelKey = (m: z.infer<typeof ModelId>) => `${m.name}@${m.version}`;

/**
 * Everything known about the bytes. Keyed by Content Hash, cached forever,
 * shared by every Brand. Holds only what is true of the bytes: anything a
 * second output could disagree about belongs on the FramingRequest instead.
 */
export const Annotation = z
  .strictObject({
    schema: z.literal(ANNOTATION_SCHEMA),
    hash: ContentHash,
    mime: Mime,
    /** Pixels, as a viewer sees the image: after EXIF orientation. */
    width: pixels,
    height: pixels,
    /** Every Model that ran. A missing one is a cache miss, never a wrong answer. */
    producedBy: z.array(ModelId),
    regions: z.array(Region),
  })
  .refine(
    (a) => new Set(a.producedBy.map(modelKey)).size === a.producedBy.length,
    {
      error: "producedBy must not name a model twice",
      path: ["producedBy"],
    }
  )
  .refine(
    (a) => new Set(a.regions.map((r) => r.id)).size === a.regions.length,
    {
      error: "two regions must not share an id",
      path: ["regions"],
    }
  );

export type Annotation = z.infer<typeof Annotation>;

/**
 * Whether every Model a consumer requires is in `producedBy`, version and all.
 * A `false` is a cache miss: the bytes must be annotated again. Comparing the
 * version is the point — an Annotation made by an older adapter would
 * otherwise answer for a Model that no longer runs.
 */
export const isComplete = (
  annotation: Annotation,
  required: ModelId[]
): boolean => {
  const ran = new Set(annotation.producedBy.map(modelKey));
  return required.every((model) => ran.has(modelKey(model)));
};
