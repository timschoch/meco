/**
 * The in-process adapter: real Postgres compiled to WebAssembly, so the whole
 * records suite runs inside `pnpm check` with no network and no Docker. It is
 * the gate's database and not a weaker imitation of one — the same migration
 * SQL, the same jsonb, the same arrays.
 *
 * It is reached through its own entry point, `@meco/records/pglite`, rather
 * than through `index.ts`: the gateway bundles `index.ts` into the container
 * image, and an export it never calls would pull PGlite's WebAssembly in
 * behind it.
 */
import type { SQL } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { type Database, type DatabaseDriver, asDatabase } from "./database";

/**
 * PGlite is one Postgres session driving one in-process instance, so
 * `pg_advisory_lock` there would be taken by the session that already holds it
 * and would serialise nothing. The lock this adapter needs is a lock between
 * the callers sharing that instance, and that is a promise chain: each caller
 * waits on the one before it.
 *
 * Same promise as the Neon adapter's advisory lock — "only one migration runs
 * at a time on this database" — kept the only way this backend can keep it.
 */
function serialiser(): <T>(run: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(run: () => Promise<T>): Promise<T> => {
    const mine = tail.then(run, run);
    tail = mine.catch(() => undefined);
    return mine;
  };
}

export function pgliteDatabase(): Database {
  const client = new PGlite();
  const orm = drizzle(client);
  const withMigrationLock = serialiser();
  let closed = false;

  const driver: DatabaseDriver = {
    kind: "pglite",
    orm,
    async query<Row>(statement: SQL): Promise<Row[]> {
      const result = await orm.execute(statement);
      return result.rows as Row[];
    },
    async transaction<T>(
      run: (exec: (statement: SQL) => Promise<void>) => Promise<T>
    ): Promise<T> {
      return orm.transaction(async (tx) =>
        run(async (statement) => {
          await tx.execute(statement);
        })
      );
    },
    withMigrationLock,
    async close() {
      // Idempotent: a check closes the database it opened and the suite closes
      // every database it saw, and PGlite throws on a second close.
      if (closed) return;
      closed = true;
      await client.close();
    },
  };

  return asDatabase(driver);
}
