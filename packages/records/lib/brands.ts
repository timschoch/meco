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
  /**
   * The Brand's rung of the Redaction Policy, stored and returned unread: the
   * default for an output whose request and Template both left it absent.
   *
   * `null` is not `false`. A Brand that has set nothing falls through to
   * meco's default, so the two have to stay tellable apart, which is why this
   * is nullable rather than a boolean with a default.
   */
  readonly redaction: unknown;
  /** ISO 8601, as `@meco/store`'s Listing reports its own times. */
  readonly createdAt: string;
}

export interface Brands {
  /**
   * Upserts by id: a Brand the seed runs over twice is one row, and a rename
   * in the checked-in list reaches the row rather than being ignored.
   *
   * Never writes `redaction`: the Seed says what a Brand is called, and a
   * redeploy running the Seed again must not undo a policy set over the API.
   */
  ensure(brand: { id: string; name: string }): Promise<Brand>;
  get(id: string): Promise<Brand | null>;
  /** Every Brand, by id. Three rows in v1; the Seed is the only writer. */
  list(): Promise<Brand[]>;
  /**
   * Sets the Brand's redaction default, or clears it with `null`.
   *
   * `null` and not an absent argument, because clearing is what a Brand does
   * to fall back to meco's default and it must be sayable. A Brand no row has
   * is `null` back, the same answer `get` gives: the caller was refused by the
   * Brand Wall long before this, so a throw here would be about a Brand that
   * cannot reach it.
   */
  setRedaction(id: string, redaction: unknown): Promise<Brand | null>;
}

const asBrand = (row: {
  id: string;
  name: string;
  redaction: unknown;
  createdAt: Date;
}): Brand => ({
  id: row.id,
  name: row.name,
  redaction: row.redaction ?? null,
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

    async setRedaction(id, redaction) {
      const [row] = await orm
        .update(brands)
        .set({ redaction })
        .where(eq(brands.id, id))
        .returning();
      return row === undefined ? null : asBrand(row);
    },
  };
}
