/**
 * The database reporting on itself: one File and one Annotation written and
 * read back, so a deployment says whether it can actually reach
 * `eu-central-1` rather than whether an environment variable happens to be set.
 *
 * It writes rather than only reads on purpose. A probe that reads proves the
 * connection; a probe that round-trips proves the schema the container booted
 * against is the schema it can use.
 */
import type { Annotation } from "@meco/contracts";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { sql } from "drizzle-orm";
import type { DatabaseDriver } from "./database";
import { pendingMigrations } from "./migrate";
import { type Records, driverOf } from "./records";

/** What the database looks like from inside the deployment. */
export interface RecordsReach {
  /** The connection string is set, so the database has an address. */
  readonly configured: boolean;
  /** A File and its Annotation were written and read back identical. */
  readonly reachable: boolean;
  /** `select current_setting('server_version')`, or `null` when unreached. */
  readonly serverVersion: string | null;
  /** Committed migrations this database has not applied. */
  readonly pending: number | null;
  /**
   * Whether the schema is current. Derived — it is `pending === 0` — and
   * reported because "is this container on the right schema" is the question
   * the block exists to answer, and a reader should not have to know that a
   * count of zero is the way it says yes.
   */
  readonly migrated: boolean | null;
  /** Wall time of the round trip, milliseconds. */
  readonly roundTripMs: number | null;
  /** Why the round trip did not happen, or `null` when it did. */
  readonly reason: string | null;
}

/** The block for a deployment with no connection string. */
export const RECORDS_UNCONFIGURED: RecordsReach = {
  configured: false,
  reachable: false,
  serverVersion: null,
  pending: null,
  migrated: null,
  roundTripMs: null,
  reason: "the connection string is not set",
};

/**
 * The same 1×1 PNG the store probes with, 70 bytes. The File the probe writes
 * is keyed by the hash of these bytes, so the first probe inserts one row and
 * every probe after that finds it: the table holds exactly one probe File
 * however often `/health` is called, and nothing has to be deleted.
 *
 * It is filed under the `health` Namespace for the same reason the store's is:
 * a Source Image nothing uploaded has no business in `sources`.
 */
const PROBE_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

const PROBE_HASH = createHash("sha256").update(PROBE_BYTES).digest("hex");

/**
 * The Annotation of a 1×1 PNG, and true of those bytes: no Model has run over
 * it, so `producedBy` and `regions` are both empty. Nothing here is invented —
 * an Annotation naming a Model that never ran would be a lie in the one table
 * whose whole promise is that it holds only what is true of the bytes.
 */
const PROBE_ANNOTATION: Annotation = {
  schema: 1,
  hash: PROBE_HASH,
  mime: "image/png",
  width: 1,
  height: 1,
  producedBy: [],
  regions: [],
};

const PROBE_FILE = {
  hash: PROBE_HASH,
  mime: "image/png",
  width: 1,
  height: 1,
  bytes: PROBE_BYTES.byteLength,
  storeKey: `health/${PROBE_HASH}.png`,
} as const;

/**
 * A probe must not be able to hold `/health` open. Five seconds rather than
 * the store's two: a Neon compute scales to zero after five minutes idle, and
 * the first round trip after that pays the wake — 583 ms measured from Zürich
 * to `eu-central-1` on 6 Sep 2026, against 57 ms warm.
 */
const PROBE_TIMEOUT_MS = 5000;

export async function reachRecords(records: Records): Promise<RecordsReach> {
  const driver = driverOf(records);

  // The two reads first, and on their own: a database that has not been
  // migrated cannot round-trip a File, and `pending` on exactly that database
  // is the number the block exists to show.
  let serverVersion: string | null;
  let pending: number | null;
  try {
    [serverVersion, pending] = await withTimeout(
      Promise.all([versionOf(driver), pendingMigrations(driver)])
    );
  } catch (error) {
    return {
      ...RECORDS_UNCONFIGURED,
      configured: true,
      reason: publicMessage(error),
    };
  }

  const started = performance.now();
  try {
    const readBack = await withTimeout(roundTrip(records));
    // Structural, never textual: Postgres reorders the keys of a jsonb
    // document, so the bytes that come back are not the bytes that went in and
    // only the parsed value can be compared.
    const identical = isDeepStrictEqual(readBack, PROBE_ANNOTATION);
    return {
      configured: true,
      reachable: identical,
      serverVersion,
      pending,
      migrated: pending === 0,
      roundTripMs: elapsed(started),
      reason: identical
        ? null
        : "the annotation just written reads back different",
    };
  } catch (error) {
    return {
      configured: true,
      reachable: false,
      serverVersion,
      pending,
      migrated: pending === 0,
      roundTripMs: elapsed(started),
      reason: publicMessage(error),
    };
  }
}

/** Writes the probe File and its Annotation, and reads the Annotation back. */
async function roundTrip(records: Records): Promise<Annotation | null> {
  await records.files.ensure(PROBE_FILE);
  await records.annotations.put(PROBE_ANNOTATION);
  return records.annotations.get(PROBE_ANNOTATION.hash);
}

/** Every table this database holds, as the backend names them, sorted. */
export async function recordsTables(records: Records): Promise<string[]> {
  const rows = await driverOf(records).query<{ readonly name: string }>(
    sql`select tablename as name from pg_tables where schemaname = current_schema()`
  );
  return rows.map((row) => row.name).sort();
}

async function versionOf(driver: DatabaseDriver): Promise<string | null> {
  const rows = await driver.query<{ readonly version: string }>(
    sql`select current_setting('server_version') as version`
  );
  return rows[0]?.version ?? null;
}

function withTimeout<T>(work: Promise<T>): Promise<T> {
  // `pg` takes no abort signal, so the bound is on the wait and not on the
  // query: a probe that overran leaves its query running and `/health` still
  // answers, which is the trade the endpoint is for.
  let timer: NodeJS.Timeout;
  const bound = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(`the round trip did not finish in ${PROBE_TIMEOUT_MS} ms`)
        ),
      PROBE_TIMEOUT_MS
    );
  });
  return Promise.race([work, bound]).finally(() => clearTimeout(timer));
}

function elapsed(started: number): number {
  return Math.round(performance.now() - started);
}

/**
 * Capped, because this string is served on a public endpoint. A connection
 * string can appear in a driver's error, so the message is also stripped of
 * anything that looks like one.
 */
function publicMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/postgres(ql)?:\/\/\S+/gi, "<connection string>")
    .slice(0, 200);
}
