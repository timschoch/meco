/**
 * The Conformance Checks on the in-process adapter. This is the gate's records
 * suite: real Postgres, real migration SQL, no network and no Docker.
 *
 * The identical list runs against Neon under `pnpm test:records:live`, which a
 * later ticket adds; a difference between the two adapters is a red test here
 * rather than a surprise in production.
 */
import { afterAll, describe, expect, it } from "vitest";
import { memoryStore } from "@meco/store";
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

const over = (database: Database): Records =>
  // A counted `memoryStore` is what the deletion checks will assert on; this
  // slice writes no bytes, so a plain one is the whole of what records needs.
  records({ database, store: memoryStore() });

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
  const records = over(openDatabase());
  await records.migrate();
  return records;
};

afterAll(async () => {
  await Promise.all(opened.map((database) => database.close()));
});

describe("@meco/records over pglite", () => {
  for (const check of recordsConformance(open, { empty })) {
    it(check.name, check.run);
  }
});

describe("@meco/records on pglite, measured", () => {
  it("reports what a pglite database costs the gate", async () => {
    const startedOpening = performance.now();
    const database = openDatabase();
    const records = over(database);
    // PGlite starts its instance lazily, so the first statement pays the boot.
    await records.files.get("0".repeat(64)).catch(() => undefined);
    const startMs = performance.now() - startedOpening;

    const startedMigrating = performance.now();
    const first = await records.migrate();
    const migrateMs = performance.now() - startedMigrating;

    const startedAgain = performance.now();
    const second = await records.migrate();
    const secondMs = performance.now() - startedAgain;

    console.log(
      `pglite: start ${Math.round(startMs)} ms, migrate ${Math.round(migrateMs)} ms (${first.applied} applied), second migrate ${Math.round(secondMs)} ms (${second.applied} applied)`
    );

    expect(second.applied).toBe(0);
  });
});
