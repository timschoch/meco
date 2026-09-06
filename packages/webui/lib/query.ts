/**
 * What a Gallery URL says, and how the page writes one back.
 *
 * Filters and paging are links and nothing else — no form writes, no script
 * reads — so the query string is the whole of the page's state.
 */
import type { OutputKind } from "@meco/records";

/** The Output kinds, as filter links offer them. */
export const KINDS = ["crop", "render", "carousel"] as const;

/**
 * A compile error the day `@meco/records` adds a kind and this list does not:
 * an annotation alone would let a missing kind disappear from the filter
 * silently, which is the one way a filter can lie about what is there.
 */
type EveryKindOffered =
  Exclude<OutputKind, (typeof KINDS)[number]> extends never ? true : never;
const _everyKindOffered: EveryKindOffered = true;

export interface GalleryQuery {
  readonly brand?: string | undefined;
  readonly placement?: string | undefined;
  readonly kind?: OutputKind | undefined;
  readonly cursor?: string | undefined;
}

/** Thrown for `?kind=` naming no Output kind. The route answers `400`. */
export class NotAKind extends Error {
  constructor(given: string) {
    super(
      `@meco/webui: "${given}" is no output kind. One of: ${KINDS.join(", ")}.`
    );
    this.name = "NotAKind";
  }
}

/** An empty parameter means "not given", so `?brand=` is the unfiltered page. */
const given = (url: URL, name: string): string | undefined => {
  const value = url.searchParams.get(name);
  return value === null || value === "" ? undefined : value;
};

export function galleryQuery(url: URL): GalleryQuery {
  const kind = given(url, "kind");
  if (kind !== undefined && !KINDS.some((one) => one === kind)) {
    throw new NotAKind(kind);
  }
  return {
    brand: given(url, "brand"),
    placement: given(url, "placement"),
    kind: kind as OutputKind | undefined,
    cursor: given(url, "cursor"),
  };
}

/** The fields a filter link may change. The cursor is handled on its own. */
const FILTERABLE = ["brand", "placement", "kind"] as const;

export type Filterable = (typeof FILTERABLE)[number];

/**
 * The same page with one field changed. A filter link drops the cursor: kept,
 * it would open the second page of a list nobody has seen the first page of.
 * Only the "older" link carries one, and it changes nothing else.
 */
export function linkTo(
  basePath: string,
  query: GalleryQuery,
  change: { field: Filterable; value?: string } | { cursor: string }
): string {
  const next = new URLSearchParams();
  const changed = "field" in change ? change : null;
  for (const field of FILTERABLE) {
    const value =
      changed !== null && changed.field === field
        ? changed.value
        : query[field];
    if (value !== undefined && value !== "") next.set(field, value);
  }
  if ("cursor" in change) next.set("cursor", change.cursor);

  const path = basePath === "" ? "/" : basePath;
  const search = next.toString();
  return search === "" ? path : `${path}?${search}`;
}
