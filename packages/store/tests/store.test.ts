import { describe, expect, it } from "vitest";
import {
  blobStore,
  isPrivate,
  MAX_OBJECT_BYTES,
  MAX_SIGNED_URL_SECONDS,
  NAMESPACES,
} from "../index";

/** Both stores configured, so a refusal below is never a missing-id refusal. */
const configured = () =>
  blobStore({
    env: {
      BLOB_PUBLIC_STORE_ID: "store_public",
      BLOB_PRIVATE_STORE_ID: "store_private",
      BLOB_READ_WRITE_TOKEN: "rw-public",
      BLOB_PEOPLE_READ_WRITE_TOKEN: "rw-private",
    },
  });

const ONE_PIXEL = new Uint8Array([1, 2, 3]);

describe("isPrivate", () => {
  it("sends the three private Namespaces to the Private Store", () => {
    expect(isPrivate("sources/abc.jpg")).toBe(true);
    expect(isPrivate("people/laica/p_1/abc.jpg")).toBe(true);
    expect(isPrivate("health/abc.png")).toBe(true);
  });

  it("sends the three public Namespaces to the Public Store", () => {
    expect(isPrivate("renders/abc.jpg")).toBe(false);
    expect(isPrivate("crops/abc.jpg")).toBe(false);
    expect(isPrivate("health-public/abc.png")).toBe(false);
  });

  it("compares the Namespace case-insensitively", () => {
    expect(isPrivate("People/laica/p_1/abc.jpg")).toBe(true);
    expect(isPrivate("SOURCES/abc.jpg")).toBe(true);
  });

  it("matches the whole Namespace, not a prefix of it", () => {
    expect(isPrivate("peoples-choice/abc.jpg")).toBe(false);
    expect(isPrivate("sourcesomething/abc.jpg")).toBe(false);
  });

  it("names the six Namespaces", () => {
    expect(NAMESPACES).toEqual([
      "sources",
      "renders",
      "crops",
      "people",
      "health",
      "health-public",
    ]);
  });
});

describe("put refuses before it reaches a backend", () => {
  it("refuses a prefix with a `..` segment", async () => {
    await expect(
      configured().put("sources/../people", ONE_PIXEL, "image/png")
    ).rejects.toThrow(/\.\./);
  });

  it("refuses a prefix with an empty segment", async () => {
    await expect(
      configured().put("people//p_1", ONE_PIXEL, "image/png")
    ).rejects.toThrow(/empty/i);
  });

  it("refuses a leading slash", async () => {
    await expect(
      configured().put("/sources", ONE_PIXEL, "image/png")
    ).rejects.toThrow(/leading/i);
  });

  it("refuses a prefix whose first segment is not a Namespace", async () => {
    await expect(
      configured().put("uploads", ONE_PIXEL, "image/png")
    ).rejects.toThrow(/Namespace/);
  });

  it("refuses an unmapped content type rather than guessing an extension", async () => {
    await expect(
      configured().put("sources", ONE_PIXEL, "text/plain")
    ).rejects.toThrow(/text\/plain/);
  });

  it("refuses bytes over MAX_OBJECT_BYTES, with the actual size in the message", async () => {
    const tooBig = new Uint8Array(MAX_OBJECT_BYTES + 1);
    await expect(
      configured().put("sources", tooBig, "image/png")
    ).rejects.toThrow(String(MAX_OBJECT_BYTES + 1));
  });
});

describe("get refuses before it reaches a backend", () => {
  it("refuses a key that climbs out of its Namespace", async () => {
    await expect(configured().get("people/../renders/a.png")).rejects.toThrow(
      /\.\./
    );
  });
});

describe("a private write with no Private Store configured", () => {
  const noPrivate = () =>
    blobStore({
      env: {
        BLOB_PUBLIC_STORE_ID: "store_public",
        BLOB_READ_WRITE_TOKEN: "rw-public",
      },
    });

  it("throws naming the variable, and never falls back to the Public Store", async () => {
    await expect(
      noPrivate().put("people/laica/p_1", ONE_PIXEL, "image/png")
    ).rejects.toThrow("BLOB_PRIVATE_STORE_ID");
  });

  it("refuses a private read the same way", async () => {
    await expect(noPrivate().get("sources/a.png")).rejects.toThrow(
      "BLOB_PRIVATE_STORE_ID"
    );
  });
});

describe("publicUrl", () => {
  /** The two live `fra1` store ids, so the arithmetic is proved on real shapes. */
  const live = () =>
    blobStore({
      env: {
        BLOB_PUBLIC_STORE_ID: "store_g8k1dqE6AcEmXk6K",
        BLOB_PRIVATE_STORE_ID: "store_rNFO9fh833veVEUi",
        BLOB_READ_WRITE_TOKEN: "rw-public",
        BLOB_PEOPLE_READ_WRITE_TOKEN: "rw-private",
      },
    });

  it("is the store id lowercased without its prefix, then the key verbatim", () => {
    const key = `crops/${"a".repeat(64)}.png`;

    expect(live().publicUrl(key)).toBe(
      `https://g8k1dqe6acemxk6k.public.blob.vercel-storage.com/${key}`
    );
  });

  it("refuses a key whose first segment is no Namespace, before computing a URL", () => {
    expect(() => live().publicUrl("uploads/a.png")).toThrow(/Namespace/);
  });

  it("throws naming BLOB_PUBLIC_STORE_ID when the Public Store has no address", () => {
    const noPublic = blobStore({
      env: {
        BLOB_PRIVATE_STORE_ID: "store_private",
        BLOB_PEOPLE_READ_WRITE_TOKEN: "rw-private",
      },
    });

    expect(() => noPublic.publicUrl("crops/a.png")).toThrow(
      "BLOB_PUBLIC_STORE_ID"
    );
  });
});

describe("signedUrl refuses before it reaches a backend", () => {
  it("refuses a lifetime over MAX_SIGNED_URL_SECONDS without asking the store", async () => {
    await expect(
      configured().signedUrl("people/laica/p_1/a.jpg", {
        expiresInSeconds: MAX_SIGNED_URL_SECONDS + 1,
      })
    ).rejects.toThrow(String(MAX_SIGNED_URL_SECONDS));
  });

  it("throws naming BLOB_PRIVATE_STORE_ID when the Private Store has no address", async () => {
    const noPrivate = blobStore({
      env: {
        BLOB_PUBLIC_STORE_ID: "store_public",
        BLOB_READ_WRITE_TOKEN: "rw-public",
      },
    });

    await expect(noPrivate.signedUrl("people/laica/p_1/a.jpg")).rejects.toThrow(
      "BLOB_PRIVATE_STORE_ID"
    );
  });
});
