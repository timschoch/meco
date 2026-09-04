/**
 * Where Renders and Crops are kept.
 *
 * Both are stored outputs with a stable URL, and both are content-addressed:
 * the same bytes always land at the same key, so a caller that retries pays
 * nothing and gets the same URL back. See CONTEXT.md.
 *
 * Not everything meco stores is an output. A Person record and its Reference
 * Photos are records: they are addressed by a key the caller chose, they are
 * overwritten in place, and they are deleted when the Person is. That is what
 * `putAt`, `get` and `delete` are for. Because a Reference Photo is a face
 * photo of a named individual, everything under `PRIVATE_PREFIX` is stored so
 * that its URL alone does not hand the bytes to whoever asks.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, posix, relative, resolve, sep } from "node:path";

/**
 * People live here. A Reference Photo is personal data, so this prefix is
 * private in the store and the Gallery never lists it. See
 * `docs/plans/faces-and-subject-aware-crop.md`.
 */
export const PRIVATE_PREFIX = "people";

/**
 * True for a key whose bytes must not be readable from its URL alone.
 *
 * Case-insensitive, because this one string comparison is what stands between
 * a face photo and an open URL: a key spelled `People/…` must not slip into
 * the public store on a capital letter.
 */
export function isPrivateKey(key: string): boolean {
  const lower = key.toLowerCase();
  return lower === PRIVATE_PREFIX || lower.startsWith(`${PRIVATE_PREFIX}/`);
}

export interface StoredObject {
  /** Content-addressed key, e.g. `renders/laica/3f2a…c1.png`. */
  key: string;
  url: string;
  bytes: number;
  contentType: string;
}

/** One stored output as the listing sees it — no content type, a timestamp. */
export interface StoredListing {
  key: string;
  url: string;
  bytes: number;
  /** ISO 8601. When the object was written. */
  createdAt: string;
}

export interface Storage {
  readonly kind: "local" | "vercel-blob";
  put(
    prefix: string,
    data: Buffer,
    contentType: string,
    extension: string,
  ): Promise<StoredObject>;
  /**
   * Write `data` at exactly `key`, replacing anything already there. For
   * records, where the caller owns the name and the newest version wins.
   */
  putAt(key: string, data: Buffer, contentType: string): Promise<StoredObject>;
  /**
   * The bytes at `key`, or null when nothing is stored there. Bytes only: a
   * content type is what the two backends cannot agree on, because local disk
   * keeps no headers and would have to guess one back off the extension.
   */
  get(key: string): Promise<Buffer | null>;
  /** Remove `key`. A key that is not there is already gone, not an error. */
  delete(key: string): Promise<void>;
  /** Every stored object whose key starts with `prefix`, newest first. */
  list(prefix: string): Promise<StoredListing[]>;
}

export function contentKey(
  prefix: string,
  data: Buffer,
  extension: string,
): string {
  const digest = createHash("sha256").update(data).digest("hex").slice(0, 32);
  return `${prefix}/${digest}.${extension}`;
}

/**
 * A key is a POSIX path inside the store, and it has to stay inside it. Keys
 * used to come only from `contentKey`; now a caller names them, and on the
 * local backend a key is a filesystem path, so `..` would reach out of `out/`.
 */
function assertKey(key: string): string {
  const segments = key.split("/");
  const escapes =
    key.length === 0 ||
    key.startsWith("/") ||
    segments.some((s) => s === "" || s === "." || s === "..");
  if (escapes) throw new Error(`Not a valid storage key: "${key}"`);
  return key;
}

/** Writes under `out/`, and serves URLs from the local dev server. */
export class LocalStorage implements Storage {
  readonly kind = "local" as const;

  constructor(
    private readonly root = resolve(process.cwd(), "out"),
    // Must track the port the server actually bound to, or the URLs handed back
    // point somewhere that is not listening — which is what happens in a
    // container, where PORT is 80 rather than the dev default.
    private readonly baseUrl = process.env.MECO_BASE_URL ??
      `http://127.0.0.1:${process.env.PORT ?? 8787}`,
  ) {}

  async put(
    prefix: string,
    data: Buffer,
    contentType: string,
    extension: string,
  ): Promise<StoredObject> {
    return this.putAt(contentKey(prefix, data, extension), data, contentType);
  }

  async putAt(
    key: string,
    data: Buffer,
    contentType: string,
  ): Promise<StoredObject> {
    const file = this.file(key);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, data);
    // The URL of a private object still names it, but nothing serves it: the
    // dev server in `src/server.ts` mounts only the three public kinds.
    return {
      key,
      url: `${this.baseUrl}/${key}`,
      bytes: data.length,
      contentType,
    };
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.file(key));
    } catch (err) {
      // Nothing there is a miss, not a failure: callers ask before they know
      // whether anything is stored. A key that names a directory is the same
      // answer — Blob has no directories, and the two must agree. Anything
      // else is a real fault and belongs to the caller.
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "EISDIR") return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.file(key), { force: true });
  }

  async list(prefix: string): Promise<StoredListing[]> {
    const dir = join(this.root, assertKey(prefix));
    const items: StoredListing[] = [];
    // A prefix that was never written to is not an error here: it just means
    // nothing of that kind has been stored yet.
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true, recursive: true });
    } catch {
      return items;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const file = join(entry.parentPath, entry.name);
      const info = await stat(file);
      const key = posix.join(prefix, relativeKey(dir, file));
      items.push({
        key,
        url: `${this.baseUrl}/${key}`,
        bytes: info.size,
        createdAt: new Date(info.mtimeMs).toISOString(),
      });
    }
    return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  private file(key: string): string {
    return join(this.root, assertKey(key));
  }
}

