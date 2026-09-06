/**
 * The Sweep proof the ticket asks for, against both live backends: the rows on
 * Neon `meco-records-eu` in `eu-central-1`, the bytes in the live **Private
 * Store** in `fra1`. The conformance list proves the same counting against a
 * `Map`; this proves that `store.delete` really reached the store that holds a
 * Source Image, and that `store.head` of the key is `null` afterwards.
 *
 * It prints the Sweep Report, because a promise about how long a stranger's
 * face is kept is worth exactly what someone can read off it.
 *
 * The rows go in a run-scoped database this file creates and drops, for the
 * reason `erasure.live.ts` gives: the Sweep deletes every unheld File it finds,
 * and production is not a place to run one by hand.
 */
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { blobStore } from "@meco/store";
import { neonDatabase, records } from "../index";
import { scratchDatabases } from "./live-database";

/**
 * Vercel documents up to 60 s of CDN propagation after a delete, which is the
 * deadline `@meco/store`'s own live checks poll to.
 */
const DELETE_DEADLINE_MS = 60_000;
const CHECK_TIMEOUT_MS = DELETE_DEADLINE_MS + 60_000;

const DAY_MS = 86_400_000;

const store = blobStore();
const scratch = scratchDatabases();
/** Every key this file wrote, so a failed run leaves no Source Image behind. */
const written = new Set<string>();

describe("the Sweep against Neon and the live Private Store", () => {
  it(
    "takes an unheld File, its Annotation and its bytes, and leaves a held one",
    async () => {
      const database = neonDatabase(await scratch.make());
      const meco = records({ database, store });
      try {
        await meco.migrate();
        const brand = "sweep-proof";
        await meco.brands.ensure({ id: brand, name: "Sweep proof" });

        // Distinct bytes per run, so two runs at once never share a key and
        // one run's delete is never the other's proof.
        const run = randomUUID();
        const orphan = await store.put(
          "sources",
          new TextEncoder().encode(`meco sweep proof, held by nobody ${run}`),
          "image/png"
        );
        const held = await store.put(
          "sources",
          new TextEncoder().encode(`meco sweep proof, still held ${run}`),
          "image/png"
        );
        for (const put of [orphan, held]) {
          written.add(put.key);
          await meco.files.ensure({
            hash: put.hash,
            mime: "image/png",
            width: 1200,
            height: 800,
            bytes: 64,
            storeKey: put.key,
          });
        }
        await meco.annotations.put({
          schema: 1,
          hash: orphan.hash,
          mime: "image/png",
          width: 1200,
          height: 800,
          producedBy: [{ name: "scrfd", version: "10g-1" }],
          regions: [
            {
              id: "face-1",
              kind: "face",
              label: "face",
              box: { x: 0.25, y: 0.125, width: 0.5, height: 0.25 },
              score: 0.99,
              model: { name: "scrfd", version: "10g-1" },
              facePrint: {
                model: { name: "edgeface", version: "s-gamma-05-1" },
                vector: [0.6, 0.8],
              },
            },
          ],
        });
        await meco.sources.hold(brand, held.hash);

        expect(await store.head(orphan.key)).not.toBeNull();

        // Thirty-one days on. The clock moves, never `first_seen_at`: that
        // column is the database's and no seam method may write it.
        const report = await meco.sweep(new Date(Date.now() + 31 * DAY_MS));
        console.log(`sweep proof: ${JSON.stringify(report)}`);

        expect(report.retentionDays).toBe(30);
        expect(report.files).toContain(orphan.hash);
        expect(report.keys).toContain(orphan.key);
        expect(await meco.files.get(orphan.hash)).toBeNull();
        // The Annotation went with the File, and every Face Print in it.
        expect(await meco.annotations.get(orphan.hash)).toBeNull();

        // One Source Hold from one Brand, and the photograph stands.
        expect(report.files).not.toContain(held.hash);
        expect(await meco.files.get(held.hash)).not.toBeNull();
        expect(await store.head(held.key)).not.toBeNull();
        expect(await meco.sources.heldBy(brand, held.hash)).toBe(true);

        // Polled to Blob's own deadline rather than asserted at once: the
        // backend never promised the CDN would have caught up by the time the
        // delete returned.
        const deadline = Date.now() + DELETE_DEADLINE_MS;
        let head = await store.head(orphan.key);
        while (head !== null && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          head = await store.head(orphan.key);
        }
        console.log(`  head of the swept key: ${JSON.stringify(head)}`);
        expect(head).toBeNull();
      } finally {
        await database.close();
      }
    },
    CHECK_TIMEOUT_MS
  );
});

afterAll(async () => {
  // Unconditional and silent about a key already gone, so naming the key the
  // Sweep removed costs nothing and a failed run still cleans up.
  await Promise.all([...written].map((key) => store.delete(key)));
  // After every pool has gone: `drop database … with (force)` terminates the
  // connections it finds, and one still open comes back as an unhandled
  // `57P01` that fails the run after the checks have already passed.
  await scratch.dispose();
}, CHECK_TIMEOUT_MS);
