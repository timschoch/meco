/**
 * One page of a records list, over every Brand the Caller holds.
 *
 * Both lists webui renders are narrowed to **one** Brand per query — the
 * Gallery because `outputs.list` takes one, the Calls list because the Brand
 * wall means an unnarrowed `calls.list` would answer with rows the Caller may
 * not see. Records' cursors are opaque on purpose (`@meco/records`,
 * `lib/page.ts`): webui may hand one back and may not build one. A Caller
 * holding three Brands therefore cannot be served by one records query, and the
 * union has to be merged here.
 *
 * The merge is exact rather than best-effort. Every Brand is listed from where
 * it last stopped, the lists are merged on the same key records orders by
 * (the sort time first, records' own tiebreak second), the newest `pageSize`
 * rows are the page, and the cursor this returns records where **each** Brand
 * stopped — so the next page can neither repeat a row nor skip one, whatever
 * arrives in between. A Brand only partly consumed is asked once more for the
 * cursor that sits exactly after the rows this page took; that is the one
 * extra query per partly-consumed Brand a page costs.
 *
 * The day records takes several Brands in one query, this file goes.
 */
import type { Page } from "@meco/records";

/** One page of the merge, in the shape records reports its own. */
export interface Merged<Row> {
  readonly rows: readonly Row[];
  /** Pass back as `cursor`. `null` when nothing is left behind this page. */
  readonly cursor: string | null;
}

/**
 * One Brand's slice of the list, as its records method answers it: everything
 * but the Brand, the cursor and the limit is closed over by the caller.
 */
export type BrandPage<Row> = (
  brand: string,
  from: string | undefined,
  limit: number
) => Promise<Page<Row>>;

/**
 * Where a row sits in the order, for the merge alone.
 *
 * `at` is the row's sort time as its type reports it, and it is the **only**
 * key the merge sorts on: ties are left at zero and `Array.prototype.sort` is
 * stable, so a tie keeps the order the rows came in — which inside one Brand is
 * the order records read them in, microseconds and records' own tiebreak
 * included.
 *
 * A tiebreak must **not** be added here. A row's time crosses the seam as
 * milliseconds (`records`, `toISOString`) while records orders on the
 * `timestamptz`'s microseconds (`records`, `lib/page.ts`), so a tiebreak on
 * this side would reorder two rows of one Brand that records had already
 * ordered — and the cursor, which counts how many of that Brand's rows the page
 * took, would then advance past a row the page never showed.
 *
 * What is left undecided is the order of two rows of *different* Brands inside
 * one millisecond: they appear in the order the Brands were asked. Records has
 * no order across Brands to disagree with, and no page repeats or skips a row
 * because of it.
 */
export interface Order<Row> {
  brandOf(row: Row): string;
  at(row: Row): string;
}

/**
 * Where each Brand's list stopped: a records cursor, `null` once that Brand is
 * exhausted, and absent for a Brand not yet started.
 */
type Marks = Readonly<Record<string, string | null>>;

/** Thrown for a cursor this module did not write. The route answers `400`. */
export class NotACursor extends Error {
  constructor() {
    super(
      "@meco/webui: that is not a cursor from a page of this list. Follow the older link, or ask for the first page."
    );
    this.name = "NotACursor";
  }
}

const encode = (marks: Marks): string =>
  Buffer.from(JSON.stringify(marks)).toString("base64url");

/**
 * Refused rather than ignored, for the reason records refuses its own: read as
 * an empty mark set, a cursor that is not one would silently answer with the
 * first page again.
 *
 * Only the envelope is checked here. What a mark holds is one of records'
 * opaque cursors and there is nothing on this side that can judge one, so a
 * hand-made cursor carrying a well-formed envelope and a junk mark reaches
 * records, which refuses it with a plain `Error` the route cannot tell from a
 * database that did not answer — and renders `503` where `400` is the truth. A
 * named error or a predicate from records closes it; raised on #173.
 */
function decode(cursor: string): Marks {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new NotACursor();
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new NotACursor();
  }
  for (const value of Object.values(parsed)) {
    if (value !== null && typeof value !== "string") throw new NotACursor();
  }
  return parsed as Marks;
}

export async function mergedPage<Row>(
  brands: readonly string[],
  pageSize: number,
  cursor: string | undefined,
  listing: BrandPage<Row>,
  order: Order<Row>
): Promise<Merged<Row>> {
  const marks = cursor === undefined ? {} : decode(cursor);

  const asked = await Promise.all(
    brands
      .filter((brand) => marks[brand] !== null)
      .map(async (brand) => {
        // `null` is already filtered out above: it means exhausted, not a cursor.
        const from = marks[brand] ?? undefined;
        const page = await listing(brand, from, pageSize);
        return { brand, from, rows: page.rows, cursor: page.cursor };
      })
  );

  const newestFirst = (a: Row, b: Row): number => {
    const [left, right] = [order.at(a), order.at(b)];
    return left === right ? 0 : left < right ? 1 : -1;
  };

  const merged = asked
    .flatMap((one) => one.rows)
    .sort(newestFirst)
    .slice(0, pageSize);

  const taken = new Map<string, number>();
  for (const row of merged) {
    const brand = order.brandOf(row);
    taken.set(brand, (taken.get(brand) ?? 0) + 1);
  }

  const next: Record<string, string | null> = {};
  // A Brand nobody asked this round is exhausted; saying so keeps it out of
  // every later page's queries.
  for (const brand of brands) next[brand] = null;

  await Promise.all(
    asked.map(async (one) => {
      const consumed = taken.get(one.brand) ?? 0;
      if (consumed === one.rows.length) {
        // Everything this Brand offered is on the page, so its own cursor is
        // where it stopped — `null` when it has nothing older left.
        next[one.brand] = one.cursor;
        return;
      }
      if (consumed === 0) {
        // Nothing of this Brand made the page: it stays exactly where it was.
        if (one.from !== undefined) next[one.brand] = one.from;
        else delete next[one.brand];
        return;
      }
      // Partly consumed. The same query cut to what the page took ends on the
      // last row taken, so its cursor is the place after it. It cannot be
      // `null`: this Brand returned more rows than the page used.
      const upTo = await listing(one.brand, one.from, consumed);
      next[one.brand] = upTo.cursor;
    })
  );

  const older = brands.some((brand) => next[brand] !== null);
  return { rows: merged, cursor: older ? encode(next) : null };
}
