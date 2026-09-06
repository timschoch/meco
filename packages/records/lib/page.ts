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
import { type SQL, and, eq, lt, or, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

/** One page of a keyset list, with what to ask for the next one. */
export interface Page<Row> {
  readonly rows: readonly Row[];
  /** Pass back as `cursor`. `null` when nothing is left behind this page. */
  readonly cursor: string | null;
}

/** Where a row sits in the order: the time it is sorted by, and its tiebreak. */
export interface Keyset {
  /**
   * The sort time **as Postgres holds it**, its `::text` and never a parsed
   * `Date`.
   *
   * A `timestamptz` keeps microseconds and a JavaScript `Date` keeps
   * milliseconds, so a cursor built from the parsed value asks for everything
   * strictly older than a *truncated* instant — which excludes every row in the
   * rest of that millisecond, including rows older than the one the cursor
   * points at. Measured 6 Sep 2026 on pglite 0.5.8: two rows at `.123456` and
   * `.123200`, a cursor taken from the first, `where ts < $1` bound to the
   * parsed `Date` returns neither. The tiebreak cannot rescue it, because
   * `= $1` never fires either.
   *
   * No Conformance Check provokes this: the seam gives no way to write two rows
   * in one millisecond at different microseconds — pglite's clock is
   * millisecond-resolution, and two round trips to `eu-central-1` are
   * milliseconds apart. It is provable against the driver and not against the
   * module, so the type is what keeps it fixed.
   */
  readonly at: string;
  /**
   * The columns after the time, in the order they are sorted by, that together
   * make the row's place unique. The Calls list needs one — an id — and the
   * Gallery needs two, because two Outputs of one Brand may share a Store Key
   * (#223) and only the Request Hash after it tells them apart.
   */
  readonly tiebreak: readonly string[];
}

/** The sort column as the exact text a {@link Keyset} carries. */
export const cursorAt = (column: PgColumn): SQL<string> =>
  sql<string>`${column}::text`;

const encode = (keyset: Keyset): string =>
  Buffer.from(JSON.stringify([keyset.at, ...keyset.tiebreak])).toString(
    "base64url"
  );

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
    parsed.length < 2 ||
    !parsed.every((one) => typeof one === "string")
  ) {
    return refuse();
  }
  const [at, ...tiebreak] = parsed as string[];
  if (at === undefined) return refuse();
  return { at, tiebreak };
}

/**
 * `(at, ...tiebreak) < (cursor.at, ...cursor.tiebreak)` — everything strictly
 * older than where the last page ended, compared left to right.
 *
 * Written as plain operators rather than Postgres's row comparison because the
 * two adapters would otherwise have to infer the same parameter types for a
 * bare `($1, $2)`. The cast sits on the constant, so the index on
 * `(sort column, ...tiebreak)` is still the one that answers.
 *
 * A cursor carrying a different number of tiebreaks than the list has columns
 * is refused rather than padded: it is a cursor from another list, and read as
 * a short one it would page through the wrong order in silence.
 */
export const olderThan = (
  at: PgColumn,
  tiebreak: readonly PgColumn[],
  keyset: Keyset
): SQL | undefined => {
  if (keyset.tiebreak.length !== tiebreak.length) {
    throw new Error(
      "@meco/records: that cursor belongs to another list. Pass back the `cursor` this list returned, or none."
    );
  }

  /** The comparison from `tiebreak[index]` rightwards, or nothing past the end. */
  const after = (index: number): SQL | undefined => {
    const column = tiebreak[index];
    const value = keyset.tiebreak[index];
    if (column === undefined || value === undefined) return undefined;
    const rest = after(index + 1);
    return rest === undefined
      ? lt(column, value)
      : or(lt(column, value), and(eq(column, value), rest));
  };

  const edge = sql`${keyset.at}::timestamptz`;
  const rest = after(0);
  return rest === undefined ? lt(at, edge) : or(lt(at, edge), and(eq(at, edge), rest));
};

/**
 * A page out of `limit + 1` rows. The extra row is how "is there an older page"
 * is answered without a second query, and it never reaches the caller.
 *
 * The rows come in as the driver read them, because the keyset is taken from a
 * column the caller's own shape does not carry.
 */
export function pageOf<Row, Item>(
  rows: readonly Row[],
  limit: number,
  asItem: (row: Row) => Item,
  keysetOf: (row: Row) => Keyset
): Page<Item> {
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    rows: page.map(asItem),
    cursor:
      rows.length > limit && last !== undefined ? encode(keysetOf(last)) : null,
  };
}
