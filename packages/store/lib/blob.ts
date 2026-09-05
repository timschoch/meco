/**
 * The Vercel Blob adapter. Two stores in `fra1` behind one interface, with the
 * Namespace of the key — never the caller — choosing between them.
 */
import {
  BlobNotFoundError,
  get as blobGet,
  head as blobHead,
  put as blobPut,
} from "@vercel/blob";
import { type Access, credentialFor } from "./credentials";
import { assertKey, isPrivate, storeKey } from "./keys";

/** The bytes at one Store Key, with what is known about them. */
export interface StoredObject {
  readonly key: string;
  readonly size: number;
  readonly contentType: string;
}

export interface PutResult extends StoredObject {
  /** The Content Hash of the bytes, and the last segment of the key. */
  readonly hash: string;
  /** True when these bytes were already there, so nothing was written. */
  readonly deduped: boolean;
}

/** Bytes filed under a Store Key, handed back on request. */
export interface Store {
  /**
   * Hash the bytes, append `<sha256>.<ext>` to the prefix, and write only if
   * that key is not already there.
   */
  put(
    prefix: string,
    bytes: Uint8Array,
    contentType: string
  ): Promise<PutResult>;
  /** The bytes at this key, or `null` when nothing was ever written there. */
  get(key: string): Promise<Uint8Array | null>;
}

export interface BlobStoreConfig {
  /** Where the store ids and credentials are read from. */
  readonly env?: NodeJS.ProcessEnv;
  /** Bounds every call the returned store makes. */
  readonly abortSignal?: AbortSignal;
}

export function blobStore(config: BlobStoreConfig = {}): Store {
  const env = config.env ?? process.env;
  const { abortSignal } = config;

  const options = (access: Access) => {
    const { auth } = credentialFor(env, access);
    return { access, ...auth, ...(abortSignal ? { abortSignal } : {}) };
  };

  return {
    async put(prefix, bytes, contentType) {
      const { key, hash } = storeKey(prefix, bytes, contentType);
      const access = isPrivate(key) ? "private" : "public";
      const common = options(access);

      const existing = await head(key, common);
      if (existing !== null) {
        return {
          key,
          hash,
          size: existing.size,
          contentType: existing.contentType,
          deduped: true,
        };
      }

      // A zero-copy view, not a copy: the SDK's body type excludes a bare
      // `Uint8Array`, and an image may be up to MAX_OBJECT_BYTES.
      const body = Buffer.from(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength
      );
      const written = await blobPut(key, body, {
        ...common,
        contentType,
        addRandomSuffix: false,
      });
      return {
        key,
        hash,
        size: bytes.byteLength,
        contentType: written.contentType,
        deduped: false,
      };
    },

    async get(key) {
      assertKey(key);
      const access = isPrivate(key) ? "private" : "public";
      // `useCache: false` because the only reads through this interface happen
      // inside the deployment: public bytes are served to browsers by the CDN
      // and never pass through a container. A cached miss right after a write
      // would be a lie the backend never told.
      const found = await blobGet(key, { ...options(access), useCache: false });
      if (found === null || found.statusCode !== 200) return null;
      return new Uint8Array(await new Response(found.stream).arrayBuffer());
    },
  };
}

/** `head` throws for a key that is not there; a missing key is not an error. */
async function head(
  key: string,
  options: Parameters<typeof blobHead>[1]
): Promise<{ size: number; contentType: string } | null> {
  try {
    const found = await blobHead(key, options);
    return { size: found.size, contentType: found.contentType };
  } catch (error) {
    if (error instanceof BlobNotFoundError) return null;
    throw error;
  }
}
