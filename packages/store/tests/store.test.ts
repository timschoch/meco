import { describe, expect, it } from "vitest";
import { blobStore, isPrivate, MAX_OBJECT_BYTES, NAMESPACES } from "../index";

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
