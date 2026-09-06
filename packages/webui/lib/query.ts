/**
 * What a list's URL says, and how the page writes one back.
 *
 * Filters and paging are links and nothing else — no form writes, no script
 * reads — so the query string is the whole of a page's state.
 */
import type { CallStatus, OutputKind } from "@meco/records";

/** The Output kinds, as the Gallery's filter links offer them. */
export const KINDS = ["crop", "render", "carousel"] as const;

/** The Call statuses, as the Calls list's filter links offer them. */
export const STATUSES = ["ok", "failed"] as const;

/**
 * A compile error the day `@meco/records` adds a kind or a status and these
 * lists do not: an annotation alone would let a missing one disappear from the
 * filter silently, which is the one way a filter can lie about what is there.
 */
type EveryOneOffered =
  Exclude<OutputKind, (typeof KINDS)[number]> extends never
    ? Exclude<CallStatus, (typeof STATUSES)[number]> extends never
      ? true
      : never
    : never;
const _everyOneOffered: EveryOneOffered = true;

export interface GalleryQuery {
  readonly brand?: string | undefined;
  readonly placement?: string | undefined;
  readonly kind?: OutputKind | undefined;
  readonly cursor?: string | undefined;
}

export interface CallsQuery {
  readonly brand?: string | undefined;
  readonly status?: CallStatus | undefined;
  readonly cursor?: string | undefined;
}

/** Thrown for a filter naming nothing that exists. The route answers `400`. */
export class NotAValue extends Error {
  constructor(field: string, given: string, allowed: readonly string[]) {
    super(
      `@meco/webui: "${given}" is no ${field}. One of: ${allowed.join(", ")}.`
    );
    this.name = "NotAValue";
  }
}

/** An empty parameter means "not given", so `?brand=` is the unfiltered page. */
const given = (url: URL, name: string): string | undefined => {
  const value = url.searchParams.get(name);
  return value === null || value === "" ? undefined : value;
};

/** One closed set, parsed off the URL: the value, nothing, or a refusal. */
function oneOf<Value extends string>(
  url: URL,
  name: string,
  field: string,
  allowed: readonly Value[]
): Value | undefined {
  const value = given(url, name);
  if (value === undefined) return undefined;
  const found = allowed.find((one) => one === value);
  if (found === undefined) throw new NotAValue(field, value, allowed);
  return found;
}

export function galleryQuery(url: URL): GalleryQuery {
  return {
    brand: given(url, "brand"),
    placement: given(url, "placement"),
    kind: oneOf(url, "kind", "output kind", KINDS),
    cursor: given(url, "cursor"),
  };
}

export function callsQuery(url: URL): CallsQuery {
  return {
    brand: given(url, "brand"),
    status: oneOf(url, "status", "call status", STATUSES),
    cursor: given(url, "cursor"),
  };
}

/** The fields the Gallery's filter links may change. */
export const GALLERY_FIELDS = ["brand", "placement", "kind"] as const;

/** The fields the Calls list's filter links may change. */
export const CALLS_FIELDS = ["brand", "status"] as const;

/**
 * Everything a link on one list needs: where the list lives, what it is
 * currently narrowed to, and which fields a filter link may touch. The three
 * always travel together, so they travel as one.
 */
export interface Links<Field extends string> {
  readonly path: string;
  readonly query: Readonly<Partial<Record<Field, string | undefined>>>;
  readonly fields: readonly Field[];
}

/**
 * The same page with one field changed. A filter link drops the cursor: kept,
 * it would open the second page of a list nobody has seen the first page of.
 * Only the "older" link carries one, and it changes nothing else.
 */
export function linkTo<Field extends string>(
  links: Links<Field>,
  change: { field: Field; value?: string } | { cursor: string }
): string {
  const next = new URLSearchParams();
  const changed = "field" in change ? change : null;
  for (const field of links.fields) {
    const value =
      changed !== null && changed.field === field
        ? changed.value
        : links.query[field];
    if (value !== undefined && value !== "") next.set(field, value);
  }
  if ("cursor" in change) next.set("cursor", change.cursor);

  // A sub-app mounted at the root has an empty `basePath`, and a link has to
  // be a path.
  const at = links.path === "" ? "/" : links.path;
  const search = next.toString();
  return search === "" ? at : `${at}?${search}`;
}
