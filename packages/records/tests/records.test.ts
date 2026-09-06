/**
 * The Conformance Checks on the in-process adapter. This is the gate's records
 * suite: real Postgres, real migration SQL, no network and no Docker.
 *
 * The identical list runs against Neon under `pnpm test:records:live`, which a
 * later ticket adds; a difference between the two adapters is a red test here
 * rather than a surprise in production.
 */
import { afterAll, describe, expect, it } from "vitest";
import { type Store, memoryStore } from "@meco/store";
import { recordsConformance } from "../conformance";
import { type Database, type Records, records } from "../index";
import { pgliteDatabase } from "../pglite";

/** Every database this file opened, so no PGlite instance outlives the run. */
const opened: Database[] = [];

const openDatabase = (): Database => {
  const database = pgliteDatabase();
  opened.push(database);
  return database;
};

const over = (database: Database, store: Store = memoryStore()): Records =>
  records({ database, store });

const empty = async () => {
  const database = openDatabase();
  return {
    open: () => over(database),
    dispose: async () => {
      await database.close();
    },
  };
};

/** A fresh, migrated Records, as the data checks expect. */
const open = async (): Promise<Records> => {
  const migrated = over(openDatabase());
  await migrated.migrate();
  return migrated;
};

/** The same, over the store the check will watch the bytes cross. */
const overStore = async (store: Store): Promise<Records> => {
  const migrated = over(openDatabase(), store);
  await migrated.migrate();
  return migrated;
};

afterAll(async () => {
  await Promise.all(opened.map((database) => database.close()));
});

/**
 * A check that opens its own database pays a PGlite start, measured at about a
 * second on its own and several under the load of a full `pnpm check`. Vitest's
 * default five seconds is a budget for a unit test, not for booting Postgres.
 */
const PGLITE_TIMEOUT_MS = 30_000;

describe("@meco/records over pglite", () => {
  for (const check of recordsConformance(open, { empty, over: overStore })) {
    it(check.name, check.run, PGLITE_TIMEOUT_MS);
  }
});

describe("@meco/records on pglite, measured", () => {
  it(
    "reports what a pglite database costs the gate",
    async () => {
      const startedOpening = performance.now();
      const measured = over(openDatabase());
      // PGlite starts its instance lazily, so the first statement pays the boot.
      await measured.files.get("0".repeat(64)).catch(() => undefined);
      const startMs = performance.now() - startedOpening;

      const startedMigrating = performance.now();
      const first = await measured.migrate();
      const migrateMs = performance.now() - startedMigrating;

      const startedAgain = performance.now();
      const second = await measured.migrate();
      const secondMs = performance.now() - startedAgain;

      console.log(
        `pglite: start ${Math.round(startMs)} ms, migrate ${Math.round(migrateMs)} ms (${first.applied} applied), second migrate ${Math.round(secondMs)} ms (${second.applied} applied)`
      );

      expect(second.applied).toBe(0);
    },
    PGLITE_TIMEOUT_MS
  );
});
