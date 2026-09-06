/**
 * One list of Conformance Checks, run against every adapter. pglite runs it
 * inside `pnpm check`; the Neon adapter runs the identical list under
 * `pnpm test:records:live`. A difference between the two is then a red test
 * rather than a production surprise.
 *
 * A check reports failure by throwing, so the assertions are `node:assert`'s
 * and not a test runner's: the list has to survive being handed to whatever
 * runner a consuming package uses.
 */
import {
  deepStrictEqual,
  notStrictEqual,
  ok,
  rejects,
  strictEqual,
} from "node:assert/strict";
import { createHash } from "node:crypto";
import type { Annotation } from "@meco/contracts";
import type { Check } from "@meco/contracts/conformance";
import { reachRecords, recordsTables } from "./health";
import type { Records } from "./records";
import { TABLE_NAMES } from "./schema";

/** A database with no tables, and however many Records over that one database. */
export interface EmptyDatabase {
  /** Another `Records` on the same database. Never migrates on its own. */
  open(): Records;
  /** Closes the database and everything opened over it. */
  dispose(): Promise<void>;
}

/** What an adapter's host hands {@link recordsConformance}. */
export interface RecordsFixtures {
  /**
   * A database this run may migrate from nothing. On a live backend it is a
   * run-scoped schema the host drops afterwards, because the migration checks
   * need a database that has never been migrated and production has been.
   */
  empty(): Promise<EmptyDatabase>;
}

/** Distinct bytes per check, so one check's row is never another's. */
const hashOf = (label: string): string =>
  createHash("sha256")
    .update(`@meco/records conformance: ${label}`)
    .digest("hex");

const fileFor = (label: string) => ({
  hash: hashOf(label),
  mime: "image/png",
  width: 1200,
  height: 800,
  bytes: 65_536,
  storeKey: `sources/${hashOf(label)}.png`,
});

/**
 * An Annotation with everything the contracts schema makes optional filled in,
 * so the jsonb round trip is asked about nested objects, arrays and floats and
 * not only about scalars.
 */
const annotationFor = (label: string): Annotation => {
  const file = fileFor(label);
  return {
    schema: 1,
    hash: file.hash,
    mime: "image/png",
    width: file.width,
    height: file.height,
    producedBy: [
      { name: "scrfd", version: "10g-1" },
      { name: "edgeface", version: "s-gamma-05-1" },
    ],
    regions: [
      {
        id: "face-1",
        kind: "face",
        label: "face",
        box: { x: 0.25, y: 0.125, width: 0.5, height: 0.25 },
        score: 0.9921875,
        model: { name: "scrfd", version: "10g-1" },
        landmarks: {
          rEye: { x: 0.35, y: 0.2 },
          lEye: { x: 0.55, y: 0.2 },
          nose: { x: 0.45, y: 0.26 },
          rMouth: { x: 0.38, y: 0.32 },
          lMouth: { x: 0.52, y: 0.32 },
        },
        facePrint: {
          model: { name: "edgeface", version: "s-gamma-05-1" },
          vector: [0.6, 0.8],
        },
      },
    ],
  };
};

export function recordsConformance(
  open: () => Promise<Records>,
  fixtures: RecordsFixtures
): Check[] {
  return [
    {
      name: "migrate on an empty database creates every table, and a second migrate applies nothing",
      async run() {
        const database = await fixtures.empty();
        try {
          const records = database.open();

          const first = await records.migrate();
          const tables = await recordsTables(records);
          const second = await records.migrate();

          ok(first.applied > 0, "the first migrate applied nothing");
          for (const table of TABLE_NAMES) {
            ok(tables.includes(table), `no table "${table}" after migrate`);
          }
          strictEqual(second.applied, 0);
        } finally {
          await database.dispose();
        }
      },
    },
    {
      name: "two migrations at once apply once",
      async run() {
        const database = await fixtures.empty();
        try {
          const [a, b] = await Promise.all([
            database.open().migrate(),
            database.open().migrate(),
          ]);

          // Whichever went first applied everything; the other found the work
          // done. Without the lock both read an empty database and both try to
          // create the same tables.
          const [fewer, more] = [a.applied, b.applied].sort((x, y) => x - y);
          strictEqual(fewer, 0);
          ok(
            more !== undefined && more > 0,
            "neither migration applied anything"
          );
        } finally {
          await database.dispose();
        }
      },
    },
    {
      name: "reachRecords reports every migration pending before migrate and none after",
      async run() {
        const database = await fixtures.empty();
        try {
          const records = database.open();

          const before = await reachRecords(records);
          await records.migrate();
          const after = await reachRecords(records);

          ok(
            before.pending !== null && before.pending > 0,
            `pending is ${before.pending} on a database that was never migrated`
          );
          strictEqual(before.migrated, false);
          strictEqual(after.pending, 0);
          strictEqual(after.migrated, true);
          strictEqual(after.reachable, true);
          ok(after.serverVersion !== null, "no server version after migrate");
        } finally {
          await database.dispose();
        }
      },
    },
    {
      name: "files.ensure twice on one hash is one row, and keeps the first row's facts",
      async run() {
        const records = await open();
        const file = fileFor("ensured twice");

        const first = await records.files.ensure(file);
        const second = await records.files.ensure({
          ...file,
          storeKey: "sources/someone-elses-idea.png",
        });

        strictEqual(second.hash, first.hash);
        strictEqual(second.storeKey, file.storeKey);
        strictEqual(second.firstSeenAt, first.firstSeenAt);
      },
    },
    {
      name: "files.get of a hash never seen is null, not a throw",
      async run() {
        const records = await open();

        strictEqual(await records.files.get(hashOf("never seen")), null);
      },
    },
    {
      name: "annotations.put then get is structurally equal and parses with the contracts schema",
      async run() {
        const records = await open();
        const annotation = annotationFor("round trip");
        await records.files.ensure(fileFor("round trip"));

        await records.annotations.put(annotation);
        const readBack = await records.annotations.get(annotation.hash);

        // Structural, never textual. Postgres reorders the keys of a jsonb
        // document, so what comes back is not the string that went in.
        deepStrictEqual(readBack, annotation);
        ok(readBack !== null);
        notStrictEqual(readBack, annotation);
      },
    },
    {
      name: "annotations.put replaces what was stored for that hash",
      async run() {
        const records = await open();
        const annotation = annotationFor("replaced");
        await records.files.ensure(fileFor("replaced"));

        await records.annotations.put(annotation);
        const rewritten: Annotation = { ...annotation, regions: [] };
        await records.annotations.put(rewritten);

        deepStrictEqual(
          await records.annotations.get(annotation.hash),
          rewritten
        );
      },
    },
    {
      name: "annotations.get of an unknown hash is null, not a throw",
      async run() {
        const records = await open();

        strictEqual(await records.annotations.get(hashOf("unannotated")), null);
      },
    },
    {
      name: "annotations.put without its File is refused",
      async run() {
        const records = await open();

        // The Annotation hangs off the File and dies with it, so an Annotation
        // with no File is a row nothing could ever delete.
        await rejects(() =>
          records.annotations.put(annotationFor("no file of its own"))
        );
      },
    },
  ];
}
