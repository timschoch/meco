/**
 * Bytes in, for a caller holding a file and no URL.
 *
 * The public door will not carry a photograph. Measured on the preview of
 * [#188](https://github.com/timschoch/meco/issues/188), 6 Sep 2026: a request
 * of 4 493 537 bytes reaches the container and one byte more is the platform's
 * `413 FUNCTION_PAYLOAD_TOO_LARGE`, and the cap counts the whole request, so
 * even the number is not one a client could build against. The 12 MP crew
 * portrait meco measures everything else on is 5 424 279 bytes. A request body
 * is therefore not a way into this deployment, and ADR-0014's recorded
 * fallback is what ships.
 *
 * So the bytes never cross the door at all. Two Operations:
 *
 *   1. `create_upload` mints a Signed URL scoped to one `sources/` key, that
 *      one content type and that one size. The caller `PUT`s its file
 *      straight to the Private Store.
 *   2. `add_source` is handed the key back, reads the object, and hashes it
 *      **itself**. The hash the caller sent is what picked the key; the hash
 *      the gateway takes is what the File is written under. A caller that
 *      uploaded other bytes than it named is refused and its object deleted,
 *      because a File whose hash is not its bytes would poison the Annotation
 *      cache for every Brand, forever.
 *
 * The same reasoning is why the Signed URL cannot overwrite. A caller names
 * the hash its key is built from, so it can name a hash somebody else filed;
 * the backend refusing the second write is what stops it replacing those
 * bytes (`packages/store/lib/blob.ts`). Nothing here may assume otherwise.
 *
 * Both are ordinary Operations and appear on both Doors. Nothing here carries
 * a photograph in a body or a tool result, so the MCP Door loses nothing by
 * having them: an agent gets a URL to put to, exactly as an HTTP client does.
 */
import { createHash } from "node:crypto";
import { MAX_OBJECT_BYTES, storeKeyFor } from "@meco/store";
import { z } from "zod";
import { imageFacts } from "./decode";
import { GatewayError } from "./errors";
import { Brand } from "./inputs";
import type { OperationContext } from "./operations";

/** Where a Source Image is filed. The one Namespace this route may write. */
const SOURCES = "sources";

/**
 * What the caller declares before it uploads. Every field is a claim, and each
 * one is checked against the bytes afterwards.
 */
export const CreateUploadInput = z.object({
  brand: Brand,
  hash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .describe(
      "The SHA-256 of the file you are about to upload, 64 lowercase hex characters. It decides where the file is filed."
    ),
  mime: z
    .enum(["image/jpeg", "image/png", "image/webp"])
    .describe("What the file is. The upload URL takes no other type."),
  bytes: z
    .int()
    .positive()
    .describe("The size of the file. The upload URL takes no more."),
});

export const AddSourceInput = z.object({
  brand: Brand,
  key: z
    .string()
    .min(1)
    .describe("The `key` `create_upload` answered, once the upload finished."),
});

export async function createUpload(
  ctx: OperationContext,
  { hash, mime, bytes }: z.output<typeof CreateUploadInput>
): Promise<Record<string, unknown>> {
  // Ahead of the store's own refusal, so an oversized file is the wire's
  // `413` and its code, and not a `500` from a throw the store meant for a
  // caller inside the deployment.
  if (bytes > MAX_OBJECT_BYTES) {
    throw new GatewayError(
      "too_large",
      `a source is at most ${MAX_OBJECT_BYTES} bytes and this one is ${bytes}`
    );
  }
  const target = await ctx.store.uploadUrl(SOURCES, hash, mime, {
    maxBytes: bytes,
  });
  return {
    key: target.key,
    url: target.url,
    expiresAt: target.expiresAt,
    maxBytes: target.maxBytes,
  };
}

export async function addSource(
  ctx: OperationContext,
  { brand, key }: z.output<typeof AddSourceInput>
): Promise<Record<string, unknown>> {
  // The Namespace, before anything reaches the store: `key` is a caller's
  // string, and this Operation may file a Source Image and nothing else. A
  // Reference Photo is `add_reference_photo`'s to write, under a Person.
  if (!key.startsWith(`${SOURCES}/`)) {
    throw new GatewayError(
      "invalid_request",
      `${key} is not a source key; upload to the key create_upload answered`
    );
  }

  const bytes = await ctx.store.get(key);
  // A key nothing was uploaded to is `not_found`, the same answer an unknown
  // one gets: an upload that never happened and a key that was never minted
  // are the same thing to a caller.
  if (bytes === null) {
    throw new GatewayError("not_found", `nothing is stored at ${key}`);
  }

  // The decoder's answer and not the caller's declaration: `create_upload`
  // took a `mime` to choose an extension, and what the File records is what
  // the bytes actually are.
  const facts = await orphanFree(ctx, key, () => imageFacts(bytes));

  const hash = createHash("sha256").update(bytes).digest("hex");
  // The store's own arithmetic, not a second reading of the key here: where
  // these bytes belong is one question with one answer, and `storeKeyFor` is
  // where it is answered (`docs/specs/store.md`).
  const belongs = storeKeyFor(SOURCES, hash, facts.mime);
  if (belongs !== key) {
    // Removed, not left: the object sits under a key that does not describe
    // it, so nothing may ever read it, and the Sweep only takes what records
    // knows about — which is nothing, since no File was written. Safe to
    // delete precisely because the URL that wrote it could not overwrite:
    // whatever is here, this caller put here.
    await ctx.store.delete(key);
    throw new GatewayError(
      "invalid_request",
      `the bytes uploaded to ${key} belong at ${belongs}, so that key names bytes that were never sent`
    );
  }

  // Finds the object already there and writes nothing; what it is for is the
  // Store Key and the size, read back from the store rather than assumed.
  const put = await ctx.store.put(SOURCES, bytes, facts.mime);
  await ctx.records.files.ensure({
    hash,
    mime: facts.mime,
    width: facts.width,
    height: facts.height,
    bytes: bytes.byteLength,
    storeKey: put.key,
  });
  // Last, and the reason `{ hash }` may be named on the next request at all.
  await ctx.records.sources.hold(brand, hash);

  return { hash, key: put.key, bytes: bytes.byteLength, mime: facts.mime };
}

/**
 * Runs a step that may refuse the uploaded object, and takes the object with
 * it when it does.
 *
 * Bytes that are refused are never filed, so records will never name them and
 * the Sweep — which only removes what records knows about — would leave them
 * in the Private Store for good. An upload nothing accepted has to cost the
 * store nothing.
 */
async function orphanFree<T>(
  ctx: OperationContext,
  key: string,
  step: () => Promise<T>
): Promise<T> {
  try {
    return await step();
  } catch (refusal) {
    await ctx.store.delete(key);
    throw refusal;
  }
}
