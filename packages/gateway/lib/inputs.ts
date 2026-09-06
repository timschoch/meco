/**
 * The input pieces more than one Operation is built from, in one file so that
 * the pipeline that reads them and the table that declares them can both have
 * them without importing each other.
 *
 * Every field here is optional at the door and the defaults are applied in the
 * pipeline, not by the schema: the Call row then shows what the caller sent
 * rather than what the gateway filled in (ADR-0014, Decision 6).
 */
import { CropAnchor, PinTo } from "@meco/contracts";
import { z } from "zod";

export const Brand = z
  .string()
  .min(1)
  .describe("The Brand this request is for.");

/**
 * The race numbers a Person carries, as a Brand may set them.
 *
 * One to three digits, and nothing else. That is exactly what the number
 * reader labels a `number` Region with (`docs/specs/models.md`, `ppocr`), so a
 * Person number of any other shape could never be read off a photograph and
 * would be a dead letter the caller was never told about. Refusing it at the
 * door is the only place that can say so.
 *
 * Compared as text, so `04` and `4` are two different numbers and the Brand
 * types what is painted on the kart.
 */
export const RaceNumbers = z
  .array(
    z
      .string()
      .regex(/^[0-9]{1,3}$/, "a race number is one to three digits")
      .describe("A race number as it is painted on the kart, e.g. `24`.")
  )
  .max(16)
  .describe(
    "The race numbers this Person carries, one to three digits each. One number is one Person within a Brand."
  );

/** What `render` and `crop` share. */
export const FramingOptions = {
  pinTo: z
    .array(PinTo)
    .min(1)
    .optional()
    .describe(
      "The ladder frame walks to find the Subject. Default match, kart, face."
    ),
  persons: z
    .array(z.string().min(1))
    .optional()
    .describe("Person ids that may lead."),
  anchor: CropAnchor.optional(),
  redaction: z
    .object({
      blurUnknownFaces: z
        .boolean()
        .optional()
        .describe("Hide every face meco cannot name. Default true."),
    })
    .optional(),
  format: z.enum(["png", "jpeg", "webp"]).optional(),
  quality: z.int().min(1).max(100).optional(),
};
