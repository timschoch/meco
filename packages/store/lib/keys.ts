/**
 * What a Store Key is, and which of the two stores it belongs to. Nothing here
 * reaches a backend: every refusal below happens before a call is made.
 */
import { createHash } from "node:crypto";

/**
 * The first segment of a Store Key, saying what kind of thing is filed under it.
 *
 * `health` and `health-public` hold the two probe objects `/health` round-trips
 * and nothing else, one per store. They are Namespaces of their own rather than
 * corners of `sources` and `renders` so that a 1×1 PNG never appears in a
 * `list("sources/")` deletion proof or in the Gallery, and so `records` never
 * has to explain a Source Image nothing uploaded. There are two because a
 * Namespace maps to exactly one store, so the two probes cannot share one.
 */
export const NAMESPACES = [
  "sources",
  "renders",
  "crops",
  "people",
  "health",
  "health-public",
] as const satisfies readonly string[];

export type Namespace = (typeof NAMESPACES)[number];

/** The Namespaces whose objects no URL hands over on its own. */
const PRIVATE_NAMESPACES: readonly Namespace[] = [
  "sources",
  "people",
  "health",
];

/**
 * Which of the two stores a key belongs to. Vercel Blob sets access per store,
 * so this names a store as much as it names a mode.
 */
export type Access = "public" | "private";

/**
 * 32 MiB. Four times the largest ordinary camera original meco has measured
 * (#30: 5 424 279 bytes for a 12 MP crew portrait) and far below Blob's
 * ceiling. Over it is refused with the real size, never truncated.
 */
export const MAX_OBJECT_BYTES = 33_554_432;

/**
 * Closed, so an extension is never guessed. A content type that is not here is
 * refused rather than stored under a name that misdescribes it.
 */
const EXTENSIONS = new Map<string, string>([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
  ["application/pdf", "pdf"],
]);

/**
 * Which store a Store Key belongs to, decided by its Namespace alone so that no
 * call site can choose the wrong one by forgetting.
 *
 * The comparison is case-insensitive because this one line is what stands
 * between a Reference Photo and an open URL: `People/…` must not be a way out.
 * It matches the whole first segment, so `peoples-choice/…` stays public.
 */
export function isPrivate(key: string): boolean {
  const namespace = key.split("/", 1)[0]?.toLowerCase();
  return PRIVATE_NAMESPACES.some((n) => n === namespace);
}

/** The same decision as `isPrivate`, as the word the backend and the report use. */
export function accessFor(key: string): Access {
  return isPrivate(key) ? "private" : "public";
}

/**
 * On every backend a key is a path, and `..` is how a path leaves the store it
 * was supposed to be inside. Refusing the first segment when it names no
 * Namespace is the other half: an unknown Namespace is not private, so without
 * this check a mistyped prefix would land in the Public Store and say nothing.
 */
export function assertKey(key: string, label = "Store key"): void {
  if (key === "") throw new Error(`@meco/store: the ${label} is empty.`);
  if (key.startsWith("/")) {
    throw new Error(`@meco/store: the ${label} "${key}" has a leading slash.`);
  }
  for (const segment of key.split("/")) {
    if (segment === "") {
      throw new Error(
        `@meco/store: the ${label} "${key}" has an empty segment.`
      );
    }
    if (segment === "." || segment === "..") {
      throw new Error(
        `@meco/store: the ${label} "${key}" has a "." or ".." segment.`
      );
    }
  }
  const namespace = key.split("/", 1)[0]?.toLowerCase() ?? "";
  if (!NAMESPACES.some((n) => n === namespace)) {
    throw new Error(
      `@meco/store: the ${label} "${key}" starts with "${namespace}", which is no Namespace. One of: ${NAMESPACES.join(", ")}.`
    );
  }
}

/**
 * What `list` matches a subtree against. The trailing slash is the whole
 * point: on a raw string match `people/laica/p_1` would also name
 * `people/laica/p_10/…`, and a cascade delete would then prove itself against
 * another Person's objects. It is the same whole-segment rule `isPrivate`
 * applies to the Namespace, one segment further down.
 */
export function subtreePrefix(prefix: string): string {
  return `${prefix}/`;
}

/**
 * The order every adapter's `list` hands its objects back in. A `Map` yields
 * insertion order and a backend yields its own, so without one comparator both
 * share, the two adapters would differ in what a caller may rely on — which is
 * the difference the Conformance Checks exist to catch.
 */
export function byKey(a: { key: string }, b: { key: string }): number {
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/** The extension for a content type, or a refusal naming the type. */
export function extensionFor(contentType: string): string {
  const extension = EXTENSIONS.get(contentType);
  if (extension === undefined) {
    throw new Error(
      `@meco/store: content type "${contentType}" maps to no extension. One of: ${[...EXTENSIONS.keys()].join(", ")}.`
    );
  }
  return extension;
}

export function assertWithinLimit(bytes: Uint8Array): void {
  if (bytes.byteLength > MAX_OBJECT_BYTES) {
    throw new Error(
      `@meco/store: ${bytes.byteLength} bytes is over MAX_OBJECT_BYTES (${MAX_OBJECT_BYTES}).`
    );
  }
}

/**
 * How big an upload a Signed URL will take. Refused rather than clamped, for
 * the reason `validUntilFor` gives about a lifetime: a caller that asked for
 * more than the store holds and silently got less would find out mid-upload.
 */
export function uploadBound(maxBytes: number = MAX_OBJECT_BYTES): number {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new Error(
      `@meco/store: maxBytes ${maxBytes} is no size. A whole number of bytes from 1 to ${MAX_OBJECT_BYTES}.`
    );
  }
  if (maxBytes > MAX_OBJECT_BYTES) {
    throw new Error(
      `@meco/store: maxBytes ${maxBytes} is over MAX_OBJECT_BYTES (${MAX_OBJECT_BYTES}).`
    );
  }
  return maxBytes;
}

/** The Content Hash: 64 lowercase hex characters, never truncated. */
export function contentHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * The Store Key for these bytes under this prefix. Every key ends in the hash
 * of its own bytes, so a write is never an overwrite: different bytes are a
 * different key, and the same bytes are the same write.
 */
export function storeKey(
  prefix: string,
  bytes: Uint8Array,
  contentType: string
): { readonly key: string; readonly hash: string } {
  assertWithinLimit(bytes);
  const hash = contentHash(bytes);
  return { key: storeKeyFor(prefix, hash, contentType), hash };
}

/**
 * The same Store Key from the hash alone, for the one caller that has the hash
 * before it has the bytes: an upload the client sends straight to the backend.
 * The arithmetic is {@link storeKey}'s, so a key minted ahead of the bytes and
 * a key computed from them cannot disagree.
 */
export function storeKeyFor(
  prefix: string,
  hash: string,
  contentType: string
): string {
  assertKey(prefix, "prefix");
  assertContentHash(hash);
  return `${prefix}/${hash}.${extensionFor(contentType)}`;
}

/** 64 lowercase hex characters, or a refusal: a key is only ever a real hash. */
export function assertContentHash(hash: string): void {
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    throw new Error(
      `@meco/store: "${hash}" is no Content Hash. 64 lowercase hex characters.`
    );
  }
}
