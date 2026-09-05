/**
 * The live seam: the real Vercel Blob stores in `fra1`, unmocked. Out of the
 * gate, under `pnpm test:store:live`. A fake `@vercel/blob` would prove only
 * that the fake agrees with itself, and the facts worth having here — that a
 * write reaches `fra1` and comes back identical, that a key never written
 * reads as `null` — are properties of the backend.
 *
 * Nothing is cleaned up and nothing accumulates: the probe payload is fixed
 * and its Store Key is the hash of its own bytes, so every run after the first
 * finds the object already there.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { blobStore } from "../index";
import { reachStores } from "../health";

/**
 * The bytes and the expected hash are the test's own, computed here rather than
 * imported, so the assertion cannot agree with the code by construction. They
 * are deliberately the same bytes `/health` probes with, so the live suite adds
 * no second object to either store.
 */
const PROBE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

const SHA256 = createHash("sha256").update(PROBE).digest("hex");

describe("a byte round trip through the live Private Store", () => {
  it("files the bytes under their own full sha256 and hands them back identical", async () => {
    const store = blobStore();

    const written = await store.put("health", PROBE, "image/png");

    expect(written.hash).toBe(SHA256);
    expect(written.key).toBe(`health/${SHA256}.png`);
    expect(written.key).toMatch(/\/[0-9a-f]{64}\.png$/);

    const readBack = await store.get(written.key);

    expect(readBack).not.toBeNull();
    expect(Buffer.from(readBack!).equals(PROBE)).toBe(true);
  });

  it("writes nothing the second time, because the key is the hash", async () => {
    const store = blobStore();

    await store.put("health", PROBE, "image/png");
    const again = await store.put("health", PROBE, "image/png");

    expect(again.deduped).toBe(true);
    expect(again.size).toBe(PROBE.byteLength);
  });

  it("reads a key that was never written as null, not as a throw", async () => {
    const missing = `health/${"0".repeat(64)}.png`;

    await expect(blobStore().get(missing)).resolves.toBeNull();
  });
});

describe("reachStores against the live stores", () => {
  it("round-trips both stores and names the rung that carried it", async () => {
    const health = await reachStores();

    expect(health.private).toMatchObject({ configured: true, roundTrip: true });
    expect(health.public).toMatchObject({ configured: true, roundTrip: true });
    expect(health.private.credential).toMatch(/^(oidc|token)$/);
    expect(health.private.storeId).toMatch(/^store_/);
  });
});
