/**
 * Callers, as far as Calls need them.
 *
 * A Call names the Caller that made it, and `calls.caller_id` is a foreign key,
 * so nothing about a Call can be written — or tested — until a Caller row
 * exists. That is the whole reason this file is here in this slice.
 *
 * **Owned by [#161](https://github.com/timschoch/meco/issues/161)**, which adds
 * `callers.byKey` and `pnpm records:seed`. When the two land, the later PR drops
 * whichever copy is the duplicate. Same shape as `brands.ts` and `sources.ts`
 * before it.
 */
import { createHash } from "node:crypto";
import type { DatabaseDriver } from "./database";
import { callers } from "./schema";

/** A bearer key as records keeps it. The key itself is never stored. */
export interface Caller {
  /** `crypto.randomUUID()`, minted by records. */
  readonly id: string;
  readonly name: string;
  /** The Brands this Caller may act for. */
  readonly brands: readonly string[];
  /** ISO 8601, as `@meco/store`'s Listing reports its own times. */
  readonly createdAt: string;
}

export interface Callers {
  /** Stores the SHA-256 of the key and never the key (ADR-0011). */
  create(caller: {
    name: string;
    key: string;
    brands: readonly string[];
  }): Promise<Caller>;
}

export function callersOver(driver: DatabaseDriver): Callers {
  const { orm } = driver;

  return {
    async create(caller) {
      const [row] = await orm
        .insert(callers)
        .values({
          id: crypto.randomUUID(),
          name: caller.name,
          keyHash: createHash("sha256").update(caller.key).digest("hex"),
          brands: [...caller.brands],
        })
        .returning();
      if (row === undefined) {
        throw new Error(
          `@meco/records: the caller ${caller.name} was inserted and nothing came back.`
        );
      }
      // `key_hash` never leaves this function: a Caller a webui page rendered
      // would otherwise carry the one value the table exists to keep out.
      return {
        id: row.id,
        name: row.name,
        brands: row.brands,
        createdAt: row.createdAt.toISOString(),
      };
    },
  };
}
