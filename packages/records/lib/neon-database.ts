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
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import {
  type Database,
  MIGRATION_LOCK_KEY,
  asDatabase,
  driverOver,
} from "./database";

/**
 * Two containers at five connections each leave a Neon free-tier database
 * (roughly a hundred) room for a migration and a developer.
 */
const POOL_SIZE = 5;

/**
 * The SSL mode records pins, written into the connection string because that is
 * where `pg` reads it and where the warning below says to put it.
 *
 * `pg` 8.23 already verifies the certificate for the `sslmode=require` Neon
 * injects — it aliases `prefer`, `require` and `verify-ca` to `verify-full` —
 * but it warns on every connect that pg 9 will give those modes libpq
 * semantics instead, which verify nothing. Naming the mode is what keeps this
 * connection verified across that change, and it is the fix the warning itself
 * names:
 *
 *     SECURITY WARNING: The SSL modes 'prefer', 'require', and 'verify-ca' are
 *     treated as aliases for 'verify-full'. In the next major version … these
 *     modes will adopt standard libpq semantics, which have weaker security
 *     guarantees. If you want the current behavior, explicitly use
 *     'sslmode=verify-full'.
 *
 * Neon serves a certificate from a public CA that Node already trusts, so no
 * root has to be supplied with it.
 */
const SSL_MODE = "verify-full";

/**
 * The same connection string with `sslmode=verify-full`, edited in the query
 * and nowhere else.
 *
 * Not `new URL(…).toString()`: that re-serialises every part it parsed, the
 * userinfo included, so a password Neon rotated to one carrying a reserved
 * character could come back encoded differently and no longer be the password.
 * Only the query is touched here; everything before the `?` is copied through.
 */
export function verifying(connectionString: string): string {
  const at = connectionString.indexOf("?");
  const base = at === -1 ? connectionString : connectionString.slice(0, at);
  const query = at === -1 ? "" : connectionString.slice(at + 1);

  const kept = query
    .split("&")
    .filter((one) => one !== "" && !/^sslmode=/i.test(one));
  kept.push(`sslmode=${SSL_MODE}`);

  return `${base}?${kept.join("&")}`;
}

export function neonDatabase(connectionString: string): Database {
  if (connectionString === "") {
    throw new Error("@meco/records: the connection string is empty.");
  }

  const pool = new pg.Pool({
    connectionString: verifying(connectionString),
    max: POOL_SIZE,
  });
  const orm = drizzle(pool);
  let closed = false;

  const driver = driverOver({
    kind: "neon",
    orm,
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
  });

  return asDatabase(driver);
}
