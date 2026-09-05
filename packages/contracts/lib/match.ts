import { z } from "zod";
import { RegionId } from "./annotation";

/**
 * Who a Region is, for one Brand, on one call. Beside the Annotation and never
 * inside it: another Brand knows another set of Persons, so the same face in
 * the same bytes matches differently and the Annotation stays true of the bytes.
 */
export const Match = z.strictObject({
  regionId: RegionId,
  personId: z.string().min(1),
  brand: z.string().min(1),
  /** Cosine of two Face Prints, so the whole range is legal, not just [0, 1]. */
  similarity: z.number().min(-1).max(1),
});

export type Match = z.infer<typeof Match>;