/** A key is always POSIX, whatever separator the local filesystem uses. */
function relativeKey(dir: string, file: string): string {
  return relative(dir, file).split(sep).join("/");
}

/** Vercel Blob, for when meco runs on Vercel. */
export class BlobStorage implements Storage {
  readonly kind = "vercel-blob" as const;

  private readonly token: string;
  /**
   * A second store, created with `--access private`. Vercel Blob decides
   * public or private per *store*, not per object: a private write to the
   * public store is refused outright. So People need a store of their own, and
   * the only difference between the two stores is which token addresses them.
   */
  private readonly privateToken: string | undefined;

  constructor(
    token = process.env.BLOB_READ_WRITE_TOKEN,
    privateToken = process.env.BLOB_PEOPLE_READ_WRITE_TOKEN,
  ) {
    if (!token) {
      throw new Error(
        "BLOB_READ_WRITE_TOKEN is not set — cannot use Vercel Blob storage.",
      );
    }
    this.token = token;
    this.privateToken = privateToken;
  }

  /**
   * Which store a key belongs to. Missing configuration is an error and never
   * a fallback: writing a Reference Photo to the public store would put a face
   * photo of a named person on an open URL, which is the whole point of this.
   */
  private tokenFor(key: string): string {
    if (!isPrivateKey(key)) return this.token;
    if (!this.privateToken) {
      throw new Error(
        `BLOB_PEOPLE_READ_WRITE_TOKEN is not set — "${key}" is private and ` +
          "there is no private store to put it in. See DEPLOY.md.",
      );
    }
    return this.privateToken;
  }

  async put(
    prefix: string,
    data: Buffer,
    contentType: string,
    extension: string,
  ): Promise<StoredObject> {
    return this.putAt(contentKey(prefix, data, extension), data, contentType);
  }

  async putAt(
    key: string,
    data: Buffer,
    contentType: string,
  ): Promise<StoredObject> {
    const { put } = await import("@vercel/blob");
    const result = await put(assertKey(key), data, {
      access: accessFor(key),
      contentType,
      token: this.tokenFor(key),
      addRandomSuffix: false,
      // A content-addressed retry writes the same bytes to the same key, and a
      // record is written at its key again every time it changes. Neither may
      // fail on "already exists" or leave a second object behind.
      allowOverwrite: true,
    });
    return { key, url: result.url, bytes: data.length, contentType };
  }

  async get(key: string): Promise<Buffer | null> {
    const { get } = await import("@vercel/blob");
    const result = await get(assertKey(key), {
      access: accessFor(key),
      token: this.tokenFor(key),
      // Reads go to origin. The CDN copy of a key that was just overwritten
      // can still be the old bytes, and a record must read back what was last
      // written to it.
      useCache: false,
    });
    // Null is the miss. Anything else that goes wrong — a wrong token, no
    // store — must not be dressed up as "nothing stored there".
    if (!result) return null;
    if (result.statusCode !== 200) {
      throw new Error(`Unexpected ${String(result.statusCode)} reading "${key}"`);
    }
    return Buffer.from(await new Response(result.stream).arrayBuffer());
  }

  async delete(key: string): Promise<void> {
    const { del } = await import("@vercel/blob");
    await del(assertKey(key), { token: this.tokenFor(key) });
  }

  async list(prefix: string): Promise<StoredListing[]> {
    const { list } = await import("@vercel/blob");
    const items: StoredListing[] = [];
    let cursor: string | undefined;
    // Blob pages at 1000; a gallery that stops at the first page would quietly
    // hide everything older.
    do {
      const page = await list({
        prefix: `${assertKey(prefix)}/`,
        token: this.tokenFor(prefix),
        limit: 1000,
        ...(cursor ? { cursor } : {}),
      });
      for (const blob of page.blobs) {
        items.push({
          key: blob.pathname,
          url: blob.url,
          bytes: blob.size,
          createdAt: new Date(blob.uploadedAt).toISOString(),
        });
      }
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}

/**
 * Access is a property of the key, not of the call site, so every read and
 * write of a People key agrees on `private` without any caller having to
 * remember. Vercel Blob wants it on the call as well as on the store, and
 * refuses the pair when they disagree.
 */
function accessFor(key: string): "public" | "private" {
  return isPrivateKey(key) ? "private" : "public";
}

/**
 * Pick storage from the environment: Blob when a token is present (Vercel),
 * local disk otherwise. One file changes to swap the backend.
 */
export function createStorage(): Storage {
  return process.env.BLOB_READ_WRITE_TOKEN ? new BlobStorage() : new LocalStorage();
}
