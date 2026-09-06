/**
 * The Source Reference resolver: from `{ url }` or `{ hash }` to bytes the
 * pipeline can hand models, and to the facts records keeps about them.
 *
 * A `{ url }` is fetched with the gateway's `fetch`, bounded at the store's
 * `MAX_OBJECT_BYTES` twice — by `Content-Length` before a byte is read and by
 * the stream as it arrives — and refused as `source_unfetchable` on anything
 * but a 2xx within the timeout. A `{ hash }` names bytes this Brand already
 * holds a Source Hold on; without one it is `not_found`, and the answer does
 * not say whether the bytes exist (spec, "Inputs").
 */
import { createHash } from "node:crypto";
import { MAX_OBJECT_BYTES, type Store } from "@meco/store";
import type { Records } from "@meco/records";
import { z } from "zod";
import { GatewayError } from "./errors";
import type { Trace } from "./trace";

/** How a request names a Source Image: by URL, or by a Content Hash it already sent. */
export const SourceReference = z.union([
  z.object({
    url: z
      .url({ protocol: /^https$/ })
      .describe("An https URL the gateway fetches and files."),
  }),
  z.object({
    hash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .describe("The Content Hash of bytes this Brand already sent."),
  }),
]);

export type SourceReference = z.infer<typeof SourceReference>;

/** A Source Image the pipeline may run: its hash now, its bytes on demand. */
export interface ResolvedSource {
  readonly hash: string;
  /**
   * The bytes, read once. A `{ url }` already holds them; a `{ hash }` reads
   * them off the store only when the Annotation cache cannot answer, so a
   * photograph meco knows costs no round trip to Blob.
   */
  bytes(): Promise<Uint8Array>;
}

export interface SourceDeps {
  readonly records: Records;
  readonly store: Store;
  readonly fetch: typeof fetch;
}

const FETCH_TIMEOUT_MS = 30_000;

const unfetchable = (url: string, why: string, options?: ErrorOptions) =>
  new GatewayError(
    "source_unfetchable",
    `the source ${url} could not be fetched: ${why}`,
    undefined,
    options
  );

const tooLarge = (url: string) =>
  new GatewayError(
    "too_large",
    `the source ${url} is over ${MAX_OBJECT_BYTES} bytes`
  );

/** The URL's bytes, or the refusal the spec names for what went wrong. */
async function fetchBytes(
  call: typeof fetch,
  url: string
): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await call(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: "follow",
      // Named, because a public image host may refuse a bare client.
      headers: { "user-agent": "meco-gateway (+https://github.com/timschoch/meco)" },
    });
  } catch (cause) {
    throw unfetchable(url, "it did not answer", { cause });
  }
  if (!response.ok) {
    throw unfetchable(url, `it answered ${response.status}`);
  }

  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_OBJECT_BYTES) {
    await response.body?.cancel();
    throw tooLarge(url);
  }
  if (response.body === null) throw unfetchable(url, "it answered no bytes");

  // By the stream as well: a host that lies about, or omits, `Content-Length`
  // must not hand the gateway a runaway body.
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_OBJECT_BYTES) throw tooLarge(url);
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof GatewayError) {
      await reader.cancel();
      throw error;
    }
    throw unfetchable(url, "its body broke off", { cause: error });
  }
  if (total === 0) throw unfetchable(url, "it answered no bytes");
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

export async function resolveSource(
  deps: SourceDeps,
  brand: string,
  source: SourceReference,
  trace: Trace
): Promise<ResolvedSource> {
  if ("url" in source) {
    const bytes = await trace.step("source.fetch", () =>
      fetchBytes(deps.fetch, source.url)
    );
    const hash = createHash("sha256").update(bytes).digest("hex");
    return { hash, bytes: async () => bytes };
  }

  const held = await trace.step("records.sources.heldBy", () =>
    deps.records.sources.heldBy(brand, source.hash)
  );
  if (!held) {
    throw new GatewayError(
      "not_found",
      `this brand holds no source ${source.hash}`
    );
  }
  let read: Promise<Uint8Array> | undefined;
  return {
    hash: source.hash,
    bytes: () =>
      (read ??= trace.step("store.get", async () => {
        const file = await deps.records.files.get(source.hash);
        const stored =
          file === null ? null : await deps.store.get(file.storeKey);
        if (stored === null) {
          // A hold on a File whose bytes are gone is a records invariant
          // broken, not a caller's mistake.
          throw new Error(`the bytes of ${source.hash} are held and not stored`);
        }
        return stored;
      })),
  };
}
