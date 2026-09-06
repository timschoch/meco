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
  /**
   * The media type the source announced: the URL's `Content-Type`, or the
   * File's `mime`. Lazy for the same reason the bytes are — `annotate` never
   * asks, because the decoder's own answer on the Annotation outranks anything
   * a host claimed. `enrol` asks, because `identify.enrol` needs a type before
   * there is an Annotation to read one off.
   */
  contentType(): Promise<string>;
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

/** How many redirects a Source URL may take before it is refused. */
const MAX_REDIRECTS = 5;

/**
 * The URL's answer, following redirects by hand.
 *
 * `https:` only is a rule about **every** hop and not only about the one the
 * caller typed, which is all the schema can check. Left to `fetch`, a `302`
 * down to `http:` would pull the photograph over the wire in clear, and a
 * `302` to a link-local address would pull it from inside the deployment. Both
 * are things a caller who named an https URL may not do.
 */
async function answered(call: typeof fetch, url: string): Promise<Response> {
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  let at = url;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!at.toLowerCase().startsWith("https:")) {
      throw unfetchable(url, `it redirected to ${at}, which is not https`);
    }
    let response: Response;
    try {
      response = await call(at, {
        signal,
        redirect: "manual",
        // Named, because a public image host may refuse a bare client.
        headers: {
          "user-agent": "meco-gateway (+https://github.com/timschoch/meco)",
        },
      });
    } catch (cause) {
      throw unfetchable(url, "it did not answer", { cause });
    }

    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location !== null) {
      await response.body?.cancel();
      // Resolved against the hop that sent it, as a browser would: a relative
      // `Location` is ordinary and is not a way past the check above.
      at = new URL(location, at).toString();
      continue;
    }
    if (!response.ok) throw unfetchable(url, `it answered ${response.status}`);
    return response;
  }
  throw unfetchable(url, `it redirected more than ${MAX_REDIRECTS} times`);
}

/** The URL's bytes and media type, or the refusal the spec names. */
async function fetchBytes(
  call: typeof fetch,
  url: string
): Promise<{ bytes: Uint8Array; contentType: string }> {
  const response = await answered(call, url);

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
  let written = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, written);
    written += chunk.byteLength;
  }
  return { bytes, contentType: mediaTypeOf(response) };
}

/**
 * The media type alone, without the parameters a `Content-Type` may carry.
 * Nothing is guessed when the header is missing: what a photograph is, is
 * models' answer to make, and a guess from the URL would be the gateway making
 * it instead.
 */
function mediaTypeOf(response: Response): string {
  const header = response.headers.get("content-type");
  if (header === null) return "application/octet-stream";
  return (header.split(";")[0] ?? "").trim().toLowerCase();
}

export async function resolveSource(
  deps: SourceDeps,
  brand: string,
  source: SourceReference,
  trace: Trace
): Promise<ResolvedSource> {
  if ("url" in source) {
    const { bytes, contentType } = await trace.step("source.fetch", () =>
      fetchBytes(deps.fetch, source.url)
    );
    const hash = createHash("sha256").update(bytes).digest("hex");
    return {
      hash,
      bytes: async () => bytes,
      contentType: async () => contentType,
    };
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
  // One read for both answers, and only if something asks: a Call the
  // Annotation cache serves reads neither.
  let read: Promise<{ bytes: Uint8Array; mime: string }> | undefined;
  const stored = () =>
    (read ??= trace.step("store.get", async () => {
      const file = await deps.records.files.get(source.hash);
      const bytes = file === null ? null : await deps.store.get(file.storeKey);
      if (file === null || bytes === null) {
        // A hold on a File whose bytes are gone is a records invariant
        // broken, not a caller's mistake.
        throw new Error(`the bytes of ${source.hash} are held and not stored`);
      }
      return { bytes, mime: file.mime };
    }));

  return {
    hash: source.hash,
    bytes: async () => (await stored()).bytes,
    contentType: async () => (await stored()).mime,
  };
}
