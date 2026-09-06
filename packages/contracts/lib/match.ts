import { z } from "zod";
import { RegionId } from "./annotation";
import { Brand, PersonId } from "./identifiers";

/**
 * What a Match names whichever rule made it: the Region that is this Person,
 * the Person, and the Brand that knows them.
 */
const Names = {
  regionId: RegionId,
  personId: PersonId,
  brand: Brand,
};

/**
 * Who a Region is, for one Brand, on one call. Beside the Annotation and never
 * inside it: another Brand knows another set of Persons, so the same face in
 * the same bytes matches differently and the Annotation stays true of the bytes.
 *
 * `by` says which Match Rule answered, and the two rules carry different
 * evidence. A face Match is a cosine of two Face Prints. A number Match is a
 * digit somebody painted on a kart, read off the photograph and found on the
 * Brand's own list — there is no cosine to report, and a `1` in that field
 * would be a measurement nobody took. So the two are a union rather than one
 * shape with an optional half, and a consumer reading `similarity` has to say
 * which rule it is reading it off.
 *
 * `by` has no default. A Match with none is refused, because the field decides
 * what the rest of the object means and a guess about that is worse than a
 * parse error.
 */
export const Match = z.discriminatedUnion("by", [
  z.strictObject({
    ...Names,
    by: z.literal("face"),
    /** Cosine of two Face Prints, so the whole range is legal, not just [0, 1]. */
    similarity: z.number().min(-1).max(1),
  }),
  z.strictObject({
    ...Names,
    by: z.literal("number"),
    /**
     * The `number` Region whose label was read. Never `regionId`: that one is
     * the `vehicle` the number sits on, because the kart is what a Crop frames
     * and a Crop of the digits alone would be of nothing.
     */
    numberRegionId: RegionId,
  }),
]);

export type Match = z.infer<typeof Match>;

/** How a Match was made. The discriminant, named so a consumer can hold it. */
export type MatchRule = Match["by"];
