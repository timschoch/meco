/**
 * Keyset pagination, written once for the two lists that need it: the Calls
 * list and the Gallery.
 *
 * Offset pagination is out ([ADR-0011](../../../docs/adr/0011-records-postgres-rows-counted-deletes-and-a-sweep.md),
 * Q15). Both lists are append-only and newest first, so a row that lands
 * between two pages shifts every later row down by one and an offset silently
 * skips one. A cursor names where the last page ended, and reading on from
 * there cannot repeat or skip whatever arrived meanwhile.
 *
 * The cursor is opaque on purpose: webui puts it in a query string and hands it
 * back, and a caller that could read it would start constructing one.
 */
import { type SQL, and, eq, lt, or } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

/** One page of a keyset list, with what to ask for the next one. */
export interface Page<Row> {
  readonly rows: readonly Row[];
  /** Pass back as `cursor`. `null` when nothing is left behind this page. */
  readonly cursor: string | null;
}

/**
 * Where a row sits in the order: the time it is sorted by, and the tiebreak
 * that makes two rows written in the same microsecond a total order anyway.
 */
export interface Keyset {
  readonly at: Date;
  readonly tiebreak: string;
}

const encode = (keyset: Keyset): string =>
  Buffer.from(
    JSON.stringify([keyset.at.toISOString(), keyset.tiebreak])
  ).toString("base64url");

/**
 * A cursor this module wrote, or a refusal. Everything a caller could hand
 * over is a string, and one that is not a cursor has to fail loudly: read as an
 * empty keyset it would silently answer with the first page again.
 */
export function decodeCursor(cursor: string): Keyset {
  const refuse = () => {
    throw new Error(
      "@meco/records: that is not a cursor from a records list. Pass back the `cursor` a page returned, or none."
    );
  };

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    return refuse();
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    typeof parsed[0] !== "string" ||
    typeof parsed[1] !== "string"
  ) {
    return refuse();
  }
  const at = new Date(parsed[0]);
  if (Number.isNaN(at.getTime())) return refuse();
  return { at, tiebreak: parsed[1] };
}

/**
 * `(at, tiebreak) < (cursor.at, cursor.tiebreak)` — everything strictly older
 * than where the last page ended.
 *
 * Written as three operators rather than Postgres's row comparison because the
 * two adapters would otherwise have to infer the same parameter types for a
 * bare `($1, $2)`, and a column comparison gives drizzle the types to send.
 */
export const olderThan = (
  at: PgColumn,
  tiebreak: PgColumn,
  keyset: Keyset
): SQL | undefined =>
  or(lt(at, keyset.at), and(eq(at, keyset.at), lt(tiebreak, keyset.tiebreak)));

/**
 * A page out of `limit + 1` rows. The extra row is how "is there an older page"
 * is answered without a second query, and it never reaches the caller.
 */
export function pageOf<Row>(
  rows: readonly Row[],
  limit: number,
  keysetOf: (row: Row) => Keyset
): Page<Row> {
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    rows: page,
    cursor:
      rows.length > limit && last !== undefined ? encode(keysetOf(last)) : null,
  };
}
