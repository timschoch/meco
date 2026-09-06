/**
 * Brands. The Seed is the only writer of this table in v1: Brands are not
 * created over the API, so a Brand exists because a checked-in list said so.
 *
 * It matters to People as well as to the Seed — a Person's `brand` is a foreign
 * key to `brands.id`, so nothing about People can be written until a Brand row
 * exists.
 */
import { asc, eq } from "drizzle-orm";
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
  get(id: string): Promise<Brand | null>;
  /** Every Brand, by id. Three rows in v1; the Seed is the only writer. */
  list(): Promise<Brand[]>;
}

const asBrand = (row: {
  id: string;
  name: string;
  createdAt: Date;
}): Brand => ({
  id: row.id,
  name: row.name,
  createdAt: row.createdAt.toISOString(),
});

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
      return asBrand(row);
    },

    async get(id) {
      const [row] = await orm
        .select()
        .from(brands)
        .where(eq(brands.id, id))
        .limit(1);
      return row === undefined ? null : asBrand(row);
    },

    async list() {
      // By id, because a Brand list with no order is a list that changes under
      // a caller comparing two runs. Three rows; nothing to paginate.
      const rows = await orm.select().from(brands).orderBy(asc(brands.id));
      return rows.map(asBrand);
    },
  };
}
