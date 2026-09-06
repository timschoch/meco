/**
 * The store reporting on itself: one byte round trip per store, so a
 * deployment can say whether it can actually reach `fra1` rather than whether
 * an environment variable happens to be set.
 */
import { blobStore } from "./blob";
import {
  type CredentialSource,
  credentialSourceFor,
  storeIdFor,
} from "./credentials";
import type { Access, Namespace } from "./keys";

/** What one of the two stores looks like from inside the deployment. */
export type StoreReach = {
  /** That store's id variable is set, so the store has an address. */
  readonly configured: boolean;
  /** Non-secret: it is the first label of every public URL the store hands out. */
  readonly storeId: string | null;
  /** Which credential carried the round trip. */
  readonly credential: CredentialSource | null;
  /** Bytes were written and read back identical. */
  readonly roundTrip: boolean;
  /**
   * The Store Key the round trip went through, or `null` when it did not
   * happen. Reported rather than left implicit because the Namespace in it is
   * what keeps the probe out of the Namespaces that hold real objects, and an
   * unreported key is one nothing can hold to that.
   */
  readonly key: string | null;
  /** Wall time of the round trip, milliseconds. */
  readonly ms: number | null;
  /** Why the round trip did not happen, or `null` when it did. */
  readonly reason: string | null;
};

export type StoreHealth = {
  readonly private: StoreReach;
  readonly public: StoreReach;
};

/**
 * A 1×1 PNG, 70 bytes. It is a real image because the extension map is closed
 * and refuses anything that is not one, and it is fixed because the Store Key
 * is the hash of its own bytes: the first probe writes it, and every probe
 * after that finds it and writes nothing. So the two stores hold exactly one
 * probe object each, no matter how often `/health` is called, and no delete is
 * needed — which also keeps this off Blob's up-to-60-second delete window.
 */
const PROBE_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

const PROBE_CONTENT_TYPE = "image/png";

/**
 * A probe must not be able to hold `/health` open. 2 s, the same bound the
 * `models` probe uses, against a round trip measured at 242 ms warm and 457 ms
 * cold on the preview deployment.
 */
const PROBE_TIMEOUT_MS = 2000;

/**
 * The Namespace each store is probed through, so the key picks the store and
 * this function never chooses.
 *
 * A Namespace maps to exactly one store, so the two probes cannot share one.
 * `health` is the Private Store's and `health-public` the Public Store's, and
 * each holds its probe object and nothing else. Probing through `sources` and
 * `renders` instead would put a 1×1 PNG in a deletion proof and in the Gallery.
 */
const PROBE_NAMESPACE = {
  private: "health",
  public: "health-public",
} as const satisfies Record<Access, Namespace>;

export async function reachStores(
  env: NodeJS.ProcessEnv = process.env
): Promise<StoreHealth> {
  const [privateReach, publicReach] = await Promise.all([
    probe(env, "private"),
    probe(env, "public"),
  ]);
  return { private: privateReach, public: publicReach };
}

async function probe(
  env: NodeJS.ProcessEnv,
  access: Access
): Promise<StoreReach> {
  const storeId = storeIdFor(env, access);
  const credential = credentialSourceFor(env, access);
  if (storeId === null) {
    return {
      configured: false,
      storeId: null,
      credential: null,
      roundTrip: false,
      key: null,
      ms: null,
      reason: "the store id is not set",
    };
  }

  const started = performance.now();
  try {
    const store = blobStore({
      env,
      abortSignal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const { key } = await store.put(
      PROBE_NAMESPACE[access],
      PROBE_BYTES,
      PROBE_CONTENT_TYPE
    );
    const readBack = await store.get(key);
    const roundTrip = readBack !== null && equalBytes(readBack, PROBE_BYTES);
    return {
      configured: true,
      storeId,
      credential,
      roundTrip,
      key,
      ms: elapsed(started),
      reason: reasonFor(readBack),
    };
  } catch (error) {
    return {
      configured: true,
      storeId,
      credential,
      roundTrip: false,
      key: null,
      ms: elapsed(started),
      reason: publicMessage(error),
    };
  }
}

function elapsed(started: number): number {
  return Math.round(performance.now() - started);
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.byteLength === b.byteLength && a.every((byte, i) => byte === b[i]);
}

function reasonFor(readBack: Uint8Array | null): string | null {
  if (readBack === null) return "the key just written reads back as missing";
  return equalBytes(readBack, PROBE_BYTES)
    ? null
    : "the bytes read back are not the bytes written";
}

/**
 * Capped, because this string is served on a public endpoint. meco's own
 * messages name variables and never their values; the SDK's are fixed strings.
 */
function publicMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 200);
}
