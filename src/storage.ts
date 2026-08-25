/**
 * Where Renders and Crops are kept.
 *
 * Both are stored outputs with a stable URL, and both are content-addressed:
 * the same bytes always land at the same key, so a caller that retries pays
 * nothing and gets the same URL back. See CONTEXT.md.
 */
import { createHash } from "node:crypto";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, posix, relative, resolve, sep } from "node:path";

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
    const key = contentKey(prefix, data, extension);
    const file = join(this.root, key);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, data);
    return {
      key,
      url: `${this.baseUrl}/${key}`,
      bytes: data.length,
      contentType,
    };
  }

  async list(prefix: string): Promise<StoredListing[]> {
    const dir = join(this.root, prefix);
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
}

/** A key is always POSIX, whatever separator the local filesystem uses. */
function relativeKey(dir: string, file: string): string {
  return relative(dir, file).split(sep).join("/");
}

/** Vercel Blob, for when meco runs on Vercel. */
export class BlobStorage implements Storage {
  readonly kind = "vercel-blob" as const;

  constructor(private readonly token = process.env.BLOB_READ_WRITE_TOKEN) {
    if (!this.token) {
      throw new Error(
        "BLOB_READ_WRITE_TOKEN is not set — cannot use Vercel Blob storage.",
      );
    }
  }

  async put(
    prefix: string,
    data: Buffer,
    contentType: string,
    extension: string,
  ): Promise<StoredObject> {
    const { put } = await import("@vercel/blob");
    const key = contentKey(prefix, data, extension);
    const result = await put(key, data, {
      access: "public",
      contentType,
      token: this.token,
      addRandomSuffix: false,
      // Same bytes, same key: a retry must not create a second object.
      allowOverwrite: true,
    });
    return { key, url: result.url, bytes: data.length, contentType };
  }

  async list(prefix: string): Promise<StoredListing[]> {
    const { list } = await import("@vercel/blob");
    const items: StoredListing[] = [];
    let cursor: string | undefined;
    // Blob pages at 1000; a gallery that stops at the first page would quietly
    // hide everything older.
    do {
      const page = await list({
        prefix: `${prefix}/`,
        token: this.token,
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
 * Pick storage from the environment: Blob when a token is present (Vercel),
 * local disk otherwise. One file changes to swap the backend.
 */
export function createStorage(): Storage {
  return process.env.BLOB_READ_WRITE_TOKEN ? new BlobStorage() : new LocalStorage();
}
