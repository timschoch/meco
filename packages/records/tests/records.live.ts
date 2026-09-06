/**
 * The same Conformance Checks as `records.test.ts`, against Neon
 * `meco-records-eu`. Out of the gate, under `pnpm test:records:live`, because
 * three of them are properties of Postgres that pglite cannot have.
 *
 * The one that made this file necessary is **the advisory lock**. PGlite is a
 * single Postgres session, so `pg_advisory_lock` taken twice inside it
 * serialises nothing and the in-process adapter's migration lock is a promise
 * chain. Two sessions only exist against a real server, so "two migrations at
 * once apply once" is honest here and nowhere else
 * ([#160](https://github.com/timschoch/meco/issues/160), blocker 1).
 *
 * **Every database this run creates is dropped in `afterAll`**, which runs
 * whether the checks passed or not. `NEON_API_KEY` is absent, so the suite
 * takes the second path the spec names: run-scoped, rather than a throwaway
 * branch of `meco-records-eu`.
 *
 * Run-scoped is a **database**, not the schema the spec says. `drizzle-kit`
 * writes every foreign key as `references "public"."files"(…)`, so tables
 * created in a schema of one's own still point their keys at `public` — at
 * production's rows. Measured 6 Sep 2026: the whole People half of the list
 * failed on Neon that way while passing on pglite, because pglite's `public`
 * was the run's own. A database has a `public` of its own, so the same SQL
 * means what it says and nothing here can reach the rows the deployment reads.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, it } from "vitest";
import { type Store, memoryStore } from "@meco/store";
import { recordsConformance } from "../conformance";
import { type Records, neonDatabase, records } from "../index";

/**
 * `process.loadEnvFile` in `vitest.live.config.ts` never overrides a variable
 * already exported in the shell, so a stale one wins silently. The suite prints
 * the host it reached for exactly that reason.
 */
const DSN = process.env.RECORDS_DATABASE_URL_UNPOOLED;
if (DSN === undefined || DSN === "") {
  throw new Error(
    "@meco/records: RECORDS_DATABASE_URL_UNPOOLED is not set. `vercel env pull .env.local` in this worktree."
  );
}

/**
 * The same connection string against another database on the same endpoint.
 * Spliced rather than `new URL(…).toString()`, for the reason `verifying` gives:
 * that re-serialises the userinfo it parsed, and a password with a reserved
 * character in it could come back encoded differently.
 */
const inDatabase = (name: string): string => {
  const at = DSN.indexOf("?");
  const base = at === -1 ? DSN : DSN.slice(0, at);
  const query = at === -1 ? "" : DSN.slice(at);
  return `${base.slice(0, base.lastIndexOf("/"))}/${name}${query}`;
};

/** Every database this run made, so `afterAll` can drop all of them. */
const made: string[] = [];
/** Every pool this run opened, so none outlives it — a drop needs them gone. */
const opened: { close(): Promise<void> }[] = [];

const admin = new pg.Pool({ connectionString: DSN, max: 1 });

async function freshDatabase(): Promise<string> {
  // No dashes: an identifier with one has to be quoted everywhere it appears,
  // including in the connection string, where nothing quotes it.
  const name = `records_live_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`create database "${name}"`);
  made.push(name);
  return name;
}

const over = (name: string, store: Store): Records => {
  const database = neonDatabase(inDatabase(name));
  opened.push(database);
  return records({ database, store });
};

/** The one migrated database every data check shares, so the run stays in budget. */
let shared = "";

beforeAll(async () => {
  shared = await freshDatabase();
  await over(shared, memoryStore()).migrate();
}, 60_000);

const open = async (): Promise<Records> => over(shared, memoryStore());

const overStore = async (store: Store): Promise<Records> => over(shared, store);

const empty = async () => {
  // Its own database, never the shared one: the migration checks need one that
  // has never been migrated, and everything production has is migrated.
  const name = await freshDatabase();
  // One database, several `Records` over it. `withMigrationLock` takes its own
  // pooled connection per call, so two of them are two Postgres sessions —
  // which is the whole reason the advisory-lock check is run here.
  const database = neonDatabase(inDatabase(name));
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
  for (const check of recordsConformance(open, { empty, over: overStore })) {
    it(check.name, check.run, CHECK_TIMEOUT_MS);
  }
});

describe("what this live run did", () => {
  it("says which of the two paths it took, on which host, and what it cost", () => {
    // The spec asks the live suite to record which path ran. It is a test and
    // not an `afterAll` log because Vitest shows a passing file's `afterAll`
    // output nowhere, and a number nobody sees is not a measurement.
    // The host, because `.env.local` is what names it and a stale shell export
    // could have named another. Nothing secret is in it.
    console.log(
      `records live: ${new URL(DSN).host}, run-scoped databases (NEON_API_KEY absent, so no throwaway branch), ${made.length} created, ${Math.round(performance.now() - startedAt)} ms wall`
    );
  });
});

afterAll(async () => {
  await Promise.all(opened.map((one) => one.close()));
  for (const name of made) {
    // `force` because a pool that failed to close would otherwise leave the
    // database standing, and a live suite that litters is one nobody reruns.
    await admin.query(`drop database if exists "${name}" with (force)`);
  }
  await admin.end();
}, CHECK_TIMEOUT_MS);
