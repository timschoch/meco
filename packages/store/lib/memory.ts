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
import { assertKey, storeKey } from "./keys";

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
      const under = `${prefix}/`;
      const listed: Listing[] = [];
      for (const [key, held] of objects) {
        if (!key.startsWith(under)) continue;
        listed.push({
          key,
          size: held.bytes.byteLength,
          createdAt: held.createdAt,
        });
      }
      // Sorted, because a `Map` hands its entries back in insertion order and
      // the Blob adapter hands them back by key. The order is part of the
      // interface or the two adapters differ in what a caller may rely on.
      return listed.sort((a, b) =>
        a.key < b.key ? -1 : a.key > b.key ? 1 : 0
      );
    },
  };
}
