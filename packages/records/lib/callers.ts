/**
 * Callers: the bearer key the gateway resolves once per request, and the Brands
 * that key holds.
 *
 * The key itself is never here. What a row holds is its SHA-256, so a leaked
 * `callers` table leaks no key, and `byKey` hashes what it was offered rather
 * than storing what it can compare.
 */
import { createHash, randomUUID } from "node:crypto";
import { type SQL, eq, sql } from "drizzle-orm";
import type { DatabaseDriver } from "./database";
import { callers } from "./schema";

/** One Caller as records keeps it. The key is not a field and never will be. */
export interface Caller {
  readonly id: string;
  readonly name: string;
  /** The Brands this Caller holds. The Brand Wall reads this array. */
  readonly brands: readonly string[];
  /** ISO 8601, as `@meco/store`'s Listing reports its own times. */
  readonly createdAt: string;
}

/** A Caller to create. `key` is hashed on the way in and never stored. */
export interface NewCaller {
  readonly name: string;
  readonly key: string;
  readonly brands: readonly string[];
}

export interface Callers {
  /**
   * Mints a Caller and stores the SHA-256 of its key. A key that already
   * belongs to a Caller is refused: one key is one Caller, because
   * {@link Callers.byKey} is what the Brand Wall reads and a second row on one
   * hash would make its answer a coin toss.
   */
  create(caller: NewCaller): Promise<Caller>;
  /** Hashes the key and looks the Caller up by that hash. */
  byKey(key: string): Promise<Caller | null>;
  /**
   * Adds Brands to a Caller. Idempotent and additive: a Brand it already holds
   * changes nothing, and no Brand is ever taken away. This is what lets the
   * Seed converge — a bootstrap Caller created before a Brand existed holds it
   * after the next run.
   */
  grant(grant: {
    callerId: string;
    brands: readonly string[];
  }): Promise<Caller>;
}

/** A stored row as the seam reports it: the driver's `Date` becomes ISO 8601. */
type CallerRow = Omit<Caller, "createdAt" | "brands"> & {
  readonly brands: string[];
  readonly createdAt: Date;
};

/**
 * The only form of a bearer key records ever holds. SHA-256 of its UTF-8 bytes,
 * hex: no salt and no work factor, because a key is randomness the owner minted
 * and not a password anybody could guess. What the hash buys is that a leaked
 * `callers` table authorises nothing.
 */
const keyHash = (key: string): string =>
  createHash("sha256").update(key, "utf8").digest("hex");

/**
 * Postgres `unique_violation`, whatever driver reported it.
 *
 * Down the `cause` chain, because drizzle does not rethrow the driver's error:
 * it wraps it in a `DrizzleQueryError` whose own message is the statement and
 * its bound parameters. `SQLSTATE 23505` is therefore never on the error that
 * arrives, only on something it caused.
 */
const isUniqueViolation = (error: unknown): boolean => {
  for (
    let at = error;
    at instanceof Object;
    at = (at as { cause?: unknown }).cause
  ) {
    if ("code" in at && at.code === "23505") return true;
  }
  return false;
};

const asCaller = (row: CallerRow): Caller => ({
  id: row.id,
  name: row.name,
  brands: row.brands,
  createdAt: row.createdAt.toISOString(),
});

export function callersOver(driver: DatabaseDriver): Callers {
  const { orm } = driver;

  const readOne = async (where: SQL): Promise<Caller | null> => {
    const [row] = await orm.select().from(callers).where(where).limit(1);
    return row === undefined ? null : asCaller(row);
  };

  return {
    async create(caller) {
      // An empty key hashes to a fixed value like any other string, so without
      // this an empty bearer token would authenticate a real Caller.
      if (caller.key === "") {
        throw new Error("@meco/records: a Caller cannot have an empty key.");
      }

      // No `on conflict`: the unique index on `key_hash` is what makes one key
      // one Caller, and a collision has to be a loud failure.
      //
      // The failure is replaced rather than wrapped, and carries no `cause`:
      // drizzle's `DrizzleQueryError` prints the statement and its bound
      // parameters, one of which is the key's SHA-256, and the driver's own
      // message quotes it again as `Key (key_hash)=(…) already exists`. A hash
      // is the one form of the key records holds and it does not belong in a
      // message anything might log.
      const [row] = await orm
        .insert(callers)
        .values({
          id: randomUUID(),
          name: caller.name,
          keyHash: keyHash(caller.key),
          brands: [...caller.brands],
        })
        .returning()
        .catch((error: unknown) => {
          if (isUniqueViolation(error)) {
            throw new Error(
              `@meco/records: the key offered for the caller ${caller.name} already belongs to a caller.`
            );
          }
          throw error;
        });
      if (row === undefined) {
        throw new Error(
          `@meco/records: the caller ${caller.name} was created and nothing came back.`
        );
      }
      return asCaller(row);
    },

    byKey(key) {
      // Hashed here and compared as a hash. Looking a Caller up by the key
      // itself would need the key to be in the table.
      return readOne(eq(callers.keyHash, keyHash(key)));
    },

    async grant({ callerId, brands }) {
      // One statement, so the Caller cannot lose a Brand a concurrent grant
      // added between a read and a write. Appended rather than merged in
      // place: the Brands the Caller already holds keep their order, and only
      // what is genuinely new is added, sorted so two runs agree.
      const offered = sql`array[${sql.join(
        brands.map((brand) => sql`${brand}`),
        sql`, `
      )}]::text[]`;

      const [row] = await orm
        .update(callers)
        .set({
          brands: sql`${callers.brands} || (
            select coalesce(array_agg(offered order by offered), '{}'::text[])
            from unnest(${offered}) as offered
            where not (offered = any(${callers.brands}))
          )`,
        })
        .where(eq(callers.id, callerId))
        .returning();
      if (row === undefined) {
        throw new Error(
          `@meco/records: there is no caller ${callerId} to grant a brand to.`
        );
      }
      return asCaller(row);
    },
  };
}
