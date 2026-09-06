/**
 * The Database seam. `neonDatabase()` and `pgliteDatabase()` hand back a
 * {@link Database}, and `records()` takes one; nothing else about a backend
 * crosses the seam.
 *
 * A {@link Database} is deliberately opaque: two fields, neither of them a
 * drizzle type. What records actually needs — a drizzle handle, a lock that
 * serialises migrations, a way to run one statement — lives on a
 * {@link DatabaseDriver} kept in a private registry and reachable only from
 * inside this package. Were the driver on the public type instead, drizzle's
 * types would appear in the emitted declarations and every consumer would
 * typecheck against them, which is exactly what "no drizzle type crosses the
 * seam" forbids.
 */
import type { SQL } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";

/** Which backend is behind a {@link Database}. Reported, never branched on. */
export type DatabaseKind = "neon" | "pglite";

/** A database records can be opened over. Opaque: only its factory fills it. */
export interface Database {
  readonly kind: DatabaseKind;
  /** Releases the pool or the in-process instance. Idempotent. */
  close(): Promise<void>;
}

/**
 * The drizzle handle, as the two adapters have it in common. `PgDatabase` is
 * generic in its driver's result type, so the two adapters share no narrower
 * supertype; the parameter is unconstrained here and never inspected — records
 * reads rows through {@link DatabaseDriver.query} and builds statements with
 * the query builder, neither of which depends on it.
 */
export type Drizzle = PgDatabase<any>;

/** A drizzle handle inside a transaction, as `orm.transaction` hands it over. */
export type Tx = Parameters<Parameters<Drizzle["transaction"]>[0]>[0];

/** What records needs from a backend. Private to this package. */
export interface DatabaseDriver {
  readonly kind: DatabaseKind;
  readonly orm: Drizzle;
  /** One statement, rows only, whatever shape the driver wraps them in. */
  query<Row>(statement: SQL): Promise<Row[]>;
  /**
   * Runs `run` on one connection inside a transaction, so a migration that
   * fails half way leaves no half-created schema behind. The statements go
   * through the `exec` handed in, never through {@link DatabaseDriver.query},
   * which would take a second connection and land outside the transaction.
   */
  transaction<T>(
    run: (exec: (statement: SQL) => Promise<void>) => Promise<T>
  ): Promise<T>;
  /**
   * Runs `run` with the migration lock held, so two containers booting
   * together apply the migrations once between them.
   */
  withMigrationLock<T>(run: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/**
 * The two adapters differ in three things: which backend they are, how they
 * serialise a migration, and how they let go. Everything else is drizzle over
 * whatever handle they built, so it is written once here rather than twice.
 */
export function driverOver(
  parts: Pick<DatabaseDriver, "kind" | "orm" | "withMigrationLock" | "close">
): DatabaseDriver {
  const { orm } = parts;
  return {
    ...parts,
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
  };
}

const drivers = new WeakMap<Database, DatabaseDriver>();

/** Wraps a driver in the opaque handle a caller passes to `records()`. */
export function asDatabase(driver: DatabaseDriver): Database {
  const database: Database = {
    kind: driver.kind,
    close: () => driver.close(),
  };
  drivers.set(database, driver);
  return database;
}

export function driverFor(database: Database): DatabaseDriver {
  const driver = drivers.get(database);
  if (driver === undefined) {
    throw new Error(
      "@meco/records: this is not a Database from neonDatabase() or pgliteDatabase()."
    );
  }
  return driver;
}

/**
 * The advisory-lock key both adapters take before applying migrations: the
 * high 63 bits of `sha256("meco.records.migrate")`, so it is derived from the
 * thing it locks rather than picked, and cannot collide with another
 * application's key by coincidence.
 */
export const MIGRATION_LOCK_KEY = 6_841_746_940_193_506_290n;
