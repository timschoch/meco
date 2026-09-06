/**
 * The `Records` seam. Every method takes and returns contracts types or the
 * plain rows declared here; no drizzle type leaves this file.
 *
 * This slice holds the two nouns the tracer bullet needs, `files` and
 * `annotations`, plus `migrate`. The other seven tables exist in the schema
 * from the first migration, so the tickets after this one add methods and not
 * migrations.
 */
import { Annotation } from "@meco/contracts";
import type { Store } from "@meco/store";
import { eq, sql } from "drizzle-orm";
import { type Database, type DatabaseDriver, driverFor } from "./database";
import { applyMigrations } from "./migrate";
import { annotations, files } from "./schema";

export interface RecordsOptions {
  readonly database: Database;
  /**
   * How records reaches bytes: the cascades and the Sweep delete through it,
   * and records never reads one. Held from the first slice on, because the
   * seam is what the module was designed around and a later ticket adding it
   * would change every call site that had already opened a Records.
   */
  readonly store: Store;
}

/** One photograph as records knows it. Store Keys and hashes, never bytes. */
export interface FileRecord {
  /** The Content Hash: 64 lowercase hex characters. */
  readonly hash: string;
  readonly mime: string;
  readonly width: number;
  readonly height: number;
  /** The size of the bytes, as stored. */
  readonly bytes: number;
  readonly storeKey: string;
  /** ISO 8601, as `@meco/store`'s Listing reports its own times. */
  readonly firstSeenAt: string;
}

export type NewFile = Omit<FileRecord, "firstSeenAt">;

export interface Records {
  /**
   * Applies every committed migration this database has not applied, under the
   * migration lock. Called at gateway boot; throws on the first failure.
   */
  migrate(): Promise<{ readonly applied: number }>;
  files: {
    /** Idempotent on the Content Hash: one photograph is one row. */
    ensure(file: NewFile): Promise<FileRecord>;
    get(hash: string): Promise<FileRecord | null>;
  };
  annotations: {
    /** Parsed with the contracts schema, or `null` when nothing is stored. */
    get(hash: string): Promise<Annotation | null>;
    /** Replaces what is stored for that hash. The File must exist. */
    put(annotation: Annotation): Promise<void>;
  };
  /** Releases the database. Idempotent. */
  close(): Promise<void>;
}

/**
 * The driver behind a `Records`, for the health probe. Kept off the interface
 * for the same reason the driver is kept off `Database`: what `/health` needs
 * is a backend detail, and putting it on the seam would put drizzle in the
 * declarations every consumer compiles against.
 */
const drivers = new WeakMap<Records, DatabaseDriver>();

export function driverOf(records: Records): DatabaseDriver {
  const driver = drivers.get(records);
  if (driver === undefined) {
    throw new Error("@meco/records: this is not a Records from records().");
  }
  return driver;
}

/** A stored row as the seam reports it: the driver's `Date` becomes ISO 8601. */
type FileRow = Omit<FileRecord, "firstSeenAt"> & { readonly firstSeenAt: Date };

const asFileRecord = (row: FileRow): FileRecord => ({
  hash: row.hash,
  mime: row.mime,
  width: row.width,
  height: row.height,
  bytes: row.bytes,
  storeKey: row.storeKey,
  firstSeenAt: row.firstSeenAt.toISOString(),
});

export function records(options: RecordsOptions): Records {
  const driver = driverFor(options.database);
  const { orm } = driver;

  const readFile = async (hash: string): Promise<FileRecord | null> => {
    const [row] = await orm
      .select()
      .from(files)
      .where(eq(files.hash, hash))
      .limit(1);
    return row === undefined ? null : asFileRecord(row);
  };

  const surface: Records = {
    async migrate() {
      return applyMigrations(driver);
    },

    files: {
      async ensure(file) {
        // `do nothing` and then read: the same photograph uploaded by two
        // Brands is one row, and the row that stands is the first one written,
        // never a second copy of facts the bytes already fixed.
        await orm.insert(files).values(file).onConflictDoNothing();
        const stored = await readFile(file.hash);
        if (stored === null) {
          throw new Error(
            `@meco/records: the file ${file.hash} reads as missing right after it was ensured.`
          );
        }
        return stored;
      },
      get: readFile,
    },

    annotations: {
      async get(hash) {
        const [row] = await orm
          .select({ annotation: annotations.annotation })
          .from(annotations)
          .where(eq(annotations.hash, hash))
          .limit(1);
        // A miss is `null`. Callers ask for a cached Annotation on every call,
        // and a throw would make the ordinary cache miss an error path.
        if (row === undefined) return null;
        // Parsed, not cast: what came back is jsonb Postgres reassembled, and
        // the contracts schema is what says it is still an Annotation.
        return Annotation.parse(row.annotation);
      },
      async put(annotation) {
        const values = {
          hash: annotation.hash,
          schema: annotation.schema,
          producedBy: annotation.producedBy,
          annotation,
        };
        await orm
          .insert(annotations)
          .values(values)
          .onConflictDoUpdate({
            target: annotations.hash,
            // `annotated_at` defaults only on insert, so a replacement that
            // did not set it would date the new Annotation by the old one.
            set: { ...values, annotatedAt: sql`now()` },
          });
      },
    },

    async close() {
      await driver.close();
    },
  };

  drivers.set(surface, driver);
  return surface;
}
