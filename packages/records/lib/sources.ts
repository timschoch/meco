/**
 * Source Holds, as far as Erasure needs them.
 *
 * The Reference Count of a File is its rows in `sources` plus its rows in
 * `reference_photos`. Erasing a Person therefore has to be able to see a Source
 * Hold, or it would delete the bytes of a photograph another Brand is still
 * entitled to a Signed URL for. That is the whole reason this file is here in
 * this slice: without it the `sources` half of the count is code no check can
 * reach.
 *
 * **Owned by [#164](https://github.com/timschoch/meco/issues/164)**, which adds
 * `sources.release`, the Retention Window and the Sweep. When the two land, the
 * later PR drops whichever copy is the duplicate.
 */
import { and, eq } from "drizzle-orm";
import type { DatabaseDriver } from "./database";
import { sources } from "./schema";

export interface Sources {
  /** One Brand has used one Source Image. Idempotent: holding twice is one row. */
  hold(brand: string, hash: string): Promise<void>;
  /** Whether this Brand holds this Source Image. The Signed URL lookup. */
  heldBy(brand: string, hash: string): Promise<boolean>;
}

export function sourcesOver(driver: DatabaseDriver): Sources {
  const { orm } = driver;

  return {
    async hold(brand, hash) {
      await orm.insert(sources).values({ brand, hash }).onConflictDoNothing();
    },

    async heldBy(brand, hash) {
      const [row] = await orm
        .select({ brand: sources.brand })
        .from(sources)
        .where(and(eq(sources.brand, brand), eq(sources.hash, hash)))
        .limit(1);
      return row !== undefined;
    },
  };
}
