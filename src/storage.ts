/**
 * Where Renders and Crops are kept.
 *
 * Both are stored outputs with a stable URL, and both are content-addressed:
 * the same bytes always land at the same key, so a caller that retries pays
 * nothing and gets the same URL back. See CONTEXT.md.
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export interface StoredObject {
  /** Content-addressed key, e.g. `renders/3f2a…c1.png`. */
  key: string;
  url: string;
  bytes: number;
  contentType: string;
}

export interface Storage {
  readonly kind: "local" | "vercel-blob";
  put(
    prefix: string,
    data: Buffer,
    contentType: string,
    extension: string,
  ): Promise<StoredObject>;
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
    private readonly baseUrl = process.env.MECO_BASE_URL ?? "http://127.0.0.1:8787",
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
}

/**
 * Pick storage from the environment: Blob when a token is present (Vercel),
 * local disk otherwise. One file changes to swap the backend.
 */
export function createStorage(): Storage {
  return process.env.BLOB_READ_WRITE_TOKEN ? new BlobStorage() : new LocalStorage();
}
