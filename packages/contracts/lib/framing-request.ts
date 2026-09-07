import { z } from "zod";
import { Box, Size } from "./geometry";
import { Brand, ContentHash, PersonId } from "./identifiers";

/**
 * What the caller wants the Subject composed from, walked in order until one
 * yields. `match` and not `person`: a Region Kind of `person` is a detected
 * human body, while this value means a face meco can put a name to.
 */
export const PinTo = z.enum(["match", "face", "kart"]);

/**
 * The ladder frame walks when the caller names none. A constant and not a
 * schema default, so the stored call record shows what the caller sent.
 *
 * `kart` before `face`, decided on #109. The shipped YuNet finds a helmeted
 * driver's head through a visor — 0.6488 on `on-track-rear-helmet.jpg`, 0.8080
 * on `on-track-visor-open.jpg` — so `face` first turned a karting photograph
 * into a visor close-up and lost the livery it was taken for. `kart` yields
 * only on a `vehicle` Region, so a photograph without one still falls to
 * `face`. Ordered by how specific the answer is, not by how good the detector
 * is.
 */
export const DEFAULT_PIN_TO: PinTo[] = ["match", "kart", "face"];

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

/** Where frame anchors when the caller names none. A constant for the same reason. */
export const DEFAULT_ANCHOR: CropAnchor = "center";

/** What the Crop is rendered as. A {@link Size}, so target and image size cannot drift. */
export const Target = Size.extend({
  format: z.enum(["png", "jpeg", "webp"]).optional(),
  quality: z.int().min(1).max(100).optional(),
});

/** What must not be shown. One flag in v1; the policy grows by PR. */
export const Redaction = z.strictObject({
  blurUnknownFaces: z.boolean(),
});

/**
 * A Redaction Policy as a level that is not the last one may declare it: every
 * field optional, because a level says what it has an opinion about and stays
 * silent on the rest (#249).
 *
 * A request, a Template and a Brand each hand one of these to the gateway,
 * which resolves them field by field down to the {@link Redaction} the
 * FramingRequest carries. An absent field is not `false`: it falls to the next
 * level, so silence and a decision must stay tellable apart — which is what
 * makes this a separate shape rather than {@link Redaction} with a default.
 *
 * Here and not in whichever module declares one, because three of them do:
 * compose types a Template's, records stores a Brand's, and the gateway reads
 * both.
 */
export const RedactionDefault = z.strictObject({
  blurUnknownFaces: z.boolean().optional(),
});

/**
 * The most Occlusion Zones one request may declare. A design bound, not a
 * measurement: frame's free-area sweep is O(n^4) in the zone count and a
 * Template emits two or three, so the cap refuses abuse at the edge where
 * refusals belong and never honest work. Decided on #82.
 */
export const MAX_OCCLUSION_ZONES = 16;

/**
 * Everything true of one output and of nothing else. Never cached and never a
 * key: two Crops from the same bytes may disagree about every field here, which
 * is exactly what keeps them off the Annotation.
 */
export const FramingRequest = z.strictObject({
  brand: Brand,
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
  persons: z.array(PersonId).optional(),
  /** frame reads `anchor ?? DEFAULT_ANCHOR`; the schema fills in nothing. */
  anchor: CropAnchor.optional(),
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
export type RedactionDefault = z.infer<typeof RedactionDefault>;
export type FramingRequest = z.infer<typeof FramingRequest>;
