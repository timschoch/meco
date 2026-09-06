/**
 * The Seed: the one write that has to happen before any Caller can call. Three
 * Brands and one bootstrap Caller, from a checked-in list and one owner-set
 * key.
 *
 * Brands are not created over the API in v1
 * ([ADR-0011](../../../docs/adr/0011-records-postgres-rows-counted-deletes-and-a-sweep.md)),
 * so this is the only writer of `brands` and the first writer of `callers`.
 *
 * It is a function over a `Records` and not a script that opens its own
 * database, so the gate can run it twice against pglite and assert what two
 * runs leave. `seed.ts` is the script around it.
 */
import type { Records } from "./records";

/** One row of the checked-in Brand list. */
export interface SeedBrand {
  /** The slug compose keys a Look on. */
  readonly id: string;
  readonly name: string;
}

/**
 * The three Brands meco renders for. The ids are compose's Look slugs — the
 * same strings, deliberately: a Brand with no Look renders nothing and a Look
 * with no Brand row owns nothing. Written out here rather than imported from
 * compose, because records must not depend on the module that draws pictures.
 */
export const BOOTSTRAP_BRANDS: readonly SeedBrand[] = [
  { id: "laica", name: "laica" },
  { id: "hopefamily", name: "Hope Family" },
  { id: "swisshutless", name: "Swiss Hutless" },
];

/** The name the first Caller is created under. */
export const BOOTSTRAP_CALLER_NAME = "bootstrap";

export interface SeedOptions {
  /** `MECO_BOOTSTRAP_KEY`. Hashed by records; never stored and never printed. */
  readonly bootstrapKey: string;
}

/**
 * What the Seed did, in the form it may be printed in: Brand ids, a Caller's
 * name and the Brands it holds. No key, no hash, no id.
 */
export interface SeedReport {
  /** Every Brand id in the table afterwards, read back rather than assumed. */
  readonly brands: readonly string[];
  readonly caller: {
    readonly name: string;
    /** Every seeded Brand, whether this run created the Caller or granted it. */
    readonly brands: readonly string[];
    /** False when the key already belonged to a Caller. */
    readonly created: boolean;
  };
}

export async function seedRecords(
  records: Records,
  options: SeedOptions
): Promise<SeedReport> {
  // Refused before the first write, so a run without the key leaves nothing.
  if (options.bootstrapKey === "") {
    throw new Error(
      "@meco/records: the seed needs a bootstrap key and was given an empty one."
    );
  }

  for (const brand of BOOTSTRAP_BRANDS) {
    await records.brands.ensure(brand);
  }

  const seeded = BOOTSTRAP_BRANDS.map((brand) => brand.id);

  // Converge, rather than report a gap. A Seed that leaves the bootstrap
  // Caller short of a Brand the same run just created is not idempotent: the
  // second run has to end where the first one would have, whichever came
  // first. `grant` is additive, so a Brand granted by hand survives this.
  const existing = await records.callers.byKey(options.bootstrapKey);
  const caller =
    existing === null
      ? await records.callers.create({
          name: BOOTSTRAP_CALLER_NAME,
          key: options.bootstrapKey,
          brands: seeded,
        })
      : await records.callers.grant({
          callerId: existing.id,
          brands: seeded,
        });

  return {
    brands: (await records.brands.list()).map((brand) => brand.id),
    caller: {
      name: caller.name,
      brands: caller.brands,
      created: existing === null,
    },
  };
}
