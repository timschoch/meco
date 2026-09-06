/**
 * The same Conformance Checks as `records.test.ts`, against Neon
 * `meco-records-eu`. Out of the gate, under `pnpm test:records:live`.
 *
 * The one that made this file necessary is **the advisory lock**. PGlite is a
 * single Postgres session, so `pg_advisory_lock` taken twice inside it
 * serialises nothing and the in-process adapter's migration lock is a promise
 * chain. Two sessions only exist against a real server, so "two migrations at
 * once apply once" is honest here and nowhere else
 * ([#160](https://github.com/timschoch/meco/issues/160), blocker 1).
 *
 * `NEON_API_KEY` is absent, so this takes the second path the spec names:
 * run-scoped rather than a throwaway branch of `meco-records-eu`. Every
 * database it makes is dropped in `afterAll`, which runs whether the checks
 * passed or not. Why a database and not a schema is in `live-database.ts`.
 */
import { afterAll, beforeAll, describe, it } from "vitest";
import { type Store, memoryStore } from "@meco/store";
import { recordsConformance } from "../conformance";
import { type Records, neonDatabase, records } from "../index";
import { liveHost, scratchDatabases } from "./live-database";

const scratch = scratchDatabases();
/** Every pool this run opened, so none outlives it — a drop needs them gone. */
const opened: { close(): Promise<void> }[] = [];

const over = (dsn: string, store: Store): Records => {
  const database = neonDatabase(dsn);
  opened.push(database);
  return records({ database, store });
};

/** The one migrated database every data check shares, so the run stays in budget. */
let shared = "";

beforeAll(async () => {
  shared = await scratch.make();
  await over(shared, memoryStore()).migrate();
}, 60_000);

const open = async (): Promise<Records> => over(shared, memoryStore());

const withStore = async (store: Store): Promise<Records> => over(shared, store);

const empty = async () => {
  // Its own database, never the shared one: the migration checks need one that
  // has never been migrated, and everything production has is migrated.
  const dsn = await scratch.make();
  // One database, several `Records` over it. `withMigrationLock` takes its own
  // pooled connection per call, so two of them are two Postgres sessions —
  // which is the whole reason the advisory-lock check is run here.
  const database = neonDatabase(dsn);
  opened.push(database);
  return {
    open: () => records({ database, store: memoryStore() }),
    dispose: async () => {
      await database.close();
    },
  };
};

/**
 * `eu-central-1` from anywhere but `fra1` pays a round trip per statement, and
 * the migration checks pay one per statement of the migration.
 */
const CHECK_TIMEOUT_MS = 60_000;

const startedAt = performance.now();

describe("@meco/records against Neon", () => {
  for (const check of recordsConformance(open, { empty, withStore })) {
    it(check.name, check.run, CHECK_TIMEOUT_MS);
  }
});

describe("what this live run did", () => {
  it("says which of the two paths it took, on which host, and what it cost", () => {
    // The spec asks the live suite to record which path ran. It is a test and
    // not an `afterAll` log because Vitest shows a passing file's `afterAll`
    // output nowhere, and a number nobody sees is not a measurement.
    console.log(
      `records live: ${liveHost}, run-scoped databases (NEON_API_KEY absent, so no throwaway branch), ${scratch.count} created, ${Math.round(performance.now() - startedAt)} ms wall`
    );
  });
});

afterAll(async () => {
  await Promise.all(opened.map((one) => one.close()));
  await scratch.dispose();
}, CHECK_TIMEOUT_MS);
