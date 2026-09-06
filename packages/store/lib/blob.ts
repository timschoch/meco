/**
 * The Vercel Blob adapter. Two stores in `fra1` behind one interface, with the
 * Namespace of the key — never the caller — choosing between them.
 */
import {
  BlobNotFoundError,
  del as blobDel,
  get as blobGet,
  head as blobHead,
  issueSignedToken,
  list as blobList,
  presignUrl,
  put as blobPut,
} from "@vercel/blob";
import { credentialFor, requireStoreId } from "./credentials";
import {
  type Access,
  accessFor,
  assertKey,
  byKey,
  storeKey,
  subtreePrefix,
} from "./keys";
import {
  MAX_SIGNED_URL_SECONDS,
  assertPrivateKey,
  assertPublicKey,
  publicUrlFor,
  validUntilFor,
} from "./urls";

/** The bytes at one Store Key, with what is known about them. */
export interface StoredObject {
  readonly key: string;
  readonly size: number;
  readonly contentType: string;
}

/** One Stored Object as `list` names it: enough to prove it is still there. */
export interface Listing {
  readonly key: string;
  readonly size: number;
  /** When the object was written, ISO 8601. */
  readonly createdAt: string;
}

export interface PutResult extends StoredObject {
  /** The Content Hash of the bytes, and the last segment of the key. */
  readonly hash: string;
  /** True when these bytes were already there, so nothing was written. */
  readonly deduped: boolean;
}

/**
 * Bytes filed under a Store Key, handed back on request.
 *
 * A store owns its bytes: what a caller hands to `put` and what `get` hands
 * back are the caller's own arrays, and writing into either changes nothing
 * stored. A backend gets this by sending the bytes over a wire; an adapter
 * that keeps them in the process has to say so, which is why it is a
 * Conformance Check and not a remark.
 */
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
  /**
   * What is known about the object at this key without fetching its bytes, or
   * `null` when nothing was ever written there.
   */
  head(key: string): Promise<StoredObject | null>;
  /**
   * Remove the object at this key. Unconditional: the store does not know
   * whether anything still points at those bytes, and never asks. Two Brands
   * whose Crops come out byte-identical share one key, so reference counting
   * is `records`' question.
   *
   * Deleting a key that is already gone is not an error, so a retry and a
   * cascade that runs twice both cost nothing.
   */
  delete(key: string): Promise<void>;
  /**
   * Every object under this prefix, ordered by key.
   *
   * This exists to prove that a delete left nothing behind, and for nothing
   * else — the Gallery reads `records`. A prefix names a subtree rather than a
   * string, so `list("people/laica/p_1")` never names `people/laica/p_10/…`,
   * the same whole-segment rule `isPrivate` applies to the Namespace.
   */
  list(prefix: string): Promise<Listing[]>;
  /**
   * The address a public object is served at, forever. Arithmetic on the store
   * id and the key, so nothing has to file a URL beside a Store Key and no URL
   * can go stale when a store moves.
   *
   * Throws for a private key: that object has no such address, and handing one
   * back would be a lie a caller could publish.
   */
  publicUrl(key: string): string;
  /**
   * A URL that hands over one private object to whoever holds it, until it
   * expires. Minted for the gateway, which has already decided that this
   * caller may see this object; the store never decides who may read.
   *
   * Throws for a public key, and refuses a lifetime over
   * {@link MAX_SIGNED_URL_SECONDS}.
   */
  signedUrl(
    key: string,
    options?: { readonly expiresInSeconds?: number }
  ): Promise<string>;
}

export interface BlobStoreConfig {
  /**
   * Where the store ids and credentials are read from. Overriding it is for
   * tests that never reach a backend: `@vercel/blob` reads `process.env` for
   * anything the call does not pass, so a substituted env and the credential
   * the SDK actually uses can disagree.
   */
  readonly env?: NodeJS.ProcessEnv;
  /** Bounds every call the returned store makes. */
  readonly abortSignal?: AbortSignal;
  /**
   * How many objects one `list` request asks for. Blob's own maximum, 1000, is
   * the default and the only value production uses.
   *
   * It is settable because the property worth proving is that `list` follows
   * the cursor past the end of a page, and writing 1001 objects to prove it
   * would cost more than the live suite's whole two-minute budget. Lowered to
   * a handful, the same check exercises the same loop in seconds.
   */
  readonly listPageSize?: number;
}

