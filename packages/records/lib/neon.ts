/**
 * The Neon adapter: a `pg` Pool on the unpooled connection string.
 *
 * Unpooled, because records runs in a long-lived container that holds its own
 * pool. PgBouncer's connection multiplexing buys such a process nothing, while
 * its transaction mode would forbid `SET`, `LISTEN/NOTIFY` and session-level
 * advisory locks — and a session-level advisory lock is exactly what the
 * migration takes. Neon says migrations must use the direct string regardless
 * (`docs/research/neon-on-vercel.md`, section 1).
 *
 * `@neondatabase/serverless` is out for the same reason: its pool "can't
 * outlive a single request", which is the opposite of this runtime model.
 */
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import {
  type Database,
  type DatabaseDriver,
  MIGRATION_LOCK_KEY,
  asDatabase,
} from "./database";

/**
 * Two containers at five connections each leave a Neon free-tier database
 * (roughly a hundred) room for a migration and a developer.
 */
const POOL_SIZE = 5;

/**
 * `sslmode=require` in `pg` 8.23 verifies nothing and says so on stderr on
 * every connect: "sslmode=require is treated as sslmode=no-verify". Neon
 * serves a certificate from a public CA that Node already trusts, so the
 * answer is to verify rather than to silence the warning — anything else keeps
 * a connection carrying personal data open to a machine in the middle.
 */
export function verifyingConnectionString(connectionString: string): string {
  const url = new URL(connectionString);
  url.searchParams.set("sslmode", "verify-full");
  return url.toString();
}

export function neonDatabase(connectionString: string): Database {
  if (connectionString === "") {
    throw new Error("@meco/records: the connection string is empty.");
  }

  const pool = new pg.Pool({
    connectionString: verifyingConnectionString(connectionString),
    max: POOL_SIZE,
  });
  const orm = drizzle(pool);
  let closed = false;

  const driver: DatabaseDriver = {
    kind: "neon",
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
    async withMigrationLock<T>(run: () => Promise<T>): Promise<T> {
      // One dedicated connection: a session-level advisory lock belongs to the
      // session that took it, so taking and releasing it on two different
      // pooled connections would release nothing.
      const client = await pool.connect();
      try {
        await client.query("select pg_advisory_lock($1)", [
          MIGRATION_LOCK_KEY.toString(),
        ]);
        try {
          return await run();
        } finally {
          await client.query("select pg_advisory_unlock($1)", [
            MIGRATION_LOCK_KEY.toString(),
          ]);
        }
      } finally {
        client.release();
      }
    },
    async close() {
      // Idempotent, as the in-process adapter's is: `pool.end()` twice throws.
      if (closed) return;
      closed = true;
      await pool.end();
    },
  };

  return asDatabase(driver);
}
