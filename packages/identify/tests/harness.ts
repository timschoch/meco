/**
 * What every identify check is given: a real `Records` over PGlite, a real
 * `memoryStore`, and an `Annotator` that answers from the committed fixtures.
 * Only the model is faked (ADR-0012, Decision 5) — a fake `Records` would be a
 * third adapter with no conformance suite keeping it honest.
 */
import { type FacePrint } from "@meco/contracts";
import {
  type Database,
  type Person,
  type Records,
  peoplePrefix,
  records,
} from "@meco/records";
import { type Store, memoryStore } from "@meco/store";
import type { Annotator } from "../index";

/** The Model the fixture prints came from, and the one the Match Rule reads. */
export const FIXTURE_PRINT_MODEL = { name: "edgeface", version: "1" } as const;

/**
 * A check that opens its own database pays a PGlite start, measured at about a
 * second alone and several under a full `pnpm check`. Vitest's default five
 * seconds is a budget for a unit test, not for booting Postgres.
 */
export const PGLITE_TIMEOUT_MS = 30_000;

export interface Harness {
  readonly records: Records;
  readonly store: Store;
  /** Enrols a Person of this Brand from the prints given, in order. */
  enrol(options: {
    readonly brand: string;
    readonly name: string;
    readonly prints: readonly (readonly number[])[];
    /** The Model to file the prints under. Defaults to the Print Model. */
    readonly model?: FacePrint["model"];
  }): Promise<Person>;
}

/** An `Annotator` that never runs: `match` calls no model (ADR-0012, D1). */
export const refusingAnnotator: Annotator = async () => {
  throw new Error("match must not call the Annotator");
};

export async function harness(database: Database): Promise<Harness> {
  const store = memoryStore();
  const open = records({ database, store });
  await open.migrate();
  const brands = new Set<string>();

  return {
    records: open,
    store,
    async enrol({ brand, name, prints, model }) {
      if (!brands.has(brand)) {
        await open.brands.ensure({ id: brand, name: brand });
        brands.add(brand);
      }
      const person = await open.people.create({ brand, name });
      for (const [index, vector] of prints.entries()) {
        const bytes = new TextEncoder().encode(`${brand}/${name}/${index}`);
        const source = await store.put("sources", bytes, "image/jpeg");
        const held = await store.put(
          peoplePrefix(brand, person.id),
          bytes,
          "image/jpeg"
        );
        await open.files.ensure({
          hash: source.hash,
          mime: "image/jpeg",
          width: 1280,
          height: 1600,
          bytes: bytes.byteLength,
          storeKey: source.key,
        });
        await open.people.enrol({
          brand,
          personId: person.id,
          hash: source.hash,
          storeKey: held.key,
          regionId: "face-1",
          facePrint: {
            model: model ?? FIXTURE_PRINT_MODEL,
            vector: [...vector],
          },
          consentAt: "2026-01-01T00:00:00.000Z",
        });
      }
      return person;
    },
  };
}
