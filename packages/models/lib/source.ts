/**
 * The second body shape of `POST /annotate`: a JSON `{ url }` naming a
 * short-lived Signed URL, which the host fetches for itself.
 *
 * It exists because the platform refuses a body over 4.5 MB between two
 * container services, measured on preview `dpl_7d5yyyDRd4CYLbSrAFyvLr9wKPG5`,
 * 6 Sep 2026 (#201). A URL and not a Store Key: the carrier is minted by the
 * gateway, which has already decided this caller may see these bytes, so no
 * store credential ever enters this container (ADR-0007, Decision 1).
 *
 * Nothing here trusts the URL more than the gateway's own Source URL fetch
 * does. `https:` on every hop and not only the first, because a `302` down to
 * `http:` would pull the photograph over the wire in clear and a `302` to a
 * link-local address would pull it from inside the deployment.
 */
import { z } from "zod";
import { assertDeclaredLength, collect } from "./body";
import { HostError } from "./errors";

/**
 * The whole body, closed: a field beside the URL would be a carrier this host
 * does not implement, and answering 200 to it would hide that.
 */
export const AnnotateUrl = z.strictObject({
  url: z.url({ protocol: /^https$/ }),
});

export type AnnotateUrl = z.infer<typeof AnnotateUrl>;

/** How the host reaches a Signed URL. The global `fetch` in the container. */
export type FetchSource = typeof globalThis.fetch;

/**
 * How long the fetch may take. Well inside the client's 30 s default, which
 * must also cover a cold session create, the decode and every Model.
 */
const FETCH_TIMEOUT_MS = 15_000;

/** How many redirects a Signed URL may take before it is refused. */
const MAX_REDIRECTS = 3;

const unfetchable = (url: string, why: string, options?: ErrorOptions) =>
  new HostError(
    "source_unfetchable",
    `the source ${redacted(url)} could not be fetched: ${why}`,
    options
  );

/**
 * The URL without its query, for a message. A Signed URL carries the signature
 * that hands over the object in its query, and a log line is not a place to
 * put one.
 */
function redacted(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}

/** The `{ url }` body, or the refusal that says why it is not one. */
export function parseUrlBody(text: string): AnnotateUrl {
  let json: unknown;
  try {
    json = JSON.parse(text) as unknown;
  } catch (cause) {
    throw new HostError(
      "bad_source",
      "the body announced JSON and is not JSON",
      { cause }
    );
  }
  const parsed = AnnotateUrl.safeParse(json);
  if (!parsed.success) {
    throw new HostError(
      "bad_source",
      `the body must be {"url": "https://…"} and nothing else: ${parsed.error.message}`,
      { cause: parsed.error }
    );
  }
  return parsed.data;
}

/** One fetch's answer and how many requests it took to get there. */
interface Answered {
  readonly response: Response;
  /** 1 when the first request answered; 2 and up means it redirected. */
  readonly hops: number;
}

/** The URL's answer, following redirects by hand so every hop is checked. */
async function answered(call: FetchSource, url: string): Promise<Answered> {
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  let at = url;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!at.toLowerCase().startsWith("https:")) {
      throw unfetchable(url, `it redirected to ${redacted(at)}, which is not https`);
    }
    let response: Response;
    try {
      response = await call(at, { signal, redirect: "manual" });
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
    if (!response.ok) {
      await response.body?.cancel();
      throw unfetchable(url, `it answered ${response.status}`);
    }
    return { response, hops: hop + 1 };
  }
  throw unfetchable(url, `it redirected more than ${MAX_REDIRECTS} times`);
}

/**
 * The bytes behind a Signed URL, bounded by the same guard the request body
 * is: by the declared length before one is read and by the stream as they
 * arrive. Exactly these bytes are hashed and decoded, so the Annotation's
 * `hash` is of what this host fetched and the client's `hash_mismatch` still
 * proves the carrier moved the photograph intact.
 */
export interface FetchedSource {
  readonly bytes: Uint8Array;
  /**
   * How many requests the fetch took. 1 means the URL served the object
   * itself. Reported so the open question of whether a Signed URL redirects
   * is answered by a number from the running system rather than by a guess:
   * if it is always 1, the hop loop can go.
   */
  readonly hops: number;
}

export async function fetchSource(
  call: FetchSource,
  url: string
): Promise<FetchedSource> {
  const { response, hops } = await answered(call, url);

  // Cancelled and not merely dropped on every refusal below: an abandoned
  // body holds the connection open while the far side keeps sending, and a
  // 32 MB refusal is exactly the case where that costs most.
  try {
    assertDeclaredLength(response.headers.get("content-length"));
  } catch (refusal) {
    await response.body?.cancel();
    throw refusal;
  }
  if (response.body === null) throw unfetchable(url, "it answered no bytes");

  let bytes: Uint8Array;
  try {
    bytes = await collect(response.body);
  } catch (cause) {
    if (cause instanceof HostError) throw cause;
    throw unfetchable(url, "its body broke off", { cause });
  }
  if (bytes.byteLength === 0) throw unfetchable(url, "it answered no bytes");
  return { bytes, hops };
}
