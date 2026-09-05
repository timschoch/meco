import { z } from "zod";
import { Box, Point, pixels } from "./geometry";

/** What a Model drew a Region around. meco's closed set; it grows by PR. */
export const RegionKind = z.enum(["face", "person", "vehicle"]);

/**
 * A Model and the version of everything that can change its output: weights,
 * preprocessing, class list, thresholds, runtime major. Bump `version` for any
 * of them, or a cached Annotation answers for a Model that no longer runs.
 */
export const ModelId = z.strictObject({
  name: z.string().min(1),
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

/**
 * A Face Print with the network that made it. Its own Model, because the print
 * comes from a different network than the box, and prints from two networks
 * are not comparable.
 */
export const FacePrint = z
  .strictObject({
    model: ModelId,
    vector: z.array(z.number().finite()).min(1),
  })
  .refine(
    (e) => Math.abs(Math.hypot(...e.vector) - 1) <= UNIT_LENGTH_TOLERANCE,
    {
      error: `vector must be unit length within ${UNIT_LENGTH_TOLERANCE}`,
      path: ["vector"],
    }
  );

/**
 * `<kind>-<n>`, `n` from 1. Built from {@link RegionKind}, so a kind added to
 * the enum is legal in an id without a second edit here.
 */
const REGION_ID = new RegExp(
  `^(?:${RegionKind.options.join("|")})-[1-9][0-9]*$`
);

/** One thing a Model found in the bytes. True of the bytes, so cached forever. */
export const Region = z
  .strictObject({
    id: z.string().regex(REGION_ID),
    kind: RegionKind,
    /** The Model's own word (`motorbike`). Never selected on: that is `kind`. */
    label: z.string().min(1),
    box: Box,
    score: z.number().min(0).max(1),
    model: ModelId,
    landmarks: Landmarks.optional(),
    facePrint: FacePrint.optional(),
  })
  .refine((r) => r.id.startsWith(`${r.kind}-`), {
    error: "id must be prefixed with its kind",
    path: ["id"],
  })
  .refine((r) => r.kind !== "face" || r.landmarks !== undefined, {
    error: "a face region must carry landmarks",
    path: ["landmarks"],
  })
  .refine((r) => r.facePrint === undefined || r.kind === "face", {
    error: "only a face region carries a face print in schema 1",
    path: ["facePrint"],
  });

export type RegionKind = z.infer<typeof RegionKind>;
export type ModelId = z.infer<typeof ModelId>;
export type Landmarks = z.infer<typeof Landmarks>;
export type FacePrint = z.infer<typeof FacePrint>;
export type Region = z.infer<typeof Region>;

/** The schema number this build writes. An unknown number means re-annotate. */
export const ANNOTATION_SCHEMA = 1;

/** The image formats the models host promises to decode. Grows by PR. */
const Mime = z.enum(["image/jpeg", "image/png", "image/webp"]);

/** Bare sha256 of the bytes. No algorithm prefix: the schema fixes it. */
const ContentHash = z.string().regex(/^[0-9a-f]{64}$/);

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
