/**
 * Source Holds: which Brand has used which Source Image.
 *
 * One row does two jobs, and they are worth keeping apart.
 *
 * It **authorises**: `heldBy` is the lookup the gateway makes before minting a
 * Signed URL for a source, and the webui's Source Thumbnail redirect makes the
 * same one. It answers from `sources` and never from `files` or `calls` — that
 * the bytes exist is not that this Brand may see them, and a Call is itself
 * something a Brand may one day want deleted.
 *
 * It **keeps the File alive**: a hold is half the Reference Count, so a
 * photograph one Brand still holds survives another Brand's Erasure and the
 * Sweep. `release` is therefore a delete with consequences — the last hold to
 * go leaves the File to the Sweep, not to an immediate cascade.
 */
import { and, eq } from "drizzle-orm";
import type { DatabaseDriver } from "./database";
import { sources } from "./schema";

export interface Sources {
  /** One Brand has used one Source Image. Idempotent: holding twice is one row. */
  hold(brand: string, hash: string): Promise<void>;
  /** Whether this Brand holds this Source Image. The Signed URL lookup. */
  heldBy(brand: string, hash: string): Promise<boolean>;
  /**
   * This Brand no longer uses this Source Image. Idempotent, as every other
   * delete records offers is: a caller retries after a timeout.
   *
   * It never touches the File. Once the last hold is gone the photograph is
   * the Sweep's, after the Retention Window — the immediate cascade was
   * sanctioned for erasing a Person and for nothing else (#76, Q11).
   */
  release(brand: string, hash: string): Promise<void>;
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

    async release(brand, hash) {
      await orm
        .delete(sources)
        .where(and(eq(sources.brand, brand), eq(sources.hash, hash)));
    },
  };
}