/** Blob returns at most this many objects per `list` request. */
const MAX_LIST_PAGE = 1000;

export function blobStore(config: BlobStoreConfig = {}): Store {
  const env = config.env ?? process.env;
  const { abortSignal, listPageSize = MAX_LIST_PAGE } = config;
  // Refused at construction rather than at the call, so a page size that would
  // quietly shorten every listing can never become a deletion proof that
  // looked at less than it reported.
  if (!Number.isInteger(listPageSize) || listPageSize < 1) {
    throw new Error(
      `@meco/store: listPageSize ${listPageSize} is no page size. An integer from 1 to ${MAX_LIST_PAGE}.`
    );
  }
  if (listPageSize > MAX_LIST_PAGE) {
    throw new Error(
      `@meco/store: listPageSize ${listPageSize} is over Blob's own maximum of ${MAX_LIST_PAGE}, which would silently return fewer.`
    );
  }

  /** How every call reaches one store: its credential, under this store's bound. */
  const reaching = (access: Access) => {
    const { auth } = credentialFor(env, access);
    return { ...auth, ...(abortSignal ? { abortSignal } : {}) };
  };

  /** The same, for the six verbs the SDK also wants an `access` from. */
  const options = (access: Access) => ({ access, ...reaching(access) });

  return {
    async put(prefix, bytes, contentType) {
      const { key, hash } = storeKey(prefix, bytes, contentType);
      const common = options(accessFor(key));

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
      // `useCache: false` because the only reads through this interface happen
      // inside the deployment: public bytes are served to browsers by the CDN
      // and never pass through a container. A cached miss right after a write
      // would be a lie the backend never told.
      const found = await blobGet(key, {
        ...options(accessFor(key)),
        useCache: false,
      });
      if (found === null || found.statusCode !== 200) return null;
      return new Uint8Array(await new Response(found.stream).arrayBuffer());
    },

    async head(key) {
      assertKey(key);
      const found = await head(key, options(accessFor(key)));
      return found === null ? null : { key, ...found };
    },

    async delete(key) {
      assertKey(key);
      // Blob's `del` is already silent about a key that is not there, which is
      // the promise this interface makes; nothing here has to make it so.
      await blobDel(key, options(accessFor(key)));
    },

    async list(prefix) {
      assertKey(prefix, "prefix");
      const under = subtreePrefix(prefix);
      const common = options(accessFor(prefix));

      const listed: Listing[] = [];
      let cursor: string | undefined;
      do {
        const page = await blobList({
          ...common,
          prefix: under,
          limit: listPageSize,
          ...(cursor === undefined ? {} : { cursor }),
        });
        for (const one of page.blobs) {
          listed.push({
            key: one.pathname,
            size: one.size,
            createdAt: one.uploadedAt.toISOString(),
          });
        }
        // Following the cursor rather than stopping at the first page: a
        // listing that stopped there would hide every object past the page
        // size and report a deletion proof that had not looked.
        cursor = page.hasMore ? page.cursor : undefined;
      } while (cursor !== undefined);

      return listed.sort(byKey);
    },

    publicUrl(key) {
      assertKey(key);
      assertPublicKey(key);
      // The store id, not the credential: a token names whichever store it was
      // issued for, and the URL a caller publishes must name the one this
      // deployment is configured to serve from.
      return publicUrlFor(requireStoreId(env, "public"), key);
    },

    async signedUrl(key, options) {
      assertKey(key);
      assertPrivateKey(key);
      const validUntil = validUntilFor(options?.expiresInSeconds);

      // Scoped to this one pathname and to reading it: a delegation wide enough
      // to write or to name another key would outlive its reason twice over.
      const signed = await issueSignedToken({
        ...reaching("private"),
        pathname: key,
        operations: ["get"],
        validUntil,
      });
      // Renamed on the way in: `CONTEXT.md` gives this "Signed URL" and puts
      // "presigned URL" on its avoid-list.
      const { presignedUrl: signedUrl } = await presignUrl(signed, {
        operation: "get",
        pathname: key,
        access: "private",
        validUntil,
      });
      return signedUrl;
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
