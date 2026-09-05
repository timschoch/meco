import { z } from "zod";
import { ContentHash } from "./annotation";
import { Box, pixels } from "./geometry";

/**
 * What the caller wants the Subject composed from, walked in order until one
 * yields. `match` and not `person`: a Region Kind of `person` is a detected
 * human body, while this value means a face meco can put a name to.
 */
export const PinTo = z.enum(["match", "face", "kart"]);

/** The caller's ladder when it names none. Applied by the gateway, not the schema. */
export const DEFAULT_PIN_TO: PinTo[] = ["match", "face", "kart"];

/** Where frame falls back to when nothing on the ladder yields. */
export const CropAnchor = z.enum([
  "top-left",
  "top",
  "top-right",
  "left",
  "center",
  "right",
  "bottom-left",
  "bottom",
  "bottom-right",
]);

/** `center`, never `centre`: the spelling contracts fixes for every identifier. */
export const DEFAULT_ANCHOR: CropAnchor = "center";

/** What the Crop is rendered as. Whole pixels, so nothing downstream rounds twice. */
export const Target = z.strictObject({
  width: pixels,
  height: pixels,
  format: z.enum(["png", "jpeg", "webp"]).optional(),
  quality: z.int().min(1).max(100).optional(),
});

/** What must not be shown. One flag in v1; the policy grows by PR. */
export const Redaction = z.strictObject({
  blurUnknownFaces: z.boolean(),
});

/**
 * The most Occlusion Zones one request may declare. frame's free-area sweep is
 * O(n^4) in the zone count and a Template emits two or three, so the cap
 * refuses abuse at the gateway edge and never honest work.
 */
const MAX_OCCLUSION_ZONES = 16;

/**
 * Everything true of one output and of nothing else. Never cached and never a
 * key: two Crops from the same bytes may disagree about every field here, which
 * is exactly what keeps them off the Annotation.
 */
export const FramingRequest = z.strictObject({
  brand: z.string().min(1),
  /** The bytes, by Content Hash. A URL belongs to the gateway's own input type. */
  source: z.strictObject({ hash: ContentHash }),
  target: Target,
  pinTo: z
    .array(PinTo)
    .min(1)
    .refine((p) => new Set(p).size === p.length, {
      error: "pinTo must not name a rung twice",
    }),
  /** Person ids that may lead. Absent means any named Person may. */
  persons: z.array(z.string().min(1)).min(1).optional(),
  anchor: CropAnchor.default(DEFAULT_ANCHOR),
  /** Where the Subject must land, in Image Slot fractions. */
  subjectArea: Box.optional(),
  /** What the Template will cover, in Image Slot fractions. May be empty. */
  occlusion: z.array(Box).max(MAX_OCCLUSION_ZONES),
  redaction: Redaction,
});

export type PinTo = z.infer<typeof PinTo>;
export type CropAnchor = z.infer<typeof CropAnchor>;
export type Target = z.infer<typeof Target>;
export type Redaction = z.infer<typeof Redaction>;
export type FramingRequest = z.infer<typeof FramingRequest>;
