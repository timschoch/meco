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
  assertKey(prefix, "prefix");
  const extension = extensionFor(contentType);
  assertWithinLimit(bytes);
  const hash = contentHash(bytes);
  return { key: `${prefix}/${hash}.${extension}`, hash };
}
