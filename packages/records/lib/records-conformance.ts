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
import { createHash, randomUUID } from "node:crypto";
import { inspect } from "node:util";
import type { Annotation, FacePrint } from "@meco/contracts";
import type { Check } from "@meco/contracts/conformance";
import { type Listing, type Store, memoryStore } from "@meco/store";
import { sql } from "drizzle-orm";
import type { CallError, CallKind, NewCall, Step } from "./calls";
import { PROBE_HASH, reachRecords, recordsTables } from "./health";
import { verifying } from "./neon-database";
import { peoplePrefix } from "./people";
import { type Records, driverOf } from "./records";
import { BOOTSTRAP_BRANDS, seedRecords } from "./seed";
import { DAY_MS, type SweepReport } from "./sweep";

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
   * run-scoped database the host drops afterwards, because the migration
   * checks need one that has never been migrated and production has been.
   */
  empty(): Promise<EmptyDatabase>;
  /**
   * A fresh, migrated `Records` over the store handed in, and over the
   * Retention Window handed in when one is.
   *
   * `open()` builds its own store, so a check that has to watch bytes cross the
   * store's seam — Erasure is nothing but that — cannot see it. This is how a
   * check supplies the one it will assert on.
   *
   * `retentionDays` is here for one reason: a window the checks could not
   * change would be a window they could not tell from a constant, and "read
   * from configuration" is the acceptance criterion.
   */
  withStore(store: Store, retentionDays?: number): Promise<Records>;
}

/**
 * The tables `docs/specs/records.md` says the schema holds, written out here
 * rather than read off the schema module: an expectation taken from the code it
 * checks agrees with that code by construction, and would stay green when a
 * table went missing from both.
 */
const TABLES = [
  "annotations",
  "brands",
  "callers",
  "calls",
  "files",
  "outputs",
  "people",
  "reference_photos",
  "sources",
] as const;

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

/**
 * The same Annotation for bytes whose Content Hash a check already holds,
 * rather than for a label. The Erasure checks need one hanging off a File they
 * built through the store, to prove the Face Prints inside it die with it.
 */
const annotationOf = (hash: string): Annotation => ({
  ...annotationFor("a reference photograph"),
  hash,
});

/** Distinct bytes per label, so one check's Stored Object is never another's. */
const bytesFor = (label: string): Uint8Array =>
  new TextEncoder().encode(`@meco/records conformance bytes: ${label}`);

/**
 * A Face Print on the unit sphere, distinct per label. The contracts schema
 * refuses one that is not unit length, so it cannot be two arbitrary numbers.
 */
const printFor = (label: string): FacePrint => {
  const x = (Number.parseInt(hashOf(label).slice(0, 8), 16) % 1000) / 1000;
  return {
    model: { name: "edgeface", version: "s-gamma-05-1" },
    vector: [x, Math.sqrt(1 - x * x)],
  };
};

/**
 * A Brand id derived from the label, so checks sharing one database — which is
 * what the live host does, one database for the whole run — never collide.
 */
const brandFor = (label: string): string => `b-${hashOf(label).slice(0, 12)}`;

/** A `Store` that also reports which keys it was asked to delete, in order. */
interface WatchedStore extends Store {
  readonly deletes: readonly string[];
}

/**
 * A store the Erasure checks can watch. "The bytes went once, and only at a
 * Reference Count of zero" is a statement about calls that crossed the store's
 * seam, so it has to be asserted there and not inferred from what is left.
 */
function watching(): WatchedStore {
  const store = memoryStore();
  const deletes: string[] = [];
  return {
    ...store,
    async delete(key) {
      deletes.push(key);
      await store.delete(key);
    },
    deletes,
  };
}

/**
 * A Person of one Brand with one Reference Photo whose bytes are really in the
 * store, and whose File is really a row: the Source Key as well as the Person's
 * own key, because the two-key case is the one Erasure has to get right.
 */
async function enrolled(
  records: Records,
  store: Store,
  options: {
    readonly brand: string;
    readonly label: string;
    readonly person?: string;
    readonly consentAt?: string;
  }
) {
  const bytes = bytesFor(options.label);
  const person =
    options.person ??
    (await records.people.create({ brand: options.brand, name: options.label }))
      .id;

  const source = await store.put("sources", bytes, "image/png");
  const held = await store.put(
    peoplePrefix(options.brand, person),
    bytes,
    "image/png"
  );
  await records.files.ensure({
    hash: source.hash,
    mime: "image/png",
    width: 1200,
    height: 800,
    bytes: bytes.byteLength,
    storeKey: source.key,
  });

  const photo = await records.people.enrol({
    brand: options.brand,
    personId: person,
    hash: source.hash,
    storeKey: held.key,
    regionId: "face-1",
    facePrint: printFor(options.label),
    ...(options.consentAt === undefined
      ? {}
      : { consentAt: options.consentAt }),
  });
  return { person, photo, hash: source.hash, sourceKey: source.key };
}

const keysOf = (listed: readonly Listing[]): string[] =>
  listed.map((one) => one.key);
/** A bearer key derived from the label, so no two checks share a Caller. */
const keyFor = (label: string): string =>
  `meco_test_${hashOf(label).slice(0, 24)}`;

/** What `crypto.randomUUID()` produces, and nothing else. */
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * A Brand and a Caller, because a Call's foreign keys need both rows before
 * there can be a Call at all.
 */
async function calling(records: Records, label: string) {
  const brand = brandFor(label);
  await records.brands.ensure({ id: brand, name: label });
  const caller = await records.callers.create({
    name: label,
    key: `bearer-${hashOf(label)}`,
    brands: [brand],
  });
  return { brand, callerId: caller.id };
}

/** `2026-09-06T09:<minute>`, so a check's Calls have distinct start times. */
const at = (minute: number): string =>
  `2026-09-06T09:${String(minute).padStart(2, "0")}:00.000Z`;

/**
 * A Source Image nobody holds: bytes in the store and a `files` row naming
 * them, and no `sources` or `reference_photos` row anywhere. This is what the
 * Sweep is for, and {@link enrolled} cannot make one because a Reference Photo
 * is a reference.
 */
async function filed(
  records: Records,
  store: Store,
  label: string
): Promise<{ readonly hash: string; readonly key: string }> {
  const bytes = bytesFor(label);
  const put = await store.put("sources", bytes, "image/png");
  await records.files.ensure({
    hash: put.hash,
    mime: "image/png",
    width: 1200,
    height: 800,
    bytes: bytes.byteLength,
    storeKey: put.key,
  });
  return { hash: put.hash, key: put.key };
}

/** An Output on one Store Key, with the Caller and the Call it hangs off. */
async function outputOn(
  records: Records,
  options: {
    readonly brand: string;
    readonly storeKey: string;
    readonly label: string;
  }
): Promise<void> {
  const caller = await records.callers.create({
    name: options.label,
    key: `bearer-${hashOf(`the output on ${options.label}`)}`,
    brands: [options.brand],
  });
  const call = await records.calls.record({
    callerId: caller.id,
    brand: options.brand,
    kind: "crop",
    status: "ok",
    startedAt: at(0),
  });
  await records.outputs.record({
    brand: options.brand,
    storeKey: options.storeKey,
    callId: call.id,
    kind: "crop",
    requestHash: records.requestHash(options.brand, "crop", {
      label: options.label,
    }),
  });
}

