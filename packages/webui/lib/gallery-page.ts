/**
 * One page of the Gallery, over every Brand the Caller holds.
 *
 * `outputs.list` narrows to **one** Brand, and its cursor is opaque on purpose
 * (`@meco/records`, `lib/page.ts`): webui may hand one back and may not build
 * one. A Caller holding three Brands therefore cannot be served by one records
 * query, and the union has to be merged here.
 *
 * The merge is exact rather than best-effort. Every Brand is listed from where
 * it last stopped, the lists are merged on the same key records orders by
 * (`created_at` first, the Store Key as the tiebreak), the newest `pageSize`
 * rows are the page, and the cursor this returns records where **each** Brand
 * stopped — so the next page can neither repeat a row nor skip one, whatever
 * arrives in between. A Brand only partly consumed is asked once more for the
 * cursor that sits exactly after the rows this page took; that is the one
 * extra query per partly-consumed Brand a page costs.
 *
 * The day `outputs.list` takes several Brands, this file collapses to one call.
 */
import type { Output, OutputKind, Records } from "@meco/records";

/** What the Gallery was asked to narrow by, beyond the Caller's own Brands. */
export interface GalleryFilter {
  readonly placement?: string;
  readonly kind?: OutputKind;
}

export interface GalleryPage {
  readonly outputs: readonly Output[];
  /** Pass back as `cursor`. `null` when nothing is left behind this page. */
  readonly cursor: string | null;
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
      "@meco/webui: that is not a cursor from a Gallery page. Follow the older link, or ask for the first page."
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

/**
 * The order the merge puts the Brands' lists in, and the one thing it may not
 * get wrong.
 *
 * `createdAt` alone, with a tie left at zero. `Array.prototype.sort` is stable,
 * so a tie keeps the order the rows came in — which inside one Brand is the
 * order records read them in, microseconds and Store Key tiebreak included.
 *
 * The Store Key must **not** break the tie here. An `Output`'s `createdAt` is
 * milliseconds (`records`, `asOutput`, `toISOString`) while records orders on
 * the `timestamptz`'s microseconds (`records`, `lib/page.ts`), so a tiebreak on
 * this side would reorder two rows of one Brand that records had already
 * ordered — and the cursor, which counts how many of that Brand's rows the page
 * took, would then advance past a row the page never showed.
 *
 * What is left undecided is the order of two Outputs of *different* Brands
 * inside one millisecond: they appear in the order the Brands were asked.
 * records has no order across Brands to disagree with, and no page repeats or
 * skips a row because of it.
 */
const newestFirst = (a: Output, b: Output): number =>
  a.createdAt === b.createdAt ? 0 : a.createdAt < b.createdAt ? 1 : -1;

export async function galleryPage(
  records: Records,
  brands: readonly string[],
  filter: GalleryFilter,
  pageSize: number,
  cursor: string | undefined
): Promise<GalleryPage> {
  const marks = cursor === undefined ? {} : decode(cursor);

  const asked = await Promise.all(
    brands
      .filter((brand) => marks[brand] !== null)
      .map(async (brand) => {
        // `null` is already filtered out above: it means exhausted, not a cursor.
        const from = marks[brand] ?? undefined;
        const page = await records.outputs.list({
          brand,
          ...filter,
          ...(from === undefined ? {} : { cursor: from }),
          limit: pageSize,
        });
        return { brand, from, rows: page.rows, cursor: page.cursor };
      })
  );

  const merged = asked
    .flatMap((one) => one.rows)
    .sort(newestFirst)
    .slice(0, pageSize);

  const taken = new Map<string, number>();
  for (const output of merged) {
    taken.set(output.brand, (taken.get(output.brand) ?? 0) + 1);
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
      const upTo = await records.outputs.list({
        brand: one.brand,
        ...filter,
        ...(one.from === undefined ? {} : { cursor: one.from }),
        limit: consumed,
      });
      next[one.brand] = upTo.cursor;
    })
  );

  const older = brands.some((brand) => next[brand] !== null);
  return { outputs: merged, cursor: older ? encode(next) : null };
}
