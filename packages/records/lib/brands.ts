/**
 * Brands, as far as People need them.
 *
 * A Person's `brand` is a foreign key to `brands.id`, so nothing about People
 * can be written — or tested — until a Brand row exists. That is the whole
 * reason this file is here in this slice.
 *
 * **Owned by [#161](https://github.com/timschoch/meco/issues/161)**, which adds
 * Callers, `brands.get`, `brands.list` and `pnpm records:seed`. When the two
 * land, the later PR drops whichever copy is the duplicate.
 */
import type { DatabaseDriver } from "./database";
import { brands } from "./schema";

/** One Brand as records keeps it. The id is the slug compose keys a Look on. */
export interface Brand {
  readonly id: string;
  readonly name: string;
  /** ISO 8601, as `@meco/store`'s Listing reports its own times. */
  readonly createdAt: string;
}

export interface Brands {
  /**
   * Upserts by id: a Brand the seed runs over twice is one row, and a rename
   * in the checked-in list reaches the row rather than being ignored.
   */
  ensure(brand: { id: string; name: string }): Promise<Brand>;
}

export function brandsOver(driver: DatabaseDriver): Brands {
  const { orm } = driver;

  return {
    async ensure(brand) {
      const [row] = await orm
        .insert(brands)
        .values(brand)
        .onConflictDoUpdate({ target: brands.id, set: { name: brand.name } })
        .returning();
      if (row === undefined) {
        throw new Error(
          `@meco/records: the brand ${brand.id} was upserted and nothing came back.`
        );
      }
      return { ...row, createdAt: row.createdAt.toISOString() };
    },
  };
}
