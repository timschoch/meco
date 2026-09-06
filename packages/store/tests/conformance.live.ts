/**
 * The same conformance list as `memory.test.ts`, against the live Private Store
 * in `fra1`. Out of the gate, under `pnpm test:store:live`, because these are
 * properties of the backend and a fake `@vercel/blob` would prove only that the
 * fake agrees with itself.
 *
 * Everything it writes lands under one run-scoped prefix and is deleted in
 * `afterAll`, which runs whether the checks passed or not. Deletion goes
 * straight to the SDK rather than through the `Store` interface because
 * `delete` is #125's; when it lands, this becomes `store.delete`.
 */
import { randomUUID } from "node:crypto";
import { del } from "@vercel/blob";
import { afterAll, describe, expect, it } from "vitest";
import { blobStore } from "../index";
import { reachStores } from "../health";
import { storeConformance } from "../conformance";

/**
 * Run-scoped, so two runs at once never share a Store Key: the keys under it
 * are the hashes of the payloads, and the payloads are the same every run.
 * `people/…` is the Private Store, the Namespace whose wall matters most.
 */
const PREFIX = `people/conformance/${randomUUID()}`;

/** Every key the checks wrote, so `afterAll` can name them all. */
const written = new Set<string>();

describe("storeConformance over the live blobStore", () => {
  for (const check of storeConformance(blobStore(), {
    prefix: PREFIX,
    wrote: (key) => written.add(key),
  })) {
    it(check.name, check.run);
  }
});

describe("where the two probes write", () => {
  it("keeps each probe in its own Namespace, out of the ones holding real objects", async () => {
    const health = await reachStores();

    // The key the probe round-tripped, not the key this test hoped for: an
    // assertion that the object exists would pass on a probe that wrote
    // somewhere else, because a former probe already left one behind.
    expect(health.public.key).toMatch(/^health-public\/[0-9a-f]{64}\.png$/);
    expect(health.private.key).toMatch(/^health\/[0-9a-f]{64}\.png$/);
  });
});

afterAll(async () => {
  if (written.size === 0) return;

  // The Private Store's own token. `del` is store-scoped by its credential, and
  // every key here is private by its Namespace.
  const token = process.env["BLOB_PEOPLE_READ_WRITE_TOKEN"];
  if (token === undefined) {
    throw new Error(
      `BLOB_PEOPLE_READ_WRITE_TOKEN is not set, so ${written.size} objects under ${PREFIX} cannot be cleaned up.`
    );
  }
  await del([...written], { token });
});