/**
 * The instant the Sweep measures its window from. The Files a check writes are
 * written now, so moving the check's clock forward is how they get old — and it
 * needs no control over `first_seen_at`, which the database sets and no seam
 * method may.
 */
const daysFromNow = (days: number): Date =>
  new Date(Date.now() + days * DAY_MS);

/**
 * The live host runs every data check against one database, so a Sweep sees
 * every other check's Files as well as its own. Every assertion below is
 * therefore about this check's own hashes and keys and never about the whole
 * report, which is the honest statement in both hosts.
 */
const swept = (report: SweepReport, hash: string): boolean =>
  report.files.includes(hash);

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
          for (const table of TABLES) {
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
      name: "the connection string is pinned to sslmode=verify-full, credentials untouched",
      async run() {
        // Not a database check — it needs no connection — but it belongs with
        // the others because it is the one thing about reaching Neon that no
        // round trip can prove: a string that connected says nothing about
        // what pg 9 will do with `sslmode=require`, and a password mangled on
        // the way in fails long after this ticket.
        // A reserved character in a password reaches records already
        // percent-encoded, because that is the only way it can be in a URI at
        // all. What must not happen is that it comes out encoded differently:
        // `new URL(...).toString()` re-serialises every part it parsed, and the
        // password is one of them.
        const password = "npg_7Kd%2Fq%3AZ%40x1";
        const dsn = `postgresql://neondb_owner:${password}@ep-x.eu-central-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require`;

        const pinned = verifying(dsn);

        ok(pinned.includes("sslmode=verify-full"), pinned);
        ok(!pinned.includes("sslmode=require"), pinned);
        ok(pinned.includes("channel_binding=require"), pinned);
        ok(pinned.includes(`:${password}@`), "the password was rewritten");
        // And a string with no query at all still gets the mode.
        strictEqual(
          verifying("postgresql://u:p@host/db"),
          "postgresql://u:p@host/db?sslmode=verify-full"
        );
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
      name: "annotations.get refuses a stored document that is no longer an Annotation",
      async run() {
        const records = await open();
        const file = fileFor("from an older build");
        await records.files.ensure(file);

        // What a row written by an older build looks like from here. The seam
        // types forbid writing one, which is why this check has to force it:
        // the document is stored as contracts defined it *then*, and reading it
        // back has to be a refusal rather than an Annotation this build would
        // act on.
        await records.annotations.put({
          ...annotationFor("from an older build"),
          schema: 0,
        } as unknown as Annotation);

        await rejects(() => records.annotations.get(file.hash));
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
    {
      name: "people.create mints an id, and people.get finds the Person only for its own Brand",
      async run() {
        const records = await open();
        const mine = brandFor("owns the person");
        const theirs = brandFor("does not own the person");
        await records.brands.ensure({ id: mine, name: "Mine" });
        await records.brands.ensure({ id: theirs, name: "Theirs" });

        const person = await records.people.create({
          brand: mine,
          name: "Ada",
        });

        deepStrictEqual(await records.people.get(mine, person.id), person);
        // The Brand wall, on the one method a caller reaches a Person by. An id
        // is not a capability: knowing one must not hand a Person over to
        // whoever asks with the wrong Brand.
        strictEqual(await records.people.get(theirs, person.id), null);
        ok(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
            person.id
          ),
          `${person.id} is no UUID, and it lands in a Store Key`
        );
      },
    },
    {
      name: "people.get of an id never created is null, not a throw",
      async run() {
        const records = await open();
        const brand = brandFor("has no such person");
        await records.brands.ensure({ id: brand, name: "Empty" });

        strictEqual(await records.people.get(brand, crypto.randomUUID()), null);
      },
    },
    {
      name: "people.enrol without a File for the hash is refused",
      async run() {
        const records = await open();
        const brand = brandFor("enrols bytes records never saw");
        await records.brands.ensure({ id: brand, name: "Unknown bytes" });
        const person = await records.people.create({ brand, name: "Grace" });

        // A Reference Photo hangs off a File, as an Annotation does. Without
        // the row there is nothing to count references on and nothing the
        // Sweep or an Erasure could ever find again.
        await rejects(() =>
          records.people.enrol({
            brand,
            personId: person.id,
            hash: hashOf("never ensured"),
            storeKey: `${peoplePrefix(brand, person.id)}/${hashOf("never ensured")}.png`,
            regionId: "face-1",
            facePrint: printFor("never ensured"),
          })
        );
      },
    },
    {
      name: "people.enrol keeps the Region, the print and the consent, and leaves consent absent when none was given",
      async run() {
        const records = await open();
        const store = memoryStore();
        const brand = brandFor("enrols with and without consent");
        await records.brands.ensure({ id: brand, name: "Consent" });

        const consented = await enrolled(records, store, {
          brand,
          label: "with consent",
          consentAt: "2026-09-01T10:00:00.000Z",
        });
        const silent = await enrolled(records, store, {
          brand,
          label: "without consent",
        });

        strictEqual(consented.photo.regionId, "face-1");
        deepStrictEqual(consented.photo.facePrint, printFor("with consent"));
        strictEqual(consented.photo.consentAt, "2026-09-01T10:00:00.000Z");
        // ADR-0003, Decision 2: records stores the date the enroller gives and
        // never supplies one. A `consent_at` meco filled in would be meco
        // asserting a consent nobody recorded.
        strictEqual(silent.photo.consentAt, null);
      },
    },
    {
      name: "people.list gives every Person of the Brand with every Face Print, including a Person with none, and no other Brand's",
      async run() {
        const records = await open();
        const store = memoryStore();
        const mine = brandFor("lists its people");
        const theirs = brandFor("is listed by nobody else");
        await records.brands.ensure({ id: mine, name: "Mine" });
        await records.brands.ensure({ id: theirs, name: "Theirs" });

        const twice = await records.people.create({ brand: mine, name: "Ada" });
        await enrolled(records, store, {
          brand: mine,
          label: "first of two",
          person: twice.id,
        });
        await enrolled(records, store, {
          brand: mine,
          label: "second of two",
          person: twice.id,
        });
        const none = await records.people.create({ brand: mine, name: "Alan" });
        await enrolled(records, store, { brand: theirs, label: "not mine" });

        const listed = await records.people.list(mine);

        deepStrictEqual(
          new Set(listed.map((one) => one.id)),
          new Set([twice.id, none.id])
        );
        const withPrints = listed.find((one) => one.id === twice.id);
        ok(withPrints !== undefined);
        deepStrictEqual(
          new Set(withPrints.photos.map((one) => one.facePrint.vector[0])),
          new Set([
            printFor("first of two").vector[0],
            printFor("second of two").vector[0],
          ])
        );
        // A Person nobody has enrolled a photograph for is still a Person.
        // identify reads this list; a Person that vanished from it would look
        // like a Person who had been deleted.
        deepStrictEqual(listed.find((one) => one.id === none.id)?.photos, []);
      },
    },
    {
      name: "people.erase leaves no Person, no Reference Photo, no Face Print, no File and no byte under the prefix",
      async run() {
        const store = watching();
        const records = await fixtures.withStore(store);
        const brand = brandFor("erases everything");
        await records.brands.ensure({ id: brand, name: "Erasing" });

        const first = await enrolled(records, store, {
          brand,
          label: "erased first photo",
        });
        const second = await enrolled(records, store, {
          brand,
          label: "erased second photo",
          person: first.person,
        });
        await records.annotations.put(annotationOf(first.hash));
        const prefix = peoplePrefix(brand, first.person);
        strictEqual((await store.list(prefix)).length, 2);

        const erasure = await records.people.erase(brand, first.person);

        strictEqual(erasure.erased, true);
        strictEqual(erasure.photos, 2);
        deepStrictEqual(
          new Set(erasure.files),
          new Set([first.hash, second.hash])
        );
        // The listing is the proof ADR-0003 asks for, and it is the store's
        // own answer rather than anything records asserts about itself.
        deepStrictEqual(erasure.remaining, []);
        deepStrictEqual(await store.list(prefix), []);
        strictEqual(await records.people.get(brand, first.person), null);
        deepStrictEqual(await records.people.list(brand), []);
        // The File went with the last row that named it, and the Annotation —
        // every Face Print of everyone who was in the photograph — with the
        // File.
        strictEqual(await records.files.get(first.hash), null);
        strictEqual(await records.annotations.get(first.hash), null);
        // Both keys: the Person's own, and the Source Key of a File nothing
        // holds any more. The second is not under the prefix, so the listing
        // above could never have caught it.
        strictEqual(await store.head(first.sourceKey), null);
        strictEqual(await store.head(second.sourceKey), null);
      },
    },
    {
      name: "two enrolments of one photograph are two rows on one key: unenrol leaves the key, erase deletes it once",
      async run() {
        const store = watching();
        const records = await fixtures.withStore(store);
        const brand = brandFor("enrols one file twice");
        await records.brands.ensure({ id: brand, name: "Twice" });

        const first = await enrolled(records, store, {
          brand,
          label: "one file twice",
        });
        // The same bytes again, for the same Person: `store.put` is keyed by
        // the hash of its own bytes, so this is a second row on the first row's
        // key and never a second object.
        const second = await enrolled(records, store, {
          brand,
          label: "one file twice",
          person: first.person,
        });
        strictEqual(second.photo.storeKey, first.photo.storeKey);
        const prefix = peoplePrefix(brand, first.person);
        strictEqual((await store.list(prefix)).length, 1);

        const unenrolled = await records.people.unenrol(brand, first.photo.id);

        strictEqual(unenrolled.deleted, true);
        // Nothing went: the second row still names the key, and the File still
        // has a Reference Photo.
        deepStrictEqual(unenrolled.keys, []);
        deepStrictEqual(keysOf(await store.list(prefix)), [
          first.photo.storeKey,
        ]);
        ok(await records.files.get(first.hash));

        const erasure = await records.people.erase(brand, first.person);

        deepStrictEqual(erasure.remaining, []);
        strictEqual(
          store.deletes.filter((key) => key === first.photo.storeKey).length,
          1,
          "the shared key was deleted more than once"
        );
      },
    },
    {
      name: "an Erasure never deletes a File another Brand still holds as a Source Image, nor its bytes",
      async run() {
        const store = watching();
        const records = await fixtures.withStore(store);
        const mine = brandFor("erases a shared source");
        const theirs = brandFor("still holds the shared source");
        await records.brands.ensure({ id: mine, name: "Mine" });
        await records.brands.ensure({ id: theirs, name: "Theirs" });

        const enrolment = await enrolled(records, store, {
          brand: mine,
          label: "shared with a source hold",
        });
        await records.sources.hold(theirs, enrolment.hash);

        const erasure = await records.people.erase(mine, enrolment.person);

        deepStrictEqual(erasure.remaining, []);
        // The Person is gone and their own bytes are gone; the photograph the
        // other Brand is entitled to a Signed URL for is not.
        deepStrictEqual(erasure.files, []);
        ok(await records.files.get(enrolment.hash));
        ok(await store.head(enrolment.sourceKey));
        strictEqual(await records.sources.heldBy(theirs, enrolment.hash), true);
      },
    },
    {
      name: "an Erasure never deletes a File another Brand still has a Reference Photo of",
      async run() {
        const store = watching();
        const records = await fixtures.withStore(store);
        const mine = brandFor("erases a doubly enrolled file");
        const theirs = brandFor("enrolled the same photograph");
        await records.brands.ensure({ id: mine, name: "Mine" });
        await records.brands.ensure({ id: theirs, name: "Theirs" });

        const label = "enrolled by two brands";
        const ours = await enrolled(records, store, { brand: mine, label });
        const yours = await enrolled(records, store, { brand: theirs, label });

        const erasure = await records.people.erase(mine, ours.person);

        deepStrictEqual(erasure.remaining, []);
        deepStrictEqual(erasure.files, []);
        ok(await records.files.get(ours.hash));
        // Same bytes, two Persons, two Brands, two keys: the other Brand's
        // Reference Photo is still there and still readable.
        ok(await store.head(yours.photo.storeKey));
        strictEqual(
          (await store.list(peoplePrefix(theirs, yours.person))).length,
          1
        );
      },
    },
    {
      name: "people.unenrol deletes the last Reference Photo's bytes, keeps the Person, and leaves the File to the Sweep",
      async run() {
        const store = watching();
        const records = await fixtures.withStore(store);
        const brand = brandFor("unenrols the only photo");
        await records.brands.ensure({ id: brand, name: "Only" });

        const only = await enrolled(records, store, {
          brand,
          label: "the only reference photo",
        });
        await records.annotations.put(annotationOf(only.hash));

        const unenrolled = await records.people.unenrol(brand, only.photo.id);

        strictEqual(unenrolled.deleted, true);
        // The photo's own key and nothing else. The Source Key belongs to a
        // File, and a File nothing references any more is the Sweep's to take
        // after the Retention Window: the immediate cascade was sanctioned for
        // erasing a Person and for nothing else (#76, Q11).
        deepStrictEqual(unenrolled.keys, [only.photo.storeKey]);
        strictEqual(await store.head(only.photo.storeKey), null);
        // The Person stays: withdrawing one photograph is not an Erasure.
        ok(await records.people.get(brand, only.person));
        deepStrictEqual(
          (await records.people.list(brand)).find(
            (one) => one.id === only.person
          )?.photos,
          []
        );
        ok(await records.files.get(only.hash));
        ok(await store.head(only.sourceKey));
      },
    },
    {
      name: "people.unenrol and people.erase of something that is not there are not errors",
      async run() {
        const store = watching();
        const records = await fixtures.withStore(store);
        const brand = brandFor("erases nothing at all");
        await records.brands.ensure({ id: brand, name: "Nothing" });
        const absent = crypto.randomUUID();

        const unenrolled = await records.people.unenrol(brand, absent);
        const erasure = await records.people.erase(brand, absent);

        // Erasure is what a caller retries after a timeout. A second run that
        // threw would make "delete this Person" a call nobody could safely
        // repeat, and the prefix listing is the honest answer either way.
        strictEqual(unenrolled.deleted, false);
        strictEqual(erasure.erased, false);
        strictEqual(erasure.photos, 0);
        deepStrictEqual(erasure.remaining, []);
        deepStrictEqual(store.deletes, []);
      },
    },
    {
      name: "calls.record keeps every field it was given, and a failed Call with its error is a row",
      async run() {
        const records = await open();
        const { brand, callerId } = await calling(records, "records one call");
        const call: NewCall = {
          callerId,
          brand,
          kind: "render",
          sourceHash: hashOf("records one call"),
          request: { template: "story", fields: { title: "Ada" } },
          framing: { crop: { x: 0.1, y: 0.2, width: 0.5, height: 0.5 } },
          // identify's whole Identification and not the Match list alone: the
          // webui needs the verdicts, and records stores it unread (#162).
          matches: {
            matches: [
              { regionId: "face-1", personId: "p-1", similarity: 0.71 },
            ],
            faces: [{ regionId: "face-1", verdict: "matched" }],
            unusableReferencePhotos: [],
          },
          redactions: [{ regionId: "face-2", method: "blur" }],
          steps: [
            { name: "models.decode", durMs: 31 },
            { name: "models.scrfd", durMs: 28 },
            { name: "frame.choose", durMs: 1 },
          ],
          cost: { units: [{ name: "render", quantity: 1 }] },
          error: {
            module: "compose",
            code: "no_such_template",
            message: "story",
          },
          status: "failed",
          startedAt: at(0),
          durationMs: 412,
        };

        const recorded = await records.calls.record(call);

        // A failed Call is a Call. The webui's "what failed" reads `error`, and
        // a failure nobody wrote down is a gap in the Gallery instead.
        deepStrictEqual(await records.calls.get(recorded.id), recorded);
        strictEqual(recorded.status, "failed");
        deepStrictEqual(recorded.error, call.error);
        deepStrictEqual(recorded.steps, call.steps);
        // Every jsonb another module owns comes back as it went in, unread.
        deepStrictEqual(recorded.request, call.request);
        deepStrictEqual(recorded.framing, call.framing);
        deepStrictEqual(recorded.matches, call.matches);
        deepStrictEqual(recorded.redactions, call.redactions);
        deepStrictEqual(recorded.cost, call.cost);
        strictEqual(recorded.sourceHash, call.sourceHash);
        strictEqual(recorded.startedAt, at(0));
        strictEqual(recorded.durationMs, 412);
        ok(UUID.test(recorded.id), `${recorded.id} is no UUID`);
      },
    },
    {
      name: "calls.record fills nothing in: an annotate Call has no framing, no Matches and no Steps",
      async run() {
        const records = await open();
        const { brand, callerId } = await calling(
          records,
          "records a bare call"
        );

        const recorded = await records.calls.record({
          callerId,
          brand,
          kind: "annotate",
          status: "ok",
        });

        // Every column a kind does not use stays empty rather than acquiring a
        // shape records invented, which the webui would then have to explain.
        strictEqual(recorded.sourceHash, null);
        strictEqual(recorded.request, null);
        strictEqual(recorded.framing, null);
        strictEqual(recorded.matches, null);
        strictEqual(recorded.redactions, null);
        strictEqual(recorded.cost, null);
        strictEqual(recorded.error, null);
        strictEqual(recorded.durationMs, null);
        // Steps are the exception: a Call has a list of them, possibly empty.
        deepStrictEqual(recorded.steps, []);
      },
    },
    {
      name: "calls.record refuses a kind and a status outside the closed set",
      async run() {
        const records = await open();
        const { brand, callerId } = await calling(
          records,
          "records a bad call"
        );
        const call = { callerId, brand, kind: "crop", status: "ok" } as const;

        // `kind` and `status` are `text` and not a Postgres enum, so the set is
        // written down once in TypeScript and checked here. Without the check
        // the column would take anything a caller mistyped.
        await rejects(() =>
          records.calls.record({
            ...call,
            kind: "resize",
          } as unknown as NewCall)
        );
        await rejects(() =>
          records.calls.record({
            ...call,
            status: "pending",
          } as unknown as NewCall)
        );
      },
    },
    {
      name: "calls.record refuses Steps and an error that are not the shape records keeps",
      async run() {
        const records = await open();
        const { brand, callerId } = await calling(
          records,
          "records a malformed call"
        );
        const call = { callerId, brand, kind: "crop", status: "ok" } as const;

        // `steps` and `error` are jsonb columns, so nothing but this stands
        // between a mistyped Step and a Calls list the webui cannot render.
        await rejects(() =>
          records.calls.record({
            ...call,
            steps: [{ name: "frame.choose" }] as unknown as Step[],
          })
        );
        await rejects(() =>
          records.calls.record({
            ...call,
            error: { code: "boom" } as unknown as CallError,
          })
        );
      },
    },
    {
      name: "calls.get of an id never recorded is null, not a throw",
      async run() {
        const records = await open();

        strictEqual(await records.calls.get(crypto.randomUUID()), null);
      },
    },
    {
      name: "calls.list is newest first, honours brand and status, and its cursor never repeats or skips a Call",
      async run() {
        const records = await open();
        const mine = await calling(records, "lists its calls");
        const theirs = await calling(records, "is listed by nobody else");

        const ids: string[] = [];
        for (let minute = 0; minute < 5; minute++) {
          const call = await records.calls.record({
            callerId: mine.callerId,
            brand: mine.brand,
            kind: "crop",
            status: minute % 2 === 0 ? "ok" : "failed",
            startedAt: at(minute),
          });
          ids.push(call.id);
        }
        const newestFirst = [...ids].reverse();
        // Newer than every Call of the Brand under test, and another Brand's.
        await records.calls.record({
          callerId: theirs.callerId,
          brand: theirs.brand,
          kind: "crop",
          status: "ok",
          startedAt: at(9),
        });

        const all = await records.calls.list({ brand: mine.brand, limit: 10 });
        const failed = await records.calls.list({
          brand: mine.brand,
          status: "failed",
          limit: 10,
        });

        deepStrictEqual(
          all.rows.map((one) => one.id),
          newestFirst
        );
        // No cursor when nothing is left: an "older" link the Gallery would
        // show on the last page is a link to an empty page.
        strictEqual(all.cursor, null);
        // `?status=failed` on the Calls list.
        deepStrictEqual(
          failed.rows.map((one) => one.id),
          [ids[3], ids[1]]
        );

        const first = await records.calls.list({ brand: mine.brand, limit: 2 });
        ok(first.cursor !== null, "no cursor on a page with more behind it");
        // A Call recorded between the two pages, newer than every one of them.
        // A keyset cursor reads on from where the page ended, so it changes
        // nothing; an offset would shift every remaining row down by one and
        // the Call at index 2 would never be seen.
        await records.calls.record({
          callerId: mine.callerId,
          brand: mine.brand,
          kind: "crop",
          status: "ok",
          startedAt: at(8),
        });
        const second = await records.calls.list({
          brand: mine.brand,
          limit: 2,
          cursor: first.cursor,
        });

        deepStrictEqual(
          [...first.rows, ...second.rows].map((one) => one.id),
          newestFirst.slice(0, 4)
        );
      },
    },
    {
      name: "requestHash sorts object keys at every depth, and covers the Brand, the kind and array order",
      async run() {
        const records = await open();
        const request = {
          template: "story",
          fields: { title: "Ada", subtitle: "Lovelace" },
          source: { hash: hashOf("one photograph") },
        };
        // The same request, written by a client that serialises its keys in
        // another order. JSON has no key order, so two of these are one
        // request, and a Replay that missed it would pay for a second Render.
        const reordered = {
          source: { hash: hashOf("one photograph") },
          fields: { subtitle: "Lovelace", title: "Ada" },
          template: "story",
        };
        const hashed = (brand: string, kind: CallKind, body: unknown) =>
          records.requestHash(brand, kind, body);

        strictEqual(
          hashed("laica", "render", request),
          hashed("laica", "render", reordered)
        );
        // The Brand is inside the hash: two Brands asking the same thing own
        // two Outputs, and neither may find the other's by asking again.
        notStrictEqual(
          hashed("laica", "render", request),
          hashed("hopefamily", "render", request)
        );
        notStrictEqual(
          hashed("laica", "render", request),
          hashed("laica", "crop", request)
        );
        notStrictEqual(
          hashed("laica", "render", request),
          hashed("laica", "render", { ...request, template: "post" })
        );
        // An array is ordered and an object is not: two slides the other way
        // round are another Carousel.
        notStrictEqual(
          hashed("laica", "carousel", { slides: ["a", "b"] }),
          hashed("laica", "carousel", { slides: ["b", "a"] })
        );
        ok(
          /^[0-9a-f]{64}$/.test(hashed("laica", "render", request)),
          "a Request Hash is 64 lowercase hex, as every hash records keeps is"
        );
      },
    },
    {
      name: "outputs.byRequest finds the Output of an equal request whose keys arrived in another order, and only for its own Brand",
      async run() {
        const records = await open();
        const mine = await calling(records, "replays a render");
        const theirs = await calling(records, "asks for the very same render");
        const request = { template: "story", fields: { title: "Ada" } };
        const call = await records.calls.record({
          callerId: mine.callerId,
          brand: mine.brand,
          kind: "render",
          status: "ok",
          startedAt: at(0),
          sourceHash: hashOf("replays a render"),
        });

        const output = await records.outputs.record({
          brand: mine.brand,
          storeKey: `renders/${hashOf("replays a render")}.png`,
          callId: call.id,
          kind: "render",
          placement: "ig-post",
          requestHash: records.requestHash(mine.brand, "render", request),
        });

        deepStrictEqual(
          await records.outputs.byRequest(
            mine.brand,
            records.requestHash(mine.brand, "render", {
              fields: { title: "Ada" },
              template: "story",
            })
          ),
          output
        );
        strictEqual(
          await records.outputs.byRequest(
            theirs.brand,
            records.requestHash(theirs.brand, "render", request)
          ),
          null
        );
        strictEqual(
          await records.outputs.byRequest(mine.brand, hashOf("never asked")),
          null
        );
      },
    },
    {
      name: "outputs.list is newest first, honours brand, placement, kind and callId, carries its Call's facts, and its cursor never repeats or skips a row",
      async run() {
        const records = await open();
        const mine = await calling(records, "lists its outputs");
        const theirs = await calling(records, "is in nobody else's gallery");
        const sourceHash = hashOf("the photograph the gallery shows");
        const rendered = await records.calls.record({
          callerId: mine.callerId,
          brand: mine.brand,
          kind: "render",
          status: "ok",
          startedAt: at(3),
          sourceHash,
        });
        const cropped = await records.calls.record({
          callerId: mine.callerId,
          brand: mine.brand,
          kind: "crop",
          status: "failed",
          startedAt: at(4),
        });

        // Keys that sort the way they were created, so the tiebreak agrees with
        // the times and this check says the same thing on a machine fast enough
        // to write two rows inside one microsecond.
        const key = (index: number) => `renders/gallery-${index}.png`;
        const record = (
          index: number,
          of: { brand: string; callId: string },
          extra: { kind: "render" | "crop"; placement?: string }
        ) =>
          records.outputs.record({
            brand: of.brand,
            storeKey: key(index),
            callId: of.callId,
            requestHash: hashOf(`gallery ${index}`),
            ...extra,
          });

        for (const index of [0, 1]) {
          await record(
            index,
            { ...mine, callId: rendered.id },
            {
              kind: "render",
              placement: "ig-post",
            }
          );
        }
        for (const index of [2, 3]) {
          await record(
            index,
            { ...mine, callId: rendered.id },
            {
              kind: "render",
              placement: "ig-story",
            }
          );
        }
        await record(4, { ...mine, callId: cropped.id }, { kind: "crop" });
        const elsewhere = await records.calls.record({
          callerId: theirs.callerId,
          brand: theirs.brand,
          kind: "render",
          status: "ok",
          startedAt: at(5),
        });
        await records.outputs.record({
          brand: theirs.brand,
          storeKey: key(9),
          callId: elsewhere.id,
          kind: "render",
          requestHash: hashOf("gallery 9"),
        });

        const gallery = await records.outputs.list({
          brand: mine.brand,
          limit: 10,
        });

        deepStrictEqual(
          gallery.rows.map((one) => one.storeKey),
          [4, 3, 2, 1, 0].map(key)
        );
        strictEqual(gallery.cursor, null);
        // Each row carries its Call's facts, so the Gallery shows what an
        // Output was made from and how the Call that made it ended without a
        // second read per tile.
        const newest = gallery.rows[0];
        ok(newest !== undefined);
        strictEqual(newest.status, "failed");
        strictEqual(newest.startedAt, at(4));
        strictEqual(newest.sourceHash, null);
        const oldest = gallery.rows[4];
        ok(oldest !== undefined);
        strictEqual(oldest.status, "ok");
        strictEqual(oldest.startedAt, at(3));
        strictEqual(oldest.sourceHash, sourceHash);
        strictEqual(oldest.placement, "ig-post");

        deepStrictEqual(
          (
            await records.outputs.list({
              brand: mine.brand,
              placement: "ig-story",
              limit: 10,
            })
          ).rows.map((one) => one.storeKey),
          [3, 2].map(key)
        );
        deepStrictEqual(
          (
            await records.outputs.list({
              brand: mine.brand,
              kind: "crop",
              limit: 10,
            })
          ).rows.map((one) => one.storeKey),
          [key(4)]
        );
        // The Call View: one Call's Outputs (decision on #162).
        deepStrictEqual(
          (await records.outputs.list({ callId: rendered.id, limit: 10 })).rows
            .map((one) => one.storeKey)
            .sort(),
          [0, 1, 2, 3].map(key)
        );

        const first = await records.outputs.list({
          brand: mine.brand,
          limit: 2,
        });
        ok(first.cursor !== null, "no cursor on a page with more behind it");
        // An Output recorded between the two pages, newer than every one of
        // them. Keyset reads on from where the page ended; an offset would
        // shift the rest down by one and never show `gallery-2`.
        await record(5, { ...mine, callId: cropped.id }, { kind: "crop" });
        const second = await records.outputs.list({
          brand: mine.brand,
          limit: 2,
          cursor: first.cursor,
        });

        deepStrictEqual(
          [...first.rows, ...second.rows].map((one) => one.storeKey),
          [4, 3, 2, 1].map(key)
        );
      },
    },
    {
      name: "a cursor walks the whole Gallery however fast the rows were written",
      async run() {
        const records = await open();
        const mine = await calling(records, "writes its outputs in a burst");
        const call = await records.calls.record({
          callerId: mine.callerId,
          brand: mine.brand,
          kind: "crop",
          status: "ok",
        });

        // Enough rows for seven pages, so the walk is the whole list and not
        // one hop. What it cannot provoke is two rows in one millisecond at
        // different microseconds — pglite's clock is millisecond-resolution and
        // two round trips to Neon are milliseconds apart — which is why the
        // cursor's precision is fixed by its type instead (`page.ts`).
        const keys: string[] = [];
        for (let index = 0; index < 20; index++) {
          const storeKey = `renders/burst-${String(index).padStart(2, "0")}.png`;
          await records.outputs.record({
            brand: mine.brand,
            storeKey,
            callId: call.id,
            kind: "crop",
            requestHash: hashOf(`burst ${index}`),
          });
          keys.push(storeKey);
        }

        const walked: string[] = [];
        let cursor: string | undefined;
        do {
          const page = await records.outputs.list({
            brand: mine.brand,
            limit: 3,
            ...(cursor === undefined ? {} : { cursor }),
          });
          walked.push(...page.rows.map((one) => one.storeKey));
          cursor = page.cursor ?? undefined;
        } while (cursor !== undefined);

        deepStrictEqual(walked, [...keys].reverse());
      },
    },
    {
      name: "outputs.delete on a Store Key two Brands share deletes one row and no bytes; the second delete removes them",
      async run() {
        const store = watching();
        const records = await fixtures.withStore(store);
        const mine = await calling(records, "shares an output key");
        const theirs = await calling(records, "shares that same output key");
        // Byte-identical Crops of two Brands. `store.put` keys on the hash of
        // the bytes and no Brand appears in a public key (ADR-0010), so the two
        // Outputs are two rows on one key.
        const shared = await store.put(
          "renders",
          bytesFor("byte-identical crops"),
          "image/png"
        );
        for (const one of [mine, theirs]) {
          const call = await records.calls.record({
            callerId: one.callerId,
            brand: one.brand,
            kind: "crop",
            status: "ok",
          });
          await records.outputs.record({
            brand: one.brand,
            storeKey: shared.key,
            callId: call.id,
            kind: "crop",
            requestHash: records.requestHash(one.brand, "crop", { shared: 1 }),
          });
        }

        const first = await records.outputs.delete(mine.brand, shared.key);

        strictEqual(first.deleted, true);
        strictEqual(first.bytesDeleted, false);
        // The other Brand's stable URL is still a URL. `store.delete` is
        // unconditional (ADR-0010), so nothing but this count could stop it.
        deepStrictEqual(store.deletes, []);
        ok(await store.head(shared.key));
        deepStrictEqual(
          (await records.outputs.list({ brand: mine.brand, limit: 10 })).rows,
          []
        );
        strictEqual(
          (await records.outputs.list({ brand: theirs.brand, limit: 10 })).rows
            .length,
          1
        );

        const second = await records.outputs.delete(theirs.brand, shared.key);

        strictEqual(second.deleted, true);
        strictEqual(second.bytesDeleted, true);
        deepStrictEqual(store.deletes, [shared.key]);
        strictEqual(await store.head(shared.key), null);
      },
    },
    {
      name: "outputs.delete of an Output that is not there is not an error and takes no bytes",
      async run() {
        const store = watching();
        const records = await fixtures.withStore(store);
        const brand = brandFor("deletes nothing at all");
        await records.brands.ensure({ id: brand, name: "Nothing" });

        const deleted = await records.outputs.delete(brand, "renders/gone.png");

        // Deleting an Output is what a caller retries after a timeout, as an
        // Erasure is. A second run that threw would make it a call nobody could
        // safely repeat.
        strictEqual(deleted.deleted, false);
        strictEqual(deleted.bytesDeleted, false);
        deepStrictEqual(store.deletes, []);
      },
    },
    {
      name: "a second /health probe writes nothing",
      async run() {
        const database = await fixtures.empty();
        try {
          const records = database.open();
          await records.migrate();

          const first = await reachRecords(records);
          strictEqual(first.reachable, true);

          const written = await records.annotations.get(PROBE_HASH);
          if (written === null) {
            throw new Error("the first probe wrote no Annotation");
          }

          // What a row from another build looks like: still an Annotation of
          // the probe's bytes, not the one this build would write. A probe
          // that writes on every call overwrites it; a write-once probe reads
          // it and leaves it alone.
          const fromElsewhere: Annotation = {
            ...written,
            producedBy: [{ name: "scrfd", version: "10g-1" }],
          };
          await records.annotations.put(fromElsewhere);

          const second = await reachRecords(records);

          strictEqual(second.reachable, true);
          deepStrictEqual(
            await records.annotations.get(PROBE_HASH),
            fromElsewhere
          );
        } finally {
          await database.dispose();
        }
      },
    },
    {
      name: "brands.ensure is an upsert: one row per id, and the last name stands",
      async run() {
        const records = await open();
        const id = brandFor("ensured twice");

        const created = await records.brands.ensure({ id, name: "Before" });
        const renamed = await records.brands.ensure({ id, name: "After" });

        strictEqual(renamed.id, created.id);
        strictEqual(renamed.name, "After");
        // Ensured again, not created again: the Brand keeps the day it first
        // appeared, so `created_at` stays a fact about the Brand.
        strictEqual(renamed.createdAt, created.createdAt);
        deepStrictEqual(await records.brands.get(id), renamed);
        strictEqual(
          (await records.brands.list()).filter((brand) => brand.id === id)
            .length,
          1
        );
      },
    },
    {
      name: "brands.get of an id no Brand has is null, not a throw",
      async run() {
        const records = await open();

        strictEqual(await records.brands.get(brandFor("never ensured")), null);
      },
    },
    {
      name: "callers.byKey finds the Caller its key created, and the table holds no plaintext key",
      async run() {
        const records = await open();
        const brand = brandFor("one caller");
        const key = keyFor("no table may hold this");

        const created = await records.callers.create({
          name: "bootstrap",
          key,
          brands: [brand],
        });
        const found = await records.callers.byKey(key);

        deepStrictEqual(found, created);
        // Every column of the row as one string, so the assertion does not
        // depend on which column a mistake would have put the key in.
        const rows = await driverOf(records).query<{ readonly row: string }>(
          sql`select c::text as row from callers c where c.id = ${created.id}`
        );
        strictEqual(rows.length, 1);
        for (const { row } of rows) {
          ok(!row.includes(key), "the callers table holds the key itself");
        }
        // And nothing the seam hands back carries it either.
        ok(!JSON.stringify(created).includes(key), "create returned the key");
      },
    },
    {
      name: "callers.byKey of a key that created nothing is null, not a throw",
      async run() {
        const records = await open();

        strictEqual(await records.callers.byKey(keyFor("never issued")), null);
      },
    },
    {
      name: "callers.byKey returns the Brands that Caller holds and no others",
      async run() {
        const records = await open();
        const held = brandFor("held");
        const other = brandFor("held by someone else");
        await records.brands.ensure({ id: held, name: "Held" });
        await records.brands.ensure({ id: other, name: "Someone else" });
        const key = keyFor("holds one brand");

        await records.callers.create({
          name: "one brand only",
          key,
          brands: [held],
        });
        const found = await records.callers.byKey(key);

        // The Brand Wall is this array. A Caller that comes back holding a
        // Brand it was never given is the wall down.
        deepStrictEqual(found?.brands, [held]);
      },
    },
    {
      name: "callers.create refuses a second Caller on one key, refuses an empty key, and quotes neither",
      async run() {
        const records = await open();
        const brand = brandFor("issued once");
        const key = keyFor("issued once");

        await records.callers.create({ name: "first", key, brands: [brand] });

        // One key is one Caller: a second row on the same hash would make
        // `byKey` a coin toss, and the Brand Wall reads its answer.
        await rejects(
          () => records.callers.create({ name: "second", key, brands: [] }),
          (error: Error) => {
            // The driver's own message quotes the value it collided on, and
            // drizzle's wrapper prints every bound parameter. Neither the key
            // nor its SHA-256 may reach anything that might log it.
            ok(!error.message.includes(key), "the refusal quotes the key");
            ok(
              !/[0-9a-f]{64}/.test(error.message),
              `the refusal quotes a hash: ${error.message}`
            );
            return true;
          }
        );
        // An empty key hashes like any other string, so without the guard an
        // empty bearer token would authenticate a real Caller.
        await rejects(() =>
          records.callers.create({ name: "keyless", key: "", brands: [] })
        );
      },
    },
    {
      name: "callers.grant adds Brands, never removes one, and granting twice changes nothing",
      async run() {
        const records = await open();
        const first = brandFor("granted first");
        const second = brandFor("granted second");
        const key = keyFor("granted brands");
        const caller = await records.callers.create({
          name: "grows",
          key,
          brands: [first],
        });

        const granted = await records.callers.grant({
          callerId: caller.id,
          brands: [first, second],
        });
        const again = await records.callers.grant({
          callerId: caller.id,
          brands: [second],
        });

        deepStrictEqual([...granted.brands].sort(), [first, second].sort());
        // Idempotent: a Brand already held is not a second entry.
        deepStrictEqual(again.brands, granted.brands);
        // Additive: what the Caller held before a grant it still holds after.
        ok(again.brands.includes(first), "grant took a Brand away");
        deepStrictEqual(
          (await records.callers.byKey(key))?.brands,
          again.brands
        );
      },
    },
    {
      name: "a driver failure on a statement binding a key hash or a Face Print reports neither",
      async run() {
        // A database with no tables, so every statement below fails at the
        // server. That is the cheapest honest driver failure there is: no
        // schema to damage, and no pool to close under the checks that share
        // one. What drizzle raises is a `DrizzleQueryError` whose own message
        // is the statement and its bound parameters, and whose cause is the
        // driver's error quoting the offending value back — so a method that
        // merely rethrows what it caught publishes its Bound Secrets.
        const database = await fixtures.empty();
        try {
          const records = database.open();
          const key = keyFor("the key no failure may carry");
          const hash = createHash("sha256").update(key, "utf8").digest("hex");
          const print = printFor("the print no failure may carry");
          const label = "binds a face print";

          // Every method that binds one. A method added to this seam that
          // binds a key hash or a Face Print belongs in this list.
          const binding: [string, () => Promise<unknown>][] = [
            [
              "callers.create",
              () =>
                records.callers.create({ name: label, key, brands: [label] }),
            ],
            ["callers.byKey", () => records.callers.byKey(key)],
            [
              "people.enrol",
              () =>
                records.people.enrol({
                  brand: brandFor(label),
                  personId: randomUUID(),
                  hash: hashOf(label),
                  storeKey: `people/${brandFor(label)}/x/${hashOf(label)}.png`,
                  regionId: "face-1",
                  facePrint: print,
                }),
            ],
          ];

          for (const [method, run] of binding) {
            const failure = await run().then(
              () => {
                throw new Error(
                  `${method} succeeded on a database with no tables`
                );
              },
              (error: unknown) => error
            );
            // What a logger handed the error would print: the message, the
            // `cause` chain, and any own property drizzle hung on it.
            const printed = inspect(failure, { depth: 10 });
            ok(!printed.includes(hash), `${method} reported the key hash`);
            ok(!printed.includes(key), `${method} reported the key itself`);
            ok(
              !printed.includes(JSON.stringify(print.vector)),
              `${method} reported the Face Print`
            );
          }
        } finally {
          await database.dispose();
        }
      },
    },
    {
      name: "the seed creates the three Brands and the bootstrap Caller, and a second run changes nothing",
      async run() {
        // A migrated database of this run's own, and never the one the data
        // checks share: the live host runs them all against one database, and
        // a Brand another check's seed already wrote is a Brand this one
        // cannot count. `empty()` is that database — a seeded database is
        // exactly an empty one this check migrated and seeded itself.
        const database = await fixtures.empty();
        try {
          const records = database.open();
          await records.migrate();
          const bootstrapKey = keyFor("the seed's own key");

          const first = await seedRecords(records, { bootstrapKey });
          const second = await seedRecords(records, { bootstrapKey });

          const seeded = BOOTSTRAP_BRANDS.map((brand) => brand.id);
          deepStrictEqual([...first.brands].sort(), [...seeded].sort());
          deepStrictEqual(second.brands, first.brands);
          strictEqual(first.caller.created, true);
          strictEqual(second.caller.created, false);

          // Counted in the table, not in the report: a report is what the seed
          // believes, and the point of a second run is that it believed wrong.
          const listed = await records.brands.list();
          for (const id of seeded) {
            strictEqual(
              listed.filter((brand) => brand.id === id).length,
              1,
              `${id} is not exactly one row after two seeds`
            );
          }
          // One Caller, not two: the same row answers the key both times.
          const caller = await records.callers.byKey(bootstrapKey);
          ok(
            caller !== null,
            "the bootstrap key finds no Caller after two seeds"
          );
          deepStrictEqual([...caller.brands].sort(), [...seeded].sort());
          // No report the seed prints may carry the key.
          ok(!JSON.stringify([first, second]).includes(bootstrapKey));
        } finally {
          await database.dispose();
        }
      },
    },
    {
      name: "the seed converges: a bootstrap Caller short of a Brand holds it after the next run",
      async run() {
        const records = await open();
        const bootstrapKey = keyFor("the seed converges");
        const [firstBrand, ...rest] = BOOTSTRAP_BRANDS;
        if (firstBrand === undefined) throw new Error("no Brands to seed");

        // The Caller as an older seed would have left it: created when only
        // one Brand was in the checked-in list.
        const before = await records.callers.create({
          name: "bootstrap",
          key: bootstrapKey,
          brands: [firstBrand.id],
        });

        const report = await seedRecords(records, { bootstrapKey });

        strictEqual(report.caller.created, false);
        const after = await records.callers.byKey(bootstrapKey);
        strictEqual(after?.id, before.id);
        for (const brand of rest) {
          ok(
            after?.brands.includes(brand.id),
            `the seed left the bootstrap Caller without ${brand.id}`
          );
        }
        deepStrictEqual(
          [...report.caller.brands].sort(),
          [...BOOTSTRAP_BRANDS.map((brand) => brand.id)].sort()
        );
      },
    },
    {
      name: "the seed refuses to run without a bootstrap key",
      async run() {
        // "No Brand" is only a statement about a database nobody has seeded,
        // and every data check on the live host shares one that something has.
        const database = await fixtures.empty();
        try {
          const records = database.open();
          await records.migrate();

          await rejects(() => seedRecords(records, { bootstrapKey: "" }));
          // And it wrote no Brand on the way to refusing.
          for (const brand of BOOTSTRAP_BRANDS) {
            strictEqual(await records.brands.get(brand.id), null);
          }
        } finally {
          await database.dispose();
        }
      },
    },
    {
      name: "sources.heldBy is false for a Brand that never held the hash, true after hold, false after release, and never answers from files or calls",
      async run() {
        const records = await open();
        const store = memoryStore();
        const holder = brandFor("holds the source");
        const stranger = await calling(records, "never held the source");
        await records.brands.ensure({ id: holder, name: "Holder" });
        const file = await filed(records, store, "held and released");
        // The stranger has a Call on those very bytes and no hold. A Call is
        // itself something a Brand may one day want deleted, so it must never
        // be what a Signed URL is minted on.
        await records.calls.record({
          callerId: stranger.callerId,
          brand: stranger.brand,
          kind: "crop",
          status: "ok",
          startedAt: at(0),
          sourceHash: file.hash,
        });

        const before = await records.sources.heldBy(holder, file.hash);
        await records.sources.hold(holder, file.hash);
        const held = await records.sources.heldBy(holder, file.hash);
        // Idempotent: a Brand that uploads the same photograph twice is one
        // row, and a second hold must not become a second reference the
        // Reference Count would then never reach zero on.
        await records.sources.hold(holder, file.hash);
        await records.sources.release(holder, file.hash);
        const after = await records.sources.heldBy(holder, file.hash);

        strictEqual(before, false);
        strictEqual(held, true);
        strictEqual(after, false);
        // The `files` row stood the whole way through, so an implementation
        // answering from `files` would have said `true` at every step. This is
        // the lookup the gateway makes before minting a Signed URL: whether
        // the bytes exist is not whether this Brand may see them.
        ok(await records.files.get(file.hash));
        // Nor does a Call on those bytes hand them over.
        strictEqual(
          await records.sources.heldBy(stranger.brand, file.hash),
          false
        );
      },
    },
    {
      name: "sources.release of a hold that is not there is not an error",
      async run() {
        const records = await open();
        const store = memoryStore();
        const brand = brandFor("releases what it never held");
        await records.brands.ensure({ id: brand, name: "Never held" });
        const file = await filed(records, store, "released without a hold");

        // The gateway releases on a path it may already have taken. A throw
        // would make "this Brand no longer uses this source" a call nobody
        // could safely repeat, which is the rule `unenrol` and `erase` follow.
        await records.sources.release(brand, file.hash);

        strictEqual(await records.sources.heldBy(brand, file.hash), false);
      },
    },
    {
      name: "sweep removes a File with no Source Hold older than the window, with its Annotation and its bytes, and leaves a held one",
      async run() {
        const store = watching();
        const records = await fixtures.withStore(store);
        const brand = brandFor("holds one of two sources");
        await records.brands.ensure({ id: brand, name: "Holds one" });

        const orphan = await filed(records, store, "swept, held by nobody");
        const held = await filed(records, store, "swept over, still held");
        await records.annotations.put(annotationOf(orphan.hash));
        await records.sources.hold(brand, held.hash);

        const thirtyOneDaysOn = daysFromNow(31);
        const report = await records.sweep(thirtyOneDaysOn);

        // The report says what it swept and what it swept it by, because a
        // cron's answer is the only place the owner ever reads either.
        strictEqual(report.retentionDays, 30);
        strictEqual(report.sweptAt, thirtyOneDaysOn.toISOString());
        ok(swept(report, orphan.hash), "the orphan was not swept");
        ok(report.keys.includes(orphan.key), "the orphan's key was not swept");
        strictEqual(await records.files.get(orphan.hash), null);
        // Every Face Print of every stranger in that photograph went with the
        // File. That is the whole point of the Sweep.
        strictEqual(await records.annotations.get(orphan.hash), null);
        strictEqual(await store.head(orphan.key), null);
        strictEqual(
          store.deletes.filter((key) => key === orphan.key).length,
          1,
          "the orphan's bytes were deleted more than once"
        );

        // One Source Hold from one Brand, and the File stands.
        ok(!swept(report, held.hash), "a held File was swept");
        ok(await records.files.get(held.hash));
        ok(await store.head(held.key));
        strictEqual(await records.sources.heldBy(brand, held.hash), true);
      },
    },
    {
      name: "sweep leaves a File under a Reference Photo, and a File younger than the window",
      async run() {
        const store = watching();
        const records = await fixtures.withStore(store);
        const brand = brandFor("keeps its reference photo through a sweep");
        await records.brands.ensure({ id: brand, name: "Enrolled" });

        const enrolment = await enrolled(records, store, {
          brand,
          label: "enrolled and therefore kept",
        });
        const young = await filed(records, store, "younger than the window");

        // At the moment they were written nothing is thirty days old, so the
        // Sweep of now is the check that a young File is safe.
        const early = await records.sweep();
        ok(!swept(early, young.hash), "a File written just now was swept");
        ok(await records.files.get(young.hash));

        const later = await records.sweep(daysFromNow(31));

        // Thirty-one days on the young one is old and goes; the enrolled one
        // is the same age and stays, because age is not the only condition.
        ok(swept(later, young.hash), "an old orphan was not swept");
        strictEqual(await store.head(young.key), null);
        ok(!swept(later, enrolment.hash), "an enrolled File was swept");
        ok(await records.files.get(enrolment.hash));
        // Both of its keys: the Source Key of the File, and the Person's own.
        ok(await store.head(enrolment.sourceKey));
        ok(await store.head(enrolment.photo.storeKey));
      },
    },
    {
      name: "sweep takes the File of an Output's key and never the bytes",
      async run() {
        const store = watching();
        const records = await fixtures.withStore(store);
        const brand = brandFor("owns an output on a swept key");
        await records.brands.ensure({ id: brand, name: "Output" });

        const label = "swept out from under an output";
        const orphan = await filed(records, store, label);
        await outputOn(records, { brand, storeKey: orphan.key, label });

        const report = await records.sweep(daysFromNow(31));

        // An Output is not a reference to a File: `calls.source_hash` carries
        // no foreign key on purpose, so an old Call can never block the Sweep.
        ok(swept(report, orphan.hash), "the File was not swept");
        // The bytes are another matter. `store.delete` is unconditional
        // (ADR-0010), so records counts the rows naming a key before it calls
        // one, and an Output naming that key is a row.
        ok(!report.keys.includes(orphan.key), "an Output's key was swept");
        deepStrictEqual(
          store.deletes.filter((key) => key === orphan.key),
          []
        );
        ok(await store.head(orphan.key));
      },
    },
    {
      name: "the Retention Window is thirty days by default and is read from configuration",
      async run() {
        const store = watching();
        const byDefault = await fixtures.withStore(store);
        const usual = await filed(byDefault, store, "swept after thirty days");

        const short = await byDefault.sweep(daysFromNow(29));
        const long = await byDefault.sweep(daysFromNow(31));

        strictEqual(short.retentionDays, 30);
        ok(!swept(short, usual.hash), "a File 29 days old was swept");
        ok(swept(long, usual.hash), "a File 31 days old was not swept");

        // The same File age, a different window, a different answer. A window
        // compiled in rather than configured would give the same one twice.
        const configured = await fixtures.withStore(store, 1);
        const early = await filed(configured, store, "swept after one day");

        const none = await configured.sweep();
        const one = await configured.sweep(daysFromNow(2));

        strictEqual(none.retentionDays, 1);
        ok(!swept(none, early.hash), "a File written just now was swept");
        ok(swept(one, early.hash), "a File 2 days old outlived a 1 day window");
      },
    },
  ];
}
