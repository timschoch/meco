/**
 * The in-memory adapter under the one conformance suite both adapters run.
 * `blobStore()` runs the identical list in `conformance.live.ts`, out of the
 * gate; a difference between the two adapters is caught here rather than
 * discovered in production.
 */
import { describe, expect, it } from "vitest";
import { memoryStore } from "../index";
import { storeConformance } from "../conformance";

/** Private, so the suite exercises the Namespace that matters most. */
const PREFIX = "people/laica/p_conformance";

/**
 * The rows of `docs/specs/store.md`, "Testing decisions", in the order they
 * run: #124 and #125's, then the URL rows #126 added.
 *
 * The deletion check is named without a deadline here because `memoryStore` is
 * immediately consistent and so reads once. The live Blob run names its own
 * deadline; that difference is the point, and `conformance.live.ts` asserts it
 * from the other side.
 */
const CHECK_NAMES = [
  "put files the bytes under their own full sha256",
  "get hands back the identical bytes",
  "writing the same bytes twice writes once and reports deduped",
  "writing different bytes under one prefix gives different keys",
  "the store owns its bytes, in and out",
  "get of a key never written is null, not a throw",
  "head of a missing key is null and of a present key reports the stored size",
  "after delete, get is null and list no longer names the key",
  "deleting a key that is already gone is not an error",
  "list names every key under the prefix with its size, however many pages that takes",
  "list names a subtree, so a prefix never matches half a segment",
  "list hands its objects back ordered by key",
  "a key with `..`, an empty segment or a leading slash is refused",
  "bytes over MAX_OBJECT_BYTES are refused, with the size in the message",
  "an unmapped content type is refused rather than guessed",
  "isPrivate matches the whole Namespace, case-insensitively",
  "isPrivate sends health to the Private Store and health-public to the Public Store",
  "publicUrl names a public key under the store's own base URL",
  "publicUrl refuses a private key, naming it",
  "signedUrl refuses a public key",
  "signedUrl refuses longer than 300 seconds, and refuses a lifetime that is no lifetime",
  "signedUrl names the private key it was minted for and carries what makes it expire",
];

// The way an adapter author consumes the checks: one `it` per returned Check.
describe("storeConformance over memoryStore", () => {
  for (const check of storeConformance(memoryStore(), { prefix: PREFIX })) {
    it(check.name, check.run);
  }
});

describe("storeConformance", () => {
  const checks = storeConformance(memoryStore(), { prefix: PREFIX });

  it("returns the checks of the spec, in that order", () => {
    expect(checks.map((c) => c.name)).toEqual(CHECK_NAMES);
  });

  it("names every check once", () => {
    expect(new Set(checks.map((c) => c.name)).size).toBe(checks.length);
  });

  it("reports every Store Key it wrote, so a live run can clean up", async () => {
    const wrote: string[] = [];
    for (const check of storeConformance(memoryStore(), {
      prefix: PREFIX,
      wrote: (key) => wrote.push(key),
    })) {
      // Whether a check passes is the suite above's question. This one asks
      // only what the checks wrote, so a mutation red there stays one red.
      await check.run().catch(() => undefined);
    }

    expect(wrote.length).toBeGreaterThan(0);
    // `${PREFIX}-sibling/` is the one deliberate write outside the prefix: the
    // subtree check needs an object a raw string match would wrongly name. It
    // is still under the run-scoped prefix, so a live run cleans it up too.
    for (const key of wrote) {
      expect(
        key.startsWith(`${PREFIX}/`) || key.startsWith(`${PREFIX}-sibling/`)
      ).toBe(true);
    }
  });
});

describe("memoryStore", () => {
  // Byte ownership is a promise of the interface, so it is a Conformance Check
  // both adapters run, not a test only this one has.

  it("starts empty, so two stores never share an object", async () => {
    const first = memoryStore();
    const { key } = await first.put(
      PREFIX,
      new Uint8Array([1, 2, 3]),
      "image/png"
    );

    await expect(memoryStore().get(key)).resolves.toBeNull();
  });
});
