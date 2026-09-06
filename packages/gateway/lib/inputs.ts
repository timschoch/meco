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
