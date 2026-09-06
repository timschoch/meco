/**
 * The Reference Count of a File, written once.
 *
 * Two callers ask it: an Erasure, for the hashes a Person's Reference Photos
 * named, and the Sweep, for every File older than the Retention Window. Both
 * ask the same question — does any Brand still hold these bytes as a Source
 * Image, or any Person still have them as a Reference Photo — and the answer
 * decides whether a photograph is deleted. Two copies of it would be two places
 * for the `sources` half to go missing from, and the check that catches that is
 * the check that would then only catch one of them.
 */
import { type SQL, eq, notExists, sql } from "drizzle-orm";
import type { Tx } from "./database";
import { files, referencePhotos, sources } from "./schema";

/**
 * The clauses that hold of a File nothing references any more, to be spread
 * into the `and(...)` of a query already selecting from {@link files}.
 *
 * A pair rather than one `and`, because drizzle's `and` is `SQL | undefined`
 * and a Reference Count that could be `undefined` is a Reference Count that
 * could quietly become "delete everything".
 */
export function unreferencedFileClauses(tx: Tx): [SQL, SQL] {
  return [
    notExists(
      tx
        .select({ held: sql`1` })
        .from(sources)
        .where(eq(sources.hash, files.hash))
    ),
    notExists(
      tx
        .select({ enrolled: sql`1` })
        .from(referencePhotos)
        .where(eq(referencePhotos.hash, files.hash))
    ),
  ];
}
