/**
 * The in-memory adapter: the same `Store` promises with nothing behind them
 * but a `Map`, so a test never reaches `fra1` and a developer with no network
 * still runs the whole gate.
 *
 * It shares `lib/keys` with the Blob adapter, so every refusal — the key
 * shape, the size limit, the closed extension map — is the same code in both
 * adapters rather than the same rule written twice.
 */
import type { Listing, Store } from "./blob";
import { assertKey, byKey, storeKey, subtreePrefix } from "./keys";
import { assertPrivateKey, assertPublicKey, validUntilFor } from "./urls";

/**
 * The in-memory store's own two hosts, one per access, so `publicUrl` is the
 * same arithmetic here as on Blob and the Conformance Checks are one list.
 *
 * `.invalid` is reserved by RFC 2606 and can never resolve, which is the point:
 * an in-memory URL must not be mistakable for one that serves bytes. So this
 * adapter proves the shape of a URL and every refusal around it, and whether a
 * backend honours a signature or an expiry is proved against the live stores,
 * where it is a property of the backend rather than of this `Map`.
 */
const BASE = {
  public: "https://public.memory.store.invalid",
  private: "https://private.memory.store.invalid",
} as const;

/** What one key holds. The bytes are the store's own copy, never the caller's. */
type Held = {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly createdAt: string;
};

export function memoryStore(): Store {
  const objects = new Map<string, Held>();

  return {
    async put(prefix, bytes, contentType) {
      const { key, hash } = storeKey(prefix, bytes, contentType);

      const existing = objects.get(key);
      if (existing !== undefined) {
        return {
          key,
          hash,
          size: existing.bytes.byteLength,
          contentType: existing.contentType,
          deduped: true,
        };
      }

      // Copied in, so a caller that reuses its buffer cannot rewrite what it
      // already stored. A backend copies by sending; this one has to say so.
      objects.set(key, {
        bytes: Uint8Array.from(bytes),
        contentType,
        createdAt: new Date().toISOString(),
      });
      return { key, hash, size: bytes.byteLength, contentType, deduped: false };
    },

    async get(key) {
      assertKey(key);
      const found = objects.get(key);
      // Copied out for the same reason: a reader holding the stored array
      // could otherwise edit the store by writing into what it was handed.
      return found === undefined ? null : Uint8Array.from(found.bytes);
    },

    async head(key) {
      assertKey(key);
      const found = objects.get(key);
      if (found === undefined) return null;
      return {
        key,
        size: found.bytes.byteLength,
        contentType: found.contentType,
      };
    },

    async delete(key) {
      assertKey(key);
      // `Map.delete` on a key that is not there is already a no-op, which is
      // the promise the interface makes.
      objects.delete(key);
    },

    async list(prefix) {
      assertKey(prefix, "prefix");
      const under = subtreePrefix(prefix);
      const listed: Listing[] = [];
      for (const [key, held] of objects) {
        if (!key.startsWith(under)) continue;
        listed.push({
          key,
          size: held.bytes.byteLength,
          createdAt: held.createdAt,
        });
      }
      return listed.sort(byKey);
    },

    publicUrl(key) {
      assertKey(key);
      assertPublicKey(key);
      return `${BASE.public}/${key}`;
    },

    async signedUrl(key, options) {
      assertKey(key);
      assertPrivateKey(key);
      // The expiry is in the URL rather than beside it, as Blob's is: what
      // makes a Signed URL stop working travels with it.
      return `${BASE.private}/${key}?validUntil=${validUntilFor(options?.expiresInSeconds)}`;
    },
  };
}
