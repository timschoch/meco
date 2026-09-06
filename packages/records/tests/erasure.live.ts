/**
 * The Erasure proof the ticket asks for, end to end against both live
 * backends: the rows on Neon `meco-records-eu` in `eu-central-1`, the bytes in
 * the live **Private Store** in `fra1`. The conformance list proves the same
 * cascade against a `Map`; this proves it against the store that actually holds
 * a Reference Photo.
 *
 * It prints the prefix listing before and after, because a promise about
 * personal data is worth exactly what someone can read off it.
 *
 * The rows go in a run-scoped database this file creates and drops. Production
 * rows live in `neondb`'s `public`, and enrolling a Person there would need a
 * Brand row that only `pnpm records:seed` may write
 * ([#161](https://github.com/timschoch/meco/issues/161)). The server, the
 * migration SQL and the Private Store are the deployment's own.
 */
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { blobStore } from "@meco/store";
import { neonDatabase, peoplePrefix, records } from "../index";
import { scratchDatabases } from "./live-database";

/**
 * Vercel documents up to 60 s of CDN propagation after a delete, which is the
 * deadline `@meco/store`'s own live checks poll to. `Erasure.remaining` is the
 * store's answer at the moment the bytes went, so on Blob it may still name the
 * key; what has to become true is that the prefix lists empty by the deadline.
 */
const DELETE_DEADLINE_MS = 60_000;
const CHECK_TIMEOUT_MS = DELETE_DEADLINE_MS + 60_000;

const store = blobStore();
const scratch = scratchDatabases();
/** Every key this file wrote, so a failed run leaves no Reference Photo behind. */
const written = new Set<string>();

describe("Erasure against Neon and the live Private Store", () => {
  it(
    "leaves no Person, no File, and nothing under people/<brand>/<personId>",
    async () => {
      const database = neonDatabase(await scratch.make());
      const meco = records({ database, store });
      try {
        await meco.migrate();
        const brand = "erasure-proof";
        await meco.brands.ensure({ id: brand, name: "Erasure proof" });
        const person = await meco.people.create({ brand, name: "Ada" });
        const prefix = peoplePrefix(brand, person.id);

        // Distinct bytes per run, so two runs at once never share a key and
        // one run's delete is never the other's proof.
        const bytes = new TextEncoder().encode(
          `meco erasure proof ${randomUUID()}`
        );
        const photo = await store.put(prefix, bytes, "image/png");
        written.add(photo.key);
        await meco.files.ensure({
          hash: photo.hash,
          mime: "image/png",
          width: 1200,
          height: 800,
          bytes: bytes.byteLength,
          storeKey: photo.key,
        });
        await meco.people.enrol({
          brand,
          personId: person.id,
          hash: photo.hash,
          storeKey: photo.key,
          regionId: "face-1",
          facePrint: {
            model: { name: "edgeface", version: "s-gamma-05-1" },
            vector: [0.6, 0.8],
          },
          consentAt: "2026-09-06T00:00:00.000Z",
        });

        const before = await store.list(prefix);
        console.log(`erasure proof, ${prefix}`);
        console.log(`  before: ${JSON.stringify(before)}`);
        expect(before.map((one) => one.key)).toEqual([photo.key]);

        const erasure = await meco.people.erase(brand, person.id);
        console.log(`  erasure: ${JSON.stringify(erasure)}`);

        expect(erasure.erased).toBe(true);
        expect(erasure.photos).toBe(1);
        expect(erasure.files).toEqual([photo.hash]);
        expect(await meco.people.get(brand, person.id)).toBeNull();
        expect(await meco.files.get(photo.hash)).toBeNull();

        // Polled to Blob's own deadline rather than asserted at once: the
        // backend never promised the CDN would have caught up by the time the
        // delete returned, and a check that pretended otherwise would be flaky
        // rather than strict.
        const deadline = Date.now() + DELETE_DEADLINE_MS;
        let after = await store.list(prefix);
        while (after.length > 0 && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          after = await store.list(prefix);
        }
        console.log(`  after:  ${JSON.stringify(after)}`);
        expect(after).toEqual([]);
      } finally {
        await database.close();
      }
    },
    CHECK_TIMEOUT_MS
  );
});

afterAll(async () => {
  // Unconditional and silent about a key already gone, so naming the key the
  // Erasure removed costs nothing and a failed run still cleans up.
  await Promise.all([...written].map((key) => store.delete(key)));
  await scratch.dispose();
}, CHECK_TIMEOUT_MS);
