/**
 * The same conformance list as `memory.test.ts`, against the live Private Store
 * in `fra1`. Out of the gate, under `pnpm test:store:live`, because these are
 * properties of the backend and a fake `@vercel/blob` would prove only that the
 * fake agrees with itself.
 *
 * Everything it writes lands under one run-scoped prefix and is deleted in
 * `afterAll`, which runs whether the checks passed or not.
 */
import { randomUUID } from "node:crypto";
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

/**
 * How long Blob may go on serving an object after it was deleted. Vercel
 * documents up to 60 s of CDN propagation, so the deletion check polls to that
 * and says so in its own name rather than asserting a promise the backend
 * never made.
 */
const DELETE_DEADLINE_MS = 60_000;

/**
 * Two, so three written objects need two pages and the cursor loop is actually
 * followed. Production uses Blob's own maximum of 1000; proving the loop at
 * that size would mean writing 1001 objects, which costs more than the whole
 * two-minute budget.
 */
const LIST_PAGE_SIZE = 2;

/**
 * Room for the deletion check to reach its deadline before Vitest calls it
 * hung. Nothing else here comes near it: the round trip measures in hundreds
 * of milliseconds.
 */
const CHECK_TIMEOUT_MS = DELETE_DEADLINE_MS + 15_000;

/** Every key the checks wrote, so `afterAll` can name them all. */
const written = new Set<string>();

const store = blobStore({ listPageSize: LIST_PAGE_SIZE });

const checks = storeConformance(store, {
  prefix: PREFIX,
  deleteDeadlineMs: DELETE_DEADLINE_MS,
  wrote: (key) => written.add(key),
});

describe("storeConformance over the live blobStore", () => {
  for (const check of checks) {
    it(check.name, check.run, CHECK_TIMEOUT_MS);
  }
});

describe("what the live run's fixtures change about the checks", () => {
  it("names the deadline it polls to, which the in-memory run has none of", () => {
    const names = checks.map((check) => check.name);

    expect(names).toContain(
      "after delete, get is null and list no longer names the key, within 60 s"
    );
  });
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
  // `store.delete` is unconditional and silent about a key already gone, so the
  // keys the deletion check removed cost nothing to name again here.
  await Promise.all([...written].map((key) => store.delete(key)));
}, CHECK_TIMEOUT_MS);
