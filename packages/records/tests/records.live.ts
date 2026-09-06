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
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
  it(
    "writes one Call and one Output on the live server and prints what came back",
    async () => {
      // The rows the conformance list writes are asserted on and never shown.
      // This one is shown: a shape nobody has read off the real server is a shape
      // nobody has checked. Nothing here is a secret — a Store Key, a hash and a
      // duration — and the database is the run's own, dropped in `afterAll`.
      const meco = over(shared, memoryStore());
      const brand = "live-row-shape";
      await meco.brands.ensure({ id: brand, name: "Live row shape" });
      const caller = await meco.callers.create({
        name: "live row shape",
        key: randomUUID(),
        brands: [brand],
      });
      const request = { template: "story", fields: { title: "Ada" } };

      const call = await meco.calls.record({
        callerId: caller.id,
        brand,
        kind: "render",
        status: "ok",
        sourceHash: createHash("sha256").update("live row shape").digest("hex"),
        request,
        steps: [
          { name: "models.decode", durMs: 31 },
          { name: "compose.plan", durMs: 4 },
        ],
        durationMs: 96,
      });
      const output = await meco.outputs.record({
        brand,
        storeKey: `renders/${randomUUID()}.png`,
        callId: call.id,
        kind: "render",
        placement: "ig-story",
        requestHash: meco.requestHash(brand, "render", request),
      });

      const listed = await meco.outputs.list({ brand, limit: 10 });
      console.log(`live call:   ${JSON.stringify(call)}`);
      console.log(`live output: ${JSON.stringify(listed.rows)}`);

      expect(listed.rows).toEqual([output]);
      expect((await meco.calls.get(call.id))?.steps).toHaveLength(2);
    },
    CHECK_TIMEOUT_MS
  );

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
